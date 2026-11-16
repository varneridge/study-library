"""Tests for running Study Library natively on Windows: the desktop launcher,
job leases in the API client and run loop, the two jobs.py fixes and the ONNX
speech engine.

Most tests run on any system. Two groups skip themselves elsewhere:
  test_every_tool... to test_the_onnx_model...  need Windows after
      backend/setup-windows.ps1
  test_worker_...  need the local Worker from the existing harness, through
      the worker_url, processor_headers, make_job, age_job, run_maintenance
      and job_row fixtures in conftest.py

Run from backend/:  python -m pytest tests/test_windows_desktop.py -v
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import textwrap
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

# backend.tts is imported from the repository root, study from backend/.
REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

WINDOWS = sys.platform == "win32"
PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
windows_only = pytest.mark.skipif(not WINDOWS, reason="needs Windows after setup-windows.ps1")


# ---------------------------------------------------------------------------
# desktop.py
# ---------------------------------------------------------------------------


def test_load_env_drops_bom_crlf_comments_export_and_quotes(tmp_path):
    from study import desktop

    path = tmp_path / ".env"
    path.write_bytes(
        "\ufeffSTUDY_URL=https://study.example\r\n"
        "# a comment\r\n"
        "\r\n"
        "export PROCESSOR_KEY='abc123'\r\n"
        'OPENAI_API_KEY="sk-a=b"\r\n'
        "  SPACED = value with spaces  \r\n"
        "NOT A SETTING\r\n".encode("utf-8")
    )
    assert desktop.load_env_file(path) == {
        "STUDY_URL": "https://study.example",
        "PROCESSOR_KEY": "abc123",
        "OPENAI_API_KEY": "sk-a=b",
        "SPACED": "value with spaces",
    }
    assert desktop.load_env_file(tmp_path / "missing.env") == {}


def _home(tmp_path: Path, env_text: str = "STUDY_URL=https://from-env\r\n") -> Path:
    home = tmp_path / "home"
    (home / "repo" / "backend").mkdir(parents=True)
    (home / "repo" / "backend" / ".env").write_text(env_text, encoding="utf-8")
    (home / ".venv" / ("Scripts" if os.name == "nt" else "bin")).mkdir(parents=True)
    (home / "tessdata").mkdir()
    (home / "models").mkdir()
    return home


def test_prepare_environment_puts_tools_first_and_sets_variables(tmp_path):
    from study import desktop

    home = _home(tmp_path)
    programs = tmp_path / "Program Files"
    for sub in ("Tesseract-OCR", "gs/gs9.56.1/bin", "gs/gs10.04.0/bin", "LibreOffice/program"):
        (programs / sub).mkdir(parents=True)
    links = tmp_path / "local" / "Microsoft" / "WinGet" / "Links"
    links.mkdir(parents=True)
    # Upper case, as os.environ holds names on Windows.
    base = {"PATH": "inherited", "PROGRAMFILES": str(programs), "LOCALAPPDATA": str(tmp_path / "local"),
            "STUDY_URL": "https://from-base", "PYTHONPATH": "earlier"}

    env = desktop.prepare_environment(home, base)

    parts = env["PATH"].split(os.pathsep)
    expected = [home / ".venv" / ("Scripts" if os.name == "nt" else "bin"), programs / "Tesseract-OCR",
                programs / "gs" / "gs10.04.0" / "bin", programs / "LibreOffice" / "program", links]
    assert [Path(p) for p in parts[:5]] == expected
    assert parts[5:] == ["inherited"]
    assert env["STUDY_URL"] == "https://from-env", "the .env must win, as `set -a; . ./.env` does"
    assert env["TESSDATA_PREFIX"] == str(home / "tessdata")
    assert env["PYTHONUTF8"] == "1"
    assert env["PYTHONPATH"].split(os.pathsep) == [str(home / "repo"), str(home / "repo" / "backend"), "earlier"]
    assert env["STUDY_MODELS_DIR"] == str(home / "models")
    assert base["PATH"] == "inherited", "the caller's mapping is left alone"


def test_prepare_environment_skips_folders_that_do_not_exist(tmp_path):
    from study import desktop

    home = _home(tmp_path)
    base = {"PATH": "only", "ProgramFiles": str(tmp_path / "empty"), "LOCALAPPDATA": str(tmp_path / "none")}
    parts = desktop.prepare_environment(home, base)["PATH"].split(os.pathsep)
    assert parts == [str(home / ".venv" / ("Scripts" if os.name == "nt" else "bin")), "only"]


def _git(cwd: Path, *args: str) -> str:
    env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}
    return subprocess.run(["git", *args], cwd=cwd, env=env, check=True, capture_output=True, text=True).stdout.strip()


@pytest.fixture
def checkout(tmp_path):
    """An origin with a production branch, a clone to push from, and home/repo at production."""
    if shutil.which("git") is None:
        pytest.skip("git is not installed")
    origin, seed = tmp_path / "origin.git", tmp_path / "seed"
    _git(tmp_path, "init", "--bare", str(origin))
    seed.mkdir()
    _git(seed, "init")
    _git(seed, "checkout", "-b", "production")
    (seed / "backend").mkdir()
    (seed / "backend" / "requirements.txt").write_text("requests==2.*\n")
    (seed / "README.md").write_text("one\n")
    _git(seed, "add", ".")
    _git(seed, "commit", "-m", "one")
    _git(seed, "remote", "add", "origin", str(origin))
    _git(seed, "push", "origin", "production")
    home = tmp_path / "home"
    home.mkdir()
    _git(tmp_path, "clone", "-b", "production", str(origin), str(home / "repo"))
    return home, seed, origin


def _safe_rmtree(p):
    import stat
    for root, dirs, files in os.walk(p):
        for d in dirs:
            try: os.chmod(os.path.join(root, d), stat.S_IWRITE)
            except Exception: pass
        for f in files:
            try: os.chmod(os.path.join(root, f), stat.S_IWRITE)
            except Exception: pass
    shutil.rmtree(p, ignore_errors=True)


def test_update_follows_production_and_ignores_main(checkout):
    from study import desktop

    home, seed, _ = checkout
    assert desktop.update_checkout(home) is False

    _git(seed, "checkout", "-b", "main")
    (seed / "README.md").write_text("work in progress\n")
    _git(seed, "commit", "-am", "wip")
    _git(seed, "push", "origin", "main")
    before = _git(home / "repo", "rev-parse", "HEAD")
    assert desktop.update_checkout(home) is False, "work on main has not been deployed"
    assert _git(home / "repo", "rev-parse", "HEAD") == before

    _git(seed, "checkout", "production")
    (seed / "README.md").write_text("two\n")
    _git(seed, "commit", "-am", "two")
    _git(seed, "push", "origin", "production")
    assert desktop.update_checkout(home) is True
    assert _git(home / "repo", "rev-parse", "HEAD") == _git(seed, "rev-parse", "HEAD")


def test_update_rolls_back_when_requirements_do_not_install(checkout, monkeypatch, tmp_path):
    from study import desktop

    home, seed, _ = checkout
    missing = tmp_path / "no-such-python"
    monkeypatch.setattr(desktop, "_python", lambda *_a, **_k: str(missing))
    before = _git(home / "repo", "rev-parse", "HEAD")
    (seed / "backend" / "requirements.txt").write_text("requests==2.*\nnew-package==1.0\n")
    _git(seed, "commit", "-am", "needs a new package")
    _git(seed, "push", "origin", "production")
    assert desktop.update_checkout(home) is False
    assert _git(home / "repo", "rev-parse", "HEAD") == before


def test_update_never_raises_offline_or_without_a_checkout(checkout):
    from study import desktop

    home, _, origin = checkout
    _safe_rmtree(origin)
    assert desktop.update_checkout(home) is False
    assert desktop.update_checkout(home.parent / "nowhere") is False


def test_update_available_sees_only_new_production_commits(checkout):
    from study import desktop

    home, seed, origin = checkout
    assert desktop.update_available(home) is False
    _git(seed, "checkout", "-b", "main")
    (seed / "README.md").write_text("wip\n")
    _git(seed, "commit", "-am", "wip")
    _git(seed, "push", "origin", "main")
    assert desktop.update_available(home) is False
    _git(seed, "checkout", "production")
    (seed / "README.md").write_text("two\n")
    _git(seed, "commit", "-am", "two")
    _git(seed, "push", "origin", "production")
    before = _git(home / "repo", "rev-parse", "HEAD")
    assert desktop.update_available(home) is True
    assert _git(home / "repo", "rev-parse", "HEAD") == before, "checking must not change the code"
    _safe_rmtree(origin)
    assert desktop.update_available(home) is False


def test_children_stop_before_an_update_installs(monkeypatch, tmp_path):
    """On Windows pip cannot replace numpy, onnxruntime or PyMuPDF while the
    processor or speech server has them loaded, so they must stop first."""
    from study import desktop

    order = []
    monkeypatch.setattr(desktop, "update_available", lambda home: True)
    monkeypatch.setattr(desktop, "_stop_children", lambda home, children: order.append("stop"))
    monkeypatch.setattr(desktop, "update_checkout", lambda home: order.append("install") or True)
    assert desktop._apply_update(tmp_path, {}) is True
    assert order == ["stop", "install"]

    order.clear()
    monkeypatch.setattr(desktop, "update_available", lambda home: False)
    assert desktop._apply_update(tmp_path, {}) is False
    assert order == [], "nothing is stopped when there is nothing to install"


def test_only_one_process_holds_the_single_instance_lock(tmp_path):
    from study import desktop

    name = f"Local\\StudyLibraryTest{os.getpid()}"
    backend = Path(desktop.__file__).resolve().parents[1]
    holder = subprocess.Popen(
        [sys.executable, "-c", textwrap.dedent(f"""
            import sys, time
            sys.path.insert(0, {str(backend)!r})
            from study import desktop
            held = desktop.acquire_single_instance({name!r}, 1)
            print("held" if held else "none", flush=True)
            time.sleep(3)
        """)],
        stdout=subprocess.PIPE, text=True)
    try:
        assert holder.stdout.readline().strip() == "held"
        assert desktop.acquire_single_instance(name, 0.5) is None
        second = desktop.acquire_single_instance(name, 15)
        assert second is not None, "the lock must pass on once its holder exits"
        second.close()
    finally:
        holder.kill()
        holder.wait()


def test_spawn_worker_starts_both_children_windowless_with_their_own_logs(tmp_path, monkeypatch):
    from study import desktop

    home = _home(tmp_path)
    started = []

    class FakePopen:
        def __init__(self, args, **kwargs):
            started.append((list(args), kwargs))

    monkeypatch.setattr(desktop.subprocess, "Popen", FakePopen)
    desktop.spawn_worker(home, {"PATH": "x"})

    assert [args[1:] for args, _ in started] == [
        ["-m", "study.processor"],
        ["-m", "uvicorn", "backend.tts.server:app", "--host", "127.0.0.1", "--port", "8765"],
    ]
    for args, kwargs in started:
        assert Path(kwargs["cwd"]) == home / "repo" / "backend"
        assert kwargs["env"]["PROCESSOR_STOP_FILE"] == str(home / "processor.stop")
        assert kwargs["stderr"] == subprocess.STDOUT
        if WINDOWS:
            assert args[0].lower().endswith("python.exe"), "python.exe, so the children share a hidden console"
            assert kwargs["creationflags"] & desktop.CREATE_NO_WINDOW
    assert (home / "logs" / "processor.log").exists() and (home / "logs" / "tts.log").exists()


def test_spawn_worker_sets_aside_a_log_over_the_limit(tmp_path, monkeypatch):
    from study import desktop

    home = _home(tmp_path)
    (home / "logs").mkdir()
    (home / "logs" / "processor.log").write_bytes(b"x" * (desktop.LOG_LIMIT + 1))
    monkeypatch.setattr(desktop.subprocess, "Popen", lambda *a, **k: None)
    desktop.spawn_worker(home, {})
    assert (home / "logs" / "processor.log.1").stat().st_size == desktop.LOG_LIMIT + 1
    assert (home / "logs" / "processor.log").stat().st_size == 0


@pytest.fixture
def launcher(tmp_path, monkeypatch):
    from study import desktop

    home = _home(tmp_path, "STUDY_URL=https://study.example\n")
    monkeypatch.setenv("STUDY_HOME", str(home))
    calls = []
    monkeypatch.setattr(desktop, "_spawn_supervisor", lambda h, handover: calls.append(("supervisor", handover)))
    monkeypatch.setattr(desktop, "open_window", lambda url: calls.append(("window", url)))
    monkeypatch.setattr(desktop, "supervise", lambda h: calls.append(("supervise", Path(h))) or 0)
    return desktop, home, calls


def test_main_starts_the_supervisor_and_opens_the_window(launcher):
    desktop, _home_dir, calls = launcher
    assert desktop.main([]) == 0
    assert calls == [("supervisor", False), ("window", "https://study.example")]


def test_main_headless_supervises_and_app_only_just_opens(launcher):
    desktop, home, calls = launcher
    assert desktop.main(["--headless"]) == 0
    assert desktop.main(["--app-only"]) == 0
    assert calls == [("supervise", home), ("window", "https://study.example")]


def test_main_without_study_url_fails(launcher, monkeypatch):
    desktop, home, calls = launcher
    (home / "repo" / "backend" / ".env").write_text("PROCESSOR_KEY=x\n")
    monkeypatch.delenv("STUDY_URL", raising=False)
    assert desktop.main(["--app-only"]) == 1
    assert calls == []


def test_open_window_uses_edge_app_mode_or_the_default_browser(monkeypatch):
    from study import desktop

    opened = []
    monkeypatch.setattr(desktop.webbrowser, "open", lambda url: opened.append(("browser", url)))
    monkeypatch.setattr(desktop.subprocess, "Popen", lambda args, **_k: opened.append(("edge", args)))
    monkeypatch.setattr(desktop, "_edge", lambda: r"C:\Edge\msedge.exe")
    desktop.open_window("https://study.example")
    if WINDOWS:
        assert opened == [("edge", [r"C:\Edge\msedge.exe", "--app=https://study.example"])]
        opened.clear()
        monkeypatch.setattr(desktop, "_edge", lambda: None)
        desktop.open_window("https://study.example")
    assert opened == [("browser", "https://study.example")]


# ---------------------------------------------------------------------------
# jobs.py
# ---------------------------------------------------------------------------


class FakeFileApi:
    def __init__(self, mime: str, r2_key: str):
        self.record = {"id": "f1", "deleted": False, "mime": mime, "r2_key": r2_key,
                       "original_name": "Lecture.pptx", "thumb_key": None}
        self.calls: list[tuple] = []

    def file(self, file_id):
        return dict(self.record)

    def download(self, key, path):
        Path(path).write_bytes(b"%PDF-1.4 input\n")

    def put_object(self, path, key, mime):
        self.calls.append(("put_object", key))

    def converted(self, file_id, digest, key, size, name):
        self.calls.append(("converted", key))
        return "f1:pdf"

    def replaced(self, file_id, key, size, priority):
        self.calls.append(("replaced", key))

    def delete_unreferenced(self, key):
        self.calls.append(("delete_unreferenced", key))


def test_libreoffice_profile_is_a_file_url_even_in_a_folder_with_a_space(tmp_path, monkeypatch):
    from study.processor import jobs

    spaced = tmp_path / "Sam Leigh"
    spaced.mkdir()
    monkeypatch.setattr(jobs.tempfile, "tempdir", str(spaced))
    seen = {}

    def fake_run(args, **_kwargs):
        seen["args"] = list(args)
        Path(args[args.index("--outdir") + 1], "source.pdf").write_bytes(b"%PDF-1.4 converted\n")
        return subprocess.CompletedProcess(args, 0, "", "")

    monkeypatch.setattr(jobs.subprocess, "run", fake_run)
    jobs.convert(jobs.Context(api=FakeFileApi(PPTX, "files/abc.pptx")), {"payload": {"file_id": "f1"}})

    args = seen["args"]
    profile = Path(args[args.index("--outdir") + 1]) / "profile"
    url = next(a for a in args if a.startswith("-env:UserInstallation=")).split("=", 1)[1]
    assert url == profile.as_uri()
    assert url.startswith("file:///") and " " not in url


def test_ocr_output_is_named_by_its_own_hash(monkeypatch):
    from study.processor import jobs

    produced = b"%PDF-1.7 the OCR output\n"
    monkeypatch.setattr(jobs, "ocr_languages", lambda *_a, **_k: "eng")
    monkeypatch.setattr(jobs, "split_spreads", lambda *_a, **_k: 0)

    def fake_run(args, **_kwargs):
        Path(args[-1]).write_bytes(produced)
        return subprocess.CompletedProcess(args, 0, "", "")

    monkeypatch.setattr(jobs.subprocess, "run", fake_run)
    api = FakeFileApi("application/pdf", "files/0123abcd.pdf")
    jobs.ocr(jobs.Context(api=api), {"payload": {"file_id": "f1"}, "priority": None})

    key = f"files/{hashlib.sha256(produced).hexdigest()}.ocr.pdf"
    assert ("put_object", key) in api.calls and ("replaced", key) in api.calls
    assert ("delete_unreferenced", "files/0123abcd.pdf") in api.calls


def test_a_failed_ocr_save_removes_the_object_it_stored(monkeypatch):
    from study.processor import jobs

    produced = b"%PDF-1.7 output of this run\n"
    monkeypatch.setattr(jobs, "ocr_languages", lambda *_a, **_k: "eng")
    monkeypatch.setattr(jobs, "split_spreads", lambda *_a, **_k: 0)

    def fake_run(args, **_kwargs):
        Path(args[-1]).write_bytes(produced)
        return subprocess.CompletedProcess(args, 0, "", "")

    class SaveFails(FakeFileApi):
        def replaced(self, file_id, key, size, priority):
            raise ConnectionError("the Worker did not answer")

    monkeypatch.setattr(jobs.subprocess, "run", fake_run)
    api = SaveFails("application/pdf", "files/0123abcd.pdf")
    with pytest.raises(ConnectionError):
        jobs.ocr(jobs.Context(api=api), {"payload": {"file_id": "f1"}, "priority": None})
    key = f"files/{hashlib.sha256(produced).hexdigest()}.ocr.pdf"
    assert ("delete_unreferenced", key) in api.calls, "the retry gets a new name, so this object would be orphaned"
    assert ("delete_unreferenced", "files/0123abcd.pdf") not in api.calls, "the scan itself must stay"


# ---------------------------------------------------------------------------
# api.py, against a small local server
# ---------------------------------------------------------------------------


class StubWorker:
    """Answers each (method, path) from a table and records the lease header it saw."""

    def __init__(self):
        self.routes: dict[tuple[str, str], tuple[int, dict | bytes]] = {}
        self.seen: list[tuple[str, str, str | None]] = []
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def _answer(self):
                length = int(self.headers.get("Content-Length") or 0)
                if length:
                    self.rfile.read(length)
                path = self.path.split("?")[0]
                stub.seen.append((self.command, path, self.headers.get("X-Lease-Id")))
                status, body = stub.routes.get((self.command, path), (404, {"error": "not found"}))
                data = body if isinstance(body, bytes) else json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/octet-stream" if isinstance(body, bytes) else "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = do_PUT = do_DELETE = _answer

            def log_message(self, *_args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def lease_on(self, method: str, path: str) -> str | None:
        return next(lease for m, p, lease in reversed(self.seen) if (m, p) == (method, path))


@pytest.fixture
def stub():
    worker = StubWorker()
    yield worker
    worker.server.shutdown()


def _claimable(stub):
    stub.routes[("POST", "/api/processor/claim")] = (200, {"job": {"id": 7, "type": "extract_text", "payload": {"file_id": "f1"}, "lease_id": "lease-7"}})
    stub.routes[("GET", "/api/processor/files/f1")] = (200, {"file": {"id": "f1"}})
    stub.routes[("POST", "/api/processor/jobs/7/heartbeat")] = (200, {"running": True})
    stub.routes[("GET", "/api/processor/objects/files/piece.txt")] = (200, b"kept text")
    stub.routes[("POST", "/api/processor/jobs/7/complete")] = (200, {"ok": True})


def test_claim_remembers_the_lease_and_every_request_carries_it(stub):
    from study.api import Api

    _claimable(stub)
    api = Api(stub.url)
    job = api.claim()
    assert job["id"] == 7 and api.current_lease_id == "lease-7"
    assert stub.lease_on("POST", "/api/processor/claim") is None
    assert api.file("f1") == {"id": "f1"}
    assert api.heartbeat(7) is True
    assert api.read_text("files/piece.txt") == "kept text"
    api.complete(7)
    for method, path in (("GET", "/api/processor/files/f1"), ("POST", "/api/processor/jobs/7/heartbeat"),
                         ("GET", "/api/processor/objects/files/piece.txt"), ("POST", "/api/processor/jobs/7/complete")):
        assert stub.lease_on(method, path) == "lease-7", path

    api.end_lease()
    assert api.current_lease_id is None
    api.file("f1")
    assert stub.lease_on("GET", "/api/processor/files/f1") is None


def test_claim_with_nothing_waiting_holds_no_lease(stub):
    from study.api import Api

    stub.routes[("POST", "/api/processor/claim")] = (200, {"job": None})
    api = Api(stub.url)
    api.current_lease_id = "left-over"
    assert api.claim() is None
    assert api.current_lease_id is None


def test_lease_lost_is_raised_only_for_lease_lost(stub):
    from study.api import Api, ApiError, LeaseLost

    stub.routes[("POST", "/api/processor/jobs/7/complete")] = (409, {"error": "lease_lost"})
    stub.routes[("POST", "/api/processor/recordings/r1/audio")] = (409, {"error": "recording is still live"})
    api = Api(stub.url)
    with pytest.raises(LeaseLost) as lost:
        api.complete(7)
    assert isinstance(lost.value, ApiError) and lost.value.status == 409
    with pytest.raises(ApiError) as other:
        api.recording_audio("r1", "files/a.ogg", 1, 1.0, "audio/ogg", False)
    assert not isinstance(other.value, LeaseLost) and other.value.status == 409


def test_missing_file_and_missing_text_are_still_none(stub):
    from study.api import Api

    api = Api(stub.url)
    assert api.file("gone") is None
    assert api.read_text("files/none.txt") is None


def test_heartbeat_reports_false_when_the_job_has_moved_on(stub):
    from study.api import Api

    stub.routes[("POST", "/api/processor/jobs/7/heartbeat")] = (409, {"error": "lease_lost"})
    api = Api(stub.url)
    api.current_lease_id = "old"
    assert api.heartbeat(7) is False


# ---------------------------------------------------------------------------
# the run loop
# ---------------------------------------------------------------------------


class FakeLeaseApi:
    def __init__(self, job=None):
        self.job = job
        self.calls: list[tuple] = []
        self.complete_error = None
        self.fail_error = None

    def claim(self):
        self.calls.append(("claim",))
        job, self.job = self.job, None
        return job

    def heartbeat(self, job_id):
        return True

    def complete(self, job_id):
        self.calls.append(("complete", job_id))
        if self.complete_error:
            raise self.complete_error

    def fail(self, job_id, message):
        self.calls.append(("fail", job_id))
        if self.fail_error:
            raise self.fail_error
        return True

    def file_failed(self, file_id):
        self.calls.append(("file_failed", file_id))

    def recording_status(self, recording_id, status):
        self.calls.append(("recording_status", recording_id, status))

    def end_lease(self):
        self.calls.append(("end_lease",))

    def names(self):
        return [call[0] for call in self.calls]


def _job():
    return {"id": 5, "type": "extract_text", "payload": {"file_id": "f1"}, "lease_id": "lease-5"}


def test_adaptive_ocr_jobs_respects_env_and_bounds(monkeypatch):
    from study.processor.__main__ import adaptive_ocr_jobs

    monkeypatch.setenv("OCR_JOBS", "4")
    assert adaptive_ocr_jobs() == 4
    monkeypatch.setenv("OCR_JOBS", "0")
    assert adaptive_ocr_jobs() == 1  # max(1, ...) prevents zero jobs

    monkeypatch.delenv("OCR_JOBS", raising=False)
    jobs = adaptive_ocr_jobs()
    assert 1 <= jobs <= 6


def test_lease_lost_at_completion_is_logged_not_raised(monkeypatch):
    from study.api import LeaseLost
    from study.processor import jobs
    from study.processor.__main__ import Processor

    monkeypatch.setitem(jobs.HANDLERS, "extract_text", lambda ctx, job: None)
    api = FakeLeaseApi(_job())
    api.complete_error = LeaseLost("lease lost", 409)
    assert Processor(api).run_once() is True
    assert api.names()[-1] == "end_lease"


def test_lease_lost_inside_a_job_reports_no_failure(monkeypatch):
    from study.api import LeaseLost
    from study.processor import jobs
    from study.processor.__main__ import Processor

    def refused(ctx, job):
        raise LeaseLost("lease lost", 409)

    monkeypatch.setitem(jobs.HANDLERS, "extract_text", refused)
    api = FakeLeaseApi(_job())
    assert Processor(api).run_once() is True
    assert api.names() == ["claim", "end_lease"]


def test_lease_lost_while_reporting_a_failure_skips_the_file_status(monkeypatch):
    from study.api import LeaseLost
    from study.processor import jobs
    from study.processor.__main__ import Processor

    def broken(ctx, job):
        raise RuntimeError("tesseract crashed")

    monkeypatch.setitem(jobs.HANDLERS, "extract_text", broken)
    api = FakeLeaseApi(_job())
    api.fail_error = LeaseLost("lease lost", 409)
    assert Processor(api).run_once() is True
    assert "file_failed" not in api.names() and api.names()[-1] == "end_lease"


def test_an_ordinary_failure_is_still_reported(monkeypatch):
    from study.processor import jobs
    from study.processor.__main__ import Processor

    def broken(ctx, job):
        raise RuntimeError("tesseract crashed")

    monkeypatch.setitem(jobs.HANDLERS, "extract_text", broken)
    api = FakeLeaseApi(_job())
    assert Processor(api).run_once() is True
    assert api.names() == ["claim", "fail", "end_lease", "file_failed", "end_lease"]


class LeasingWorker:
    """A stand-in for the Worker's lease rules: one job whose lease admits
    writes only while it runs; a final failure ends it."""

    def __init__(self, job_type="extract_text"):
        self.state = {"status": "queued", "lease": None}
        self.file_failed_ok = False
        self.job_type = job_type
        worker = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                if length:
                    self.rfile.read(length)
                lease = self.headers.get("X-Lease-Id")
                state = worker.state
                status, body = 404, {"error": "not found"}
                if self.path == "/api/processor/claim":
                    if state["status"] == "queued":
                        state.update(status="running", lease="L1")
                        body = {"job": {"id": 1, "type": worker.job_type, "payload": {"file_id": "f1"},
                                        "attempts": 5, "lease_id": "L1"}}
                    else:
                        body = {"job": None}
                    status = 200
                elif lease and not (state["status"] == "running" and state["lease"] == lease):
                    status, body = 409, {"error": "lease_lost"}
                elif self.path == "/api/processor/jobs/1/fail":
                    state.update(status="failed", lease=None)
                    status, body = 200, {"final": True}
                elif self.path == "/api/processor/files/f1/failed":
                    worker.file_failed_ok = True
                    status, body = 200, {"ok": True}
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *_args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()


def test_a_final_failure_still_marks_the_file_failed(monkeypatch):
    """After the last attempt the Worker ends the job and its lease, so the
    file must be marked failed without that lease, or it shows "Adding text"
    for ever instead of offering Retry."""
    from study.api import Api
    from study.processor import jobs
    from study.processor.__main__ import Processor

    def broken(ctx, job):
        raise RuntimeError("tesseract crashed")

    monkeypatch.setitem(jobs.HANDLERS, "extract_text", broken)
    worker = LeasingWorker()
    try:
        assert Processor(Api(worker.url)).run_once() is True
        assert worker.state["status"] == "failed"
        assert worker.file_failed_ok, "the file was never marked failed"
    finally:
        worker.server.shutdown()


def test_the_stop_file_ends_the_loop_and_is_removed(tmp_path, monkeypatch):
    from study.processor.__main__ import Processor

    stop = tmp_path / "processor.stop"
    stop.touch()
    monkeypatch.setenv("PROCESSOR_STOP_FILE", str(stop))
    # run() would otherwise take over Ctrl+C for the rest of the test session.
    monkeypatch.setattr("signal.signal", lambda *_a: None)
    processor = Processor(FakeLeaseApi())
    started = time.monotonic()
    processor.run()
    assert time.monotonic() - started < 5
    assert not stop.exists()


def test_stop_wakes_an_idle_loop_at_once(monkeypatch):
    from study.processor.__main__ import Processor

    monkeypatch.delenv("PROCESSOR_STOP_FILE", raising=False)
    processor = Processor(FakeLeaseApi())
    thread = threading.Thread(target=processor.run)
    thread.start()
    time.sleep(0.3)
    processor.stop()
    thread.join(3)
    assert not thread.is_alive(), "an idle wait must end when the processor is stopped"


# ---------------------------------------------------------------------------
# tts/server.py
# ---------------------------------------------------------------------------


def _server():
    pytest.importorskip("fastapi")
    from backend.tts import server

    return server


class FakeKokoro:
    """Stands in for kokoro_onnx.Kokoro: a second of tone between short silences."""

    def __init__(self):
        self.calls = []

    def create(self, text, voice, speed, lang):
        import numpy as np

        self.calls.append((text, voice, speed, lang))
        rate = 24_000
        tone = (0.5 * np.sin(np.linspace(0, 400, rate))).astype(np.float32)
        silence = np.zeros(rate // 10, dtype=np.float32)
        return np.concatenate([silence, tone, silence]), rate


def test_estimated_word_times_are_in_order_and_inside_the_speech():
    server = _server()
    import numpy as np

    audio = np.concatenate([np.zeros(2400), np.full(24000, 0.5), np.zeros(2400)]).astype(np.float32)
    tokens = server.estimate_tokens("Napoleon, at last, signed the Concordat.", audio, 10.0)
    assert [t["text"] for t in tokens] == ["Napoleon", "at", "last", "signed", "the", "Concordat"]
    starts = [t["start"] for t in tokens]
    assert starts == sorted(starts)
    assert tokens[0]["start"] == pytest.approx(10.1, abs=0.01)
    assert tokens[-1]["end"] == pytest.approx(11.1, abs=0.01)
    assert all(t["end"] > t["start"] for t in tokens)
    assert tokens[1]["start"] - tokens[0]["end"] > 0, "a comma leaves a pause"


def test_onnx_engine_speaks_each_sentence_and_keeps_british_voices_british():
    server = _server()

    fake = FakeKokoro()
    engine = server.OnnxEngine(kokoro_factory=lambda: fake)
    pcm, tokens = engine.synthesise("The war began. It ended in 1815!", "bf_emma")
    assert [c[0] for c in fake.calls] == ["The war began.", "It ended in 1815!"]
    assert {c[3] for c in fake.calls} == {"en-gb"} and {c[2] for c in fake.calls} == {1.0}
    assert pcm.size == 2 * (24_000 + 2 * 2_400)
    assert [t["text"] for t in tokens] == ["The", "war", "began", "It", "ended", "in", "1815"]
    assert tokens[3]["start"] >= (24_000 + 2 * 2_400) / 24_000, "the second sentence starts after the first"
    server.OnnxEngine(kokoro_factory=lambda: fake).synthesise("Hello.", "af_heart")
    assert fake.calls[-1][3] == "en-us"


def test_onnx_frame_keeps_the_wire_format():
    server = _server()
    pytest.importorskip("httpx")
    from fastapi.testclient import TestClient

    client = TestClient(server.create_app(engine=server.OnnxEngine(kokoro_factory=FakeKokoro), token=None))
    response = client.post("/tts/v1/synthesise", json={"text": "Vive la France.", "voice": "bf_emma"})
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/x-kokoro-utterance"
    header, pcm = server.decode_frame(response.content)
    assert set(header) == {"sampleRate", "samples", "voice", "modelVersion", "tokens"}
    assert header["sampleRate"] == 24_000 and header["samples"] == pcm.size
    assert header["modelVersion"] == server.ONNX_MODEL_VERSION
    assert [t["text"] for t in header["tokens"]] == ["Vive", "la", "France"]
    assert client.get("/tts/v1/health").json()["modelVersion"] == server.ONNX_MODEL_VERSION


def test_default_engine_follows_tts_engine(monkeypatch, tmp_path):
    server = _server()

    monkeypatch.setenv("TTS_ENGINE", "onnx")
    assert isinstance(server.default_engine(), server.OnnxEngine)
    monkeypatch.setenv("TTS_ENGINE", "torch")
    assert isinstance(server.default_engine(), server.KokoroEngine)
    monkeypatch.delenv("TTS_ENGINE")
    monkeypatch.setenv("STUDY_MODELS_DIR", str(tmp_path))
    assert isinstance(server.default_engine(), server.KokoroEngine), "no model files, so the PyTorch engine"


# ---------------------------------------------------------------------------
# windows: a machine after setup-windows.ps1
# ---------------------------------------------------------------------------


def _prepared():
    from study import desktop

    return desktop.prepare_environment(desktop.default_home())


@windows_only
def test_every_tool_is_on_the_prepared_path():
    path = _prepared()["PATH"]
    for exe in ("tesseract", "gswin64c", "ffmpeg", "ffprobe", "soffice", "ocrmypdf"):
        assert shutil.which(exe, path=path), f"{exe} is not on the prepared PATH"


@windows_only
def test_tesseract_reads_all_four_languages():
    env = _prepared()
    listed = subprocess.run([shutil.which("tesseract", path=env["PATH"]), "--list-langs"],
                            capture_output=True, text=True, env=env).stdout
    assert {"eng", "fra", "deu", "osd"} <= {line.strip() for line in listed.splitlines()[1:]}


@windows_only
def test_ffmpeg_has_the_encoders_the_jobs_use():
    env = _prepared()
    encoders = subprocess.run([shutil.which("ffmpeg", path=env["PATH"]), "-hide_banner", "-encoders"],
                              capture_output=True, text=True, env=env).stdout
    assert "libopus" in encoders and "libmp3lame" in encoders


@windows_only
def test_ocr_reads_an_image_only_page(tmp_path):
    import pymupdf

    from study.processor import jobs

    page = pymupdf.open().new_page(width=595, height=842)
    page.insert_text((72, 200), "The Concordat of 1801", fontsize=28)
    scan = pymupdf.open()
    scan.new_page(width=595, height=842).insert_image(pymupdf.Rect(0, 0, 595, 842),
                                                       stream=page.get_pixmap(dpi=200).tobytes("png"))
    source, output = tmp_path / "scan.pdf", tmp_path / "out.pdf"
    scan.save(source)
    env = _prepared()
    command = jobs.ocr_command(str(source), str(output), 1, "skip", "eng")
    command[0] = shutil.which(command[0], path=env["PATH"])
    result = subprocess.run(command, capture_output=True, text=True, env=env, timeout=600)
    assert result.returncode == 0, result.stderr[-2000:]
    assert "Concordat" in pymupdf.open(output)[0].get_text()


@windows_only
def test_the_onnx_model_speaks_with_word_times():
    env = _prepared()
    code = textwrap.dedent("""
        import json, sys
        from backend.tts import server
        engine = server.default_engine()
        pcm, tokens = engine.synthesise("The Concordat was signed in 1801.", "bf_emma")
        print(json.dumps({"engine": type(engine).__name__, "samples": int(pcm.size), "words": len(tokens),
                          "torch": "torch" in sys.modules}))
    """)
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=env, timeout=600)
    assert result.returncode == 0, result.stderr[-2000:]
    report = json.loads(result.stdout.strip().splitlines()[-1])
    assert report == {**report, "engine": "OnnxEngine", "words": 6, "torch": False}
    assert report["samples"] > 24_000


# ---------------------------------------------------------------------------
# worker: the lease contract against the local Worker
# ---------------------------------------------------------------------------

WORKER_FIXTURES = ("worker_url", "processor_headers", "make_job", "age_job", "run_maintenance", "job_row")


@pytest.fixture
def worker(request):
    from _pytest.fixtures import FixtureLookupError

    try:
        return {name: request.getfixturevalue(name) for name in WORKER_FIXTURES}
    except FixtureLookupError:
        pytest.skip("the local Worker fixtures are not in conftest.py")


def _claim(w):
    import requests

    return requests.post(f"{w['worker_url']}/api/processor/claim", headers=w["processor_headers"], timeout=30).json()["job"]


def _post(w, path, lease, body=None):
    import requests

    return requests.post(f"{w['worker_url']}/api/processor{path}", json=body or {},
                         headers={**w["processor_headers"], "X-Lease-Id": lease}, timeout=30)


def test_worker_claim_returns_a_fresh_lease(worker):
    worker["make_job"]("extract_text")
    worker["make_job"]("extract_text")
    first, second = _claim(worker), _claim(worker)
    assert first["lease_id"] and second["lease_id"] and first["lease_id"] != second["lease_id"]


def test_worker_refuses_the_old_lease_after_a_requeue(worker):
    job_id = worker["make_job"]("extract_text")
    first = _claim(worker)
    worker["age_job"](job_id, 61)
    worker["run_maintenance"]()
    for path in (f"/jobs/{job_id}/heartbeat", f"/jobs/{job_id}/complete", f"/files/{first['payload']['file_id']}/text"):
        response = _post(worker, path, first["lease_id"], {"page_count": 1, "pages": []})
        assert response.status_code == 409 and response.json() == {"error": "lease_lost"}, path
    second = _claim(worker)
    assert second["id"] == job_id and second["lease_id"] != first["lease_id"]
    assert _post(worker, f"/jobs/{job_id}/complete", second["lease_id"]).status_code == 200


def test_worker_never_gives_one_job_to_two_machines(worker):
    import requests

    created = {worker["make_job"]("extract_text") for _ in range(20)}

    def drain(_n):
        got = []
        while (job := requests.post(f"{worker['worker_url']}/api/processor/claim",
                                    headers=worker["processor_headers"], timeout=30).json()["job"]):
            got.append(job["id"])
        return got

    with ThreadPoolExecutor(max_workers=8) as pool:
        claimed = [j for batch in pool.map(drain, range(8)) for j in batch]
    assert len(claimed) == len(set(claimed)) and set(claimed) == created


def test_worker_fails_a_job_that_keeps_stopping_its_processor(worker):
    job_id = worker["make_job"]("extract_text")
    for _ in range(5):
        assert _claim(worker)["id"] == job_id
        worker["age_job"](job_id, 61)
        worker["run_maintenance"]()
    assert worker["job_row"](job_id)["status"] == "failed"
    assert _claim(worker) is None
