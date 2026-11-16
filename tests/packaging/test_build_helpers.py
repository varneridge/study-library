"""Tests for packaging/windows/build_helpers.py."""
import hashlib
import io
import zipfile

import pytest

import build_helpers as bh
import slruntime as rt


def _opener(data):
    def opener(request, timeout=None):
        return io.BytesIO(data)
    return opener


def test_download_verified_pins_only_when_asked(tmp_path):
    data = b"archive"
    sha = hashlib.sha256(data).hexdigest()
    with pytest.raises(bh.BuildError):
        bh.download_verified("https://x/a.zip", tmp_path / "a.zip", "", pin=False, opener=_opener(data))
    assert bh.download_verified("https://x/a.zip", tmp_path / "b.zip", "", pin=True, opener=_opener(data)) == sha
    with pytest.raises(bh.BuildError):
        bh.download_verified("https://x/a.zip", tmp_path / "c.zip", "0" * 64, pin=False, opener=_opener(data))
    assert not (tmp_path / "c.zip").exists()


def _zip(path, entries):
    with zipfile.ZipFile(path, "w") as zf:
        for name, body in entries.items():
            zf.writestr(name, body)


def test_extract_tool_strips_root_prunes_and_validates(tmp_path):
    archive = tmp_path / "ff.zip"
    _zip(archive, {"ff-1/bin/ffmpeg.exe": "x", "ff-1/bin/ffplay.exe": "x", "ff-1/doc/a.html": "x"})
    tool = {"name": "ffmpeg", "kind": "zip", "strip_root": True, "prune": ["bin/ffplay.exe", "doc"], "keep": [],
            "expect": ["bin/ffmpeg.exe"], "bin_dir": "bin"}
    final = bh.extract_tool(tool, archive, tmp_path / "vendor", None, None)
    assert sorted(p.relative_to(final).as_posix() for p in final.rglob("*")) == ["bin", "bin/ffmpeg.exe"]
    assert [p.name for p in (tmp_path / "vendor").iterdir()] == ["ffmpeg"], "staging folder must be cleaned up"


def test_extract_tool_keeps_previous_version_when_layout_changes(tmp_path):
    good = tmp_path / "good.zip"
    _zip(good, {"bin/ffmpeg.exe": "v1"})
    tool = {"name": "ffmpeg", "kind": "zip", "expect": ["bin/ffmpeg.exe"]}
    bh.extract_tool(tool, good, tmp_path / "vendor", None, None)
    bad = tmp_path / "bad.zip"
    _zip(bad, {"other/ffmpeg.exe": "v2"})
    with pytest.raises(bh.BuildError):
        bh.extract_tool(tool, bad, tmp_path / "vendor", None, None)
    assert (tmp_path / "vendor" / "ffmpeg" / "bin" / "ffmpeg.exe").read_text() == "v1"


def test_extract_tool_copies_app_local_crt(tmp_path):
    archive = tmp_path / "gs.zip"
    _zip(archive, {"bin/gswin64c.exe": "x"})
    system = tmp_path / "System32"
    system.mkdir()
    (system / "vcruntime140.dll").write_text("crt")
    tool = {"name": "ghostscript", "kind": "zip", "bin_dir": "bin", "app_local_crt": ["vcruntime140.dll"], "expect": ["bin/vcruntime140.dll"]}
    bh.extract_tool(tool, archive, tmp_path / "vendor", None, system)
    tool["app_local_crt"].append("msvcp140.dll")
    with pytest.raises(bh.BuildError):
        bh.extract_tool(tool, archive, tmp_path / "vendor2", None, system)


def test_render_inno_escapes_and_requires_pins():
    manifest = {"tools": [], "assets": [{"name": "m", "url": "https://x/it's.onnx", "sha256": "a" * 64, "dest": "kokoro/m.onnx"}]}
    files, code = bh.render_inno(manifest)
    assert 'DestDir: "{localappdata}\\StudyLibrary\\models\\kokoro"; DestName: "m.onnx"' in files
    assert "'https://x/it''s.onnx'" in code
    assert code.count("begin") == code.count("end;")
    manifest["assets"][0]["sha256"] = ""
    with pytest.raises(bh.BuildError):
        bh.render_inno(manifest)


def test_render_inno_for_shipped_manifest():
    files, code = bh.render_inno(rt.load_manifest(rt.resource_dir() / "manifest.json"))
    assert files.count("Source:") == 2 and code.count("Page.Add(") == 2


def test_env_template_sanitised_and_scanned(tmp_path):
    text = "# keep\nAPI_KEY=sk-live-123\nexport DB_PASSWORD=hunter2\nPORT=8765\n"
    clean = bh.sanitise_env_template(text)
    assert "sk-live" not in clean and "hunter2" not in clean and "PORT=8765" in clean
    assert bh.secret_findings(text) and not bh.secret_findings(clean)
    dist = tmp_path / "dist"
    (dist / "_internal").mkdir(parents=True)
    (dist / "_internal" / "env.template").write_text(clean)
    assert bh.scan_dist(dist) == []
    (dist / "_internal" / "study").mkdir()
    (dist / "_internal" / "study" / ".env").write_text("X=1")
    assert any(".env" in p for p in bh.scan_dist(dist))


def test_shipped_template_has_no_secrets():
    assert bh.secret_findings((rt.resource_dir() / "env.template").read_text()) == []


@pytest.mark.parametrize("tag,expected", [("1.2.3", "1.2.3.0"), ("v2.0", "2.0.0.0"), ("v1.4.2-3-gabc", "1.4.2.0"), ("dev", "0.0.0.0")])
def test_numeric_version(tag, expected):
    assert bh.numeric_version(tag) == expected
