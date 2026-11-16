"""Unit tests for packaging/windows/slassets.py using an in-memory HTTP opener."""
import hashlib
import io
import threading
import urllib.error

import pytest

import slassets
from slruntime import ManifestError

PAYLOAD = bytes(range(256)) * 4096  # 1 MiB
SHA = hashlib.sha256(PAYLOAD).hexdigest()


class FakeResponse(io.BytesIO):
    def __init__(self, data, status, headers):
        super().__init__(data)
        self.status = status
        self.headers = headers

    def getcode(self):
        return self.status


class FakeServer:
    """Serves PAYLOAD, honouring Range unless told not to, and can fail mid-stream."""

    def __init__(self, honour_range=True, fail_after=None, payload=PAYLOAD):
        self.honour_range, self.fail_after, self.payload = honour_range, fail_after, payload
        self.calls, self.ranges = 0, []
        self._lock = threading.Lock()

    def __call__(self, request, timeout=None):
        with self._lock:
            self.calls += 1
        header = request.get_header("Range")
        self.ranges.append(header)
        if header and self.honour_range:
            start = int(header.split("=")[1].rstrip("-"))
            body = self.payload[start:]
            resp = FakeResponse(body, 206, {"Content-Range": f"bytes {start}-{len(self.payload) - 1}/{len(self.payload)}"})
        else:
            body = self.payload
            resp = FakeResponse(body, 200, {"Content-Length": str(len(body))})
        if self.fail_after is not None:
            limit, self.fail_after = self.fail_after, None
            original = resp.read
            sent = [0]

            def read(n=-1):
                if sent[0] >= limit:
                    raise ConnectionResetError("simulated drop")
                chunk = original(min(n, limit - sent[0]))
                sent[0] += len(chunk)
                return chunk

            resp.read = read
        return resp


def spec(sha=SHA, dest="kokoro/model.onnx", size=len(PAYLOAD)):
    return slassets.AssetSpec("model", "https://example.invalid/model.onnx", sha, dest, size, "KOKORO_MODEL_PATH")


def test_download_verifies_and_stamps(tmp_path):
    server = FakeServer()
    path = slassets.ensure_asset(spec(), tmp_path, opener=server, chunk_size=65536)
    assert path.read_bytes() == PAYLOAD
    assert path.with_name(path.name + ".ok").is_file()
    assert not path.with_name(path.name + ".part").exists()
    slassets.ensure_asset(spec(), tmp_path, opener=server)
    assert server.calls == 1, "a stamped, installed asset must not be downloaded again"


def test_hash_mismatch_deletes_partial_and_never_installs(tmp_path):
    with pytest.raises(slassets.AssetIntegrityError):
        slassets.ensure_asset(spec(sha="0" * 64), tmp_path, opener=FakeServer())
    assert not (tmp_path / "kokoro" / "model.onnx").exists()
    assert not (tmp_path / "kokoro" / "model.onnx.part").exists()


def test_interrupted_download_resumes_with_range(tmp_path):
    server = FakeServer(fail_after=300_000)
    with pytest.raises(slassets.AssetDownloadError):
        slassets.ensure_asset(spec(), tmp_path, opener=server, chunk_size=65536)
    part = tmp_path / "kokoro" / "model.onnx.part"
    assert part.stat().st_size == 300_000
    assert not (tmp_path / "kokoro" / "model.onnx").exists()
    path = slassets.ensure_asset(spec(), tmp_path, opener=server, chunk_size=65536)
    assert server.ranges[-1] == "bytes=300000-"
    assert path.read_bytes() == PAYLOAD


def test_server_ignoring_range_restarts_cleanly(tmp_path):
    part = tmp_path / "kokoro" / "model.onnx.part"
    part.parent.mkdir(parents=True)
    part.write_bytes(b"garbage" * 100)
    path = slassets.ensure_asset(spec(), tmp_path, opener=FakeServer(honour_range=False))
    assert path.read_bytes() == PAYLOAD


def test_http_416_discards_part(tmp_path):
    part = tmp_path / "kokoro" / "model.onnx.part"
    part.parent.mkdir(parents=True)
    part.write_bytes(b"x")

    def opener(request, timeout=None):
        raise urllib.error.HTTPError(request.full_url, 416, "Range Not Satisfiable", {}, None)

    with pytest.raises(slassets.AssetDownloadError):
        slassets.ensure_asset(spec(), tmp_path, opener=opener)
    assert not part.exists()


def test_installer_placed_file_is_hashed_once_without_network(tmp_path):
    dest = tmp_path / "kokoro" / "model.onnx"
    dest.parent.mkdir(parents=True)
    dest.write_bytes(PAYLOAD)

    def no_network(*a, **k):
        raise AssertionError("must not download")

    assert slassets.ensure_asset(spec(), tmp_path, opener=no_network) == dest
    assert slassets.is_installed(spec(), tmp_path, verify_unstamped=False)


def test_corrupt_installed_file_is_replaced(tmp_path):
    dest = tmp_path / "kokoro" / "model.onnx"
    dest.parent.mkdir(parents=True)
    dest.write_bytes(b"\0" * len(PAYLOAD))
    slassets.ensure_asset(spec(), tmp_path, opener=FakeServer())
    assert dest.read_bytes() == PAYLOAD


def test_concurrent_callers_download_once(tmp_path):
    server = FakeServer()
    errors = []

    def worker():
        try:
            slassets.ensure_asset(spec(), tmp_path, opener=server, chunk_size=4096)
        except Exception as exc:  # pragma: no cover - reported below
            errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors
    assert server.calls == 1


def test_unpinned_asset_is_refused(tmp_path):
    with pytest.raises(slassets.AssetConfigError):
        slassets.ensure_asset(spec(sha=""), tmp_path, opener=FakeServer())
    assert slassets.ensure_assets([spec(sha="")], tmp_path)["model"].startswith("skipped")


def test_manifest_validation():
    good = {"name": "m", "url": "https://x/m", "sha256": SHA, "dest": "a/b"}
    assert slassets.asset_specs({"assets": [good]})[0].dest == "a/b"
    for bad in ({**good, "dest": "../x"}, {**good, "url": "http://x/m"}, {**good, "sha256": "abc"}):
        with pytest.raises(ManifestError):
            slassets.asset_specs({"assets": [bad]})


def test_export_asset_env_does_not_override(tmp_path):
    env = {"KOKORO_MODEL_PATH": "/user/choice"}
    slassets.export_asset_env([spec()], tmp_path, env)
    assert env["KOKORO_MODEL_PATH"] == "/user/choice"
    env = {}
    slassets.export_asset_env([spec()], tmp_path, env)
    assert env["KOKORO_MODEL_PATH"] == str(tmp_path / "kokoro" / "model.onnx")
