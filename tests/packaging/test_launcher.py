"""Tests for packaging/windows/launcher.py that run without a frozen build."""
import json
import sys
import textwrap

import launcher
import slruntime as rt


def _env(tmp_path, entry="json:dumps", **extra):
    vendor = tmp_path / "vendor"
    for rel in ("ffmpeg/bin/ffmpeg.exe", "tesseract/tesseract.exe", "ghostscript/bin/gswin64c.exe"):
        (vendor / rel).parent.mkdir(parents=True, exist_ok=True)
        (vendor / rel).write_text("x")
    env = {"PATH": "", rt.HOME_ENV: str(tmp_path / "home"), rt.VENDOR_ENV: str(vendor), launcher.ENTRY_ENV: entry}
    env.update(extra)
    return env


def test_prepare_seeds_env_and_reports_missing_required_keys(tmp_path):
    env = _env(tmp_path)
    prep = launcher.prepare(env)
    assert prep.env_seeded and prep.env_file.is_file()
    assert prep.missing_keys == ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]
    assert env["KOKORO_MODEL_PATH"].endswith("kokoro-v1.0.onnx")
    assert env["STUDY_DATA_DIR"] == str(tmp_path / "home" / "data")
    prep.env_file.write_text("R2_ACCESS_KEY_ID=a\nR2_SECRET_ACCESS_KEY=b\n")
    env2 = _env(tmp_path)
    prep2 = launcher.prepare(env2)
    assert not prep2.env_seeded and prep2.missing_keys == []


def test_self_test_passes_with_all_required_tools(tmp_path):
    report_path = tmp_path / "report.json"
    assert launcher.self_test(report_path, _env(tmp_path), execute_tools=False) == 0
    report = json.loads(report_path.read_text())
    assert report["ok"] and report["entry"]["importable"]
    assert {n: t["source"] for n, t in report["tools"].items() if t["required"]} == {
        "ffmpeg": "bundled", "tesseract": "bundled", "ghostscript": "bundled"}


def test_self_test_fails_on_missing_tool_and_bad_entry(tmp_path):
    env = _env(tmp_path, entry="does_not_exist_xyz:main")
    (tmp_path / "vendor" / "ghostscript" / "bin" / "gswin64c.exe").unlink()
    report_path = tmp_path / "report.json"
    assert launcher.self_test(report_path, env, execute_tools=False) == 1
    errors = json.loads(report_path.read_text())["errors"]
    assert any("ghostscript" in e for e in errors) and any("entry point" in e for e in errors)


def test_self_test_runs_tool_checks(tmp_path):
    tool = tmp_path / "fake_tool.py"
    tool.write_text("import sys; print('fake 1.0'); sys.exit(0)")
    result = launcher.run_tool_check(sys.executable, [str(tool)])
    assert result == {"exit_code": 0, "output": "fake 1.0"}
    assert launcher.run_tool_check(str(tmp_path / "nope.exe"), [])["exit_code"] is None


def test_main_runs_entry_under_lock_and_second_instance_exits(tmp_path, monkeypatch):
    pkg = tmp_path / "pkg"
    pkg.mkdir()
    (pkg / "fake_app.py").write_text(textwrap.dedent(
        """
        import slruntime as rt, launcher, os
        CALLS = []
        def main():
            home = rt.home_dir(os.environ)
            CALLS.append(launcher.main([]))  # nested launch simulates a second double-click
            return 7
        """
    ))
    monkeypatch.syspath_prepend(str(pkg))
    env = _env(tmp_path, entry="fake_app:main", R2_ACCESS_KEY_ID="a", R2_SECRET_ACCESS_KEY="b")
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setattr(launcher, "_start_asset_repair", lambda prep: None)
    focused = []
    monkeypatch.setattr(launcher, "_focus_running_instance", lambda home: focused.append(home))
    assert launcher.main([]) == 7
    import fake_app
    assert fake_app.CALLS == [0] and focused == [tmp_path / "home"]
    assert rt.FileLock(tmp_path / "home" / "instance.lock").acquire(), "lock must be released after exit"


def test_main_reports_startup_crash(tmp_path, monkeypatch):
    env = _env(tmp_path, entry="does_not_exist_xyz:main", R2_ACCESS_KEY_ID="a", R2_SECRET_ACCESS_KEY="b")
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setattr(launcher, "_start_asset_repair", lambda prep: None)
    shown = []
    monkeypatch.setattr(rt, "message_box", lambda *a, **k: shown.append(a) or False)
    assert launcher.main([]) == 1
    assert shown and "launcher.log" in shown[0][1]
