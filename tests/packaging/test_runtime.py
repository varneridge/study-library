"""Unit tests for packaging/windows/slruntime.py; they run on any operating system."""
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

import slruntime as rt

MANIFEST = Path(rt.__file__).with_name("manifest.json")


def test_shipped_manifest_is_valid_and_pinned():
    import slassets

    manifest = rt.load_manifest(MANIFEST)
    specs = rt.tool_specs(manifest)
    assert {s.name for s in specs if s.required} == {"ffmpeg", "tesseract", "ghostscript"}
    for tool in manifest["tools"]:
        if tool["kind"] != "system":
            assert len(tool["sha256"]) == 64, f"{tool['name']} is not pinned"
            assert tool["url"].startswith("https://")
    assert all(a.pinned for a in slassets.asset_specs(manifest))


@pytest.mark.parametrize("bad", ["../escape", "/abs", "C:\\abs", "a/../../b", ""])
def test_safe_relative_rejects_escapes(bad):
    with pytest.raises(rt.ManifestError):
        rt.safe_relative(bad, "test")


def test_tool_specs_reject_duplicates_and_bad_kind():
    with pytest.raises(rt.ManifestError):
        rt.tool_specs({"tools": [{"name": "a", "kind": "zip", "exe": "a.exe"}] * 2, "assets": []})
    with pytest.raises(rt.ManifestError):
        rt.tool_specs({"tools": [{"name": "a", "kind": "msi", "exe": "a.exe"}], "assets": []})


def test_home_dir_precedence(tmp_path):
    assert rt.home_dir({rt.HOME_ENV: str(tmp_path / "x"), "LOCALAPPDATA": "ignored"}) == tmp_path / "x"
    assert rt.home_dir({"LOCALAPPDATA": str(tmp_path)}) == tmp_path / "StudyLibrary"


def test_ensure_layout_creates_fixed_subdirs(tmp_path):
    paths = rt.ensure_layout(tmp_path / "home")
    assert {k for k in paths} == {"home", "data", "models", "logs"}
    assert all(p.is_dir() for p in paths.values())
    assert list((tmp_path / "home").glob(".write-test-*")) == []


def _fake_vendor(tmp_path):
    vendor = tmp_path / "vendor"
    (vendor / "ffmpeg" / "bin").mkdir(parents=True)
    (vendor / "ffmpeg" / "bin" / "ffmpeg.exe").write_text("x")
    (vendor / "tesseract" / "tessdata").mkdir(parents=True)
    (vendor / "tesseract" / "tesseract.exe").write_text("x")
    return vendor


def test_apply_environment_prefers_bundled_and_is_idempotent(tmp_path):
    vendor = _fake_vendor(tmp_path)
    specs = rt.tool_specs(rt.load_manifest(MANIFEST))
    env = {"PATH": "/usr/bin", "TESSDATA_PREFIX": "/stale/user/value", "STUDY_DATA_DIR": "/user/override"}
    statuses = rt.apply_environment(specs, vendor, tmp_path / "home", env)
    assert statuses["ffmpeg"].source == "bundled"
    assert statuses["tesseract"].source == "bundled"
    assert statuses["ghostscript"].source == "missing"
    assert env["TESSDATA_PREFIX"] == str(vendor / "tesseract" / "tessdata"), "bundled tool must override stale user value"
    assert env["FFMPEG_BINARY"] == str(vendor / "ffmpeg" / "bin" / "ffmpeg.exe")
    assert env["STUDY_DATA_DIR"] == "/user/override", "user override of data dir must win"
    assert env["PATH"].split(os.pathsep)[0] == str(vendor / "ffmpeg" / "bin")
    first = env["PATH"]
    rt.apply_environment(specs, vendor, tmp_path / "home", env)
    assert env["PATH"] == first


def test_system_tool_found_via_search_dir(tmp_path):
    prog = tmp_path / "LibreOffice" / "program"
    prog.mkdir(parents=True)
    (prog / "soffice.exe").write_text("x")
    spec = rt.ToolSpec(name="libreoffice", kind="system", exe="soffice.exe", search=("%PF%\\LibreOffice\\program".replace("\\", os.sep),))
    status = rt.resolve_tool(spec, tmp_path / "vendor", {"PF": str(tmp_path), "PATH": ""})
    assert status.source == "system" and status.path == str(prog / "soffice.exe")


def test_parse_env_text_handles_common_forms():
    text = "\ufeff# c\nA=1\nexport B = two \nC=\"quoted # kept\"\nD=x # comment\nbad line\n1X=no\nE=\n"
    assert rt.parse_env_text(text.lstrip("\ufeff")) == {"A": "1", "B": "two", "C": "quoted # kept", "D": "x", "E": ""}


def test_load_env_file_never_overrides_process_env(tmp_path):
    path = tmp_path / ".env"
    path.write_text("A=file\nB=file\n", encoding="utf-8-sig")
    env = {"A": "process", "B": ""}
    assert rt.load_env_file(path, env) == ["B"]
    assert env == {"A": "process", "B": "file"}
    assert rt.load_env_file(tmp_path / "missing", env) == []


def test_required_keys_and_missing_keys():
    template = textwrap.dedent(
        """
        # @required first
        A=
        B=
        # @required second

        C=
        """
    )
    assert rt.required_keys(template) == ["A", "C"]
    assert rt.missing_keys(["A", "C"], {"A": "set", "C": "  "}) == ["C"]


def test_seed_env_file_never_clobbers(tmp_path):
    template = tmp_path / "env.template"
    template.write_text("A=\n")
    target = tmp_path / "home" / ".env"
    assert rt.seed_env_file(target, template) is True
    target.write_text("A=user\n")
    assert rt.seed_env_file(target, template) is False
    assert target.read_text() == "A=user\n"
    assert [p.name for p in target.parent.iterdir()] == [".env"]


def test_file_lock_is_exclusive_and_reusable(tmp_path):
    first, second = rt.FileLock(tmp_path / "x.lock"), rt.FileLock(tmp_path / "x.lock")
    assert first.acquire()
    assert not second.acquire(timeout=0.3)
    first.release()
    assert second.acquire()
    second.release()


def test_file_lock_released_when_holder_process_dies(tmp_path):
    lock_path = tmp_path / "instance.lock"
    holder = subprocess.Popen(
        [sys.executable, "-c", f"import sys,time; sys.path.insert(0, {str(Path(rt.__file__).parent)!r}); "
         f"import slruntime as rt; l = rt.FileLock({str(lock_path)!r}); assert l.acquire(); print('held', flush=True); time.sleep(60)"],
        stdout=subprocess.PIPE, text=True,
    )
    try:
        assert holder.stdout.readline().strip() == "held"
        assert not rt.FileLock(lock_path).acquire()
    finally:
        holder.kill()
        holder.wait()
    assert rt.FileLock(lock_path).acquire(timeout=5), "a killed holder must not leave a stale lock"


def test_instance_info_round_trip(tmp_path):
    assert rt.read_instance_info(tmp_path) is None
    rt.write_instance_info(tmp_path, "http://127.0.0.1:8765")
    assert rt.read_instance_info(tmp_path)["url"] == "http://127.0.0.1:8765"
    rt.clear_instance_info(tmp_path)
    rt.clear_instance_info(tmp_path)
    assert rt.read_instance_info(tmp_path) is None
