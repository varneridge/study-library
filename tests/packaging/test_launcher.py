"""Tests for packaging/windows/launcher.py that run without a frozen build."""
import json
import sys
import textwrap

import pytest

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


def _entry_with_children(tmp_path, monkeypatch, name, children):
    """An entry module that, like study.desktop, lists the modules its child
    processes start by name, with a package that exists and a module that the
    build left out of it. Each test passes its own name, because an imported
    module stays in sys.modules and would otherwise leak into the next test."""
    pkg = tmp_path / "pkg"
    (pkg / "bundled_pkg").mkdir(parents=True, exist_ok=True)
    (pkg / "bundled_pkg" / "__init__.py").write_text("")
    (pkg / "bundled_pkg" / "server.py").write_text("app = object()\n")
    (pkg / f"{name}.py").write_text(f"CHILD_MODULES = {tuple(children)!r}\ndef main():\n    return 0\n")
    monkeypatch.syspath_prepend(str(pkg))
    return f"{name}:main"


def test_check_child_modules_finds_what_a_child_imports_without_running_it(tmp_path, monkeypatch):
    # "no_such_package_xyz.server" stands for "backend.tts.server" in the frozen
    # build: its parent package is absent, which find_spec reports by raising.
    spec = _entry_with_children(tmp_path, monkeypatch, "entry_listing_children",
                                ["json", "bundled_pkg.server", "no_such_package_xyz.server"])
    assert launcher.check_child_modules(spec) == {
        "json": True, "bundled_pkg.server": True, "no_such_package_xyz.server": False}
    assert "bundled_pkg.server" not in sys.modules, "the check must not import the module itself"
    assert launcher.check_child_modules("json:dumps") == {}, "an entry without CHILD_MODULES has nothing to check"


def test_self_test_fails_when_a_child_module_is_missing_from_the_build(tmp_path, monkeypatch):
    """The regression for the speech server: the entry module imported, so the
    old self-test passed, while uvicorn's "backend.tts.server:app" could not."""
    home = tmp_path / "home"
    prepared = launcher.Prepared(home, {"models": home / "models"}, [], {}, [], home / ".env", False, [])
    monkeypatch.setattr(launcher, "prepare", lambda env: prepared)
    report_path = tmp_path / "report.json"

    bad = _entry_with_children(tmp_path, monkeypatch, "entry_missing_a_child",
                               ["bundled_pkg.server", "no_such_package_xyz.server"])
    assert launcher.self_test(report_path, {launcher.ENTRY_ENV: bad}, execute_tools=False) == 1
    report = json.loads(report_path.read_text())
    assert report["entry"]["importable"] is True
    assert report["entry"]["child_modules"] == {"bundled_pkg.server": True, "no_such_package_xyz.server": False}
    assert report["errors"] == ["child module no_such_package_xyz.server is not in this build"]

    good = _entry_with_children(tmp_path, monkeypatch, "entry_with_every_child", ["bundled_pkg.server"])
    assert launcher.self_test(report_path, {launcher.ENTRY_ENV: good}, execute_tools=False) == 0


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
    monkeypatch.delenv("STUDY_DATA_DIR", raising=False)
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


def test_main_runs_a_module_as_python_dash_m_does_and_ignores_the_window_lock(tmp_path, monkeypatch):
    # study.desktop relaunches the frozen build as "StudyLibrary.exe -m study.desktop --headless"
    # while the first copy still holds instance.lock, so module mode must not wait for that lock.
    pkg = tmp_path / "pkg"
    pkg.mkdir()
    (pkg / "fake_supervisor.py").write_text(textwrap.dedent(
        """
        import json, os, sys
        if __name__ == "__main__":
            with open(os.environ["FAKE_OUT"], "w") as out:
                json.dump({"argv": sys.argv[1:], "data": os.environ.get("STUDY_DATA_DIR")}, out)
            sys.exit(5)
        """
    ))
    monkeypatch.delenv("STUDY_DATA_DIR", raising=False)
    monkeypatch.syspath_prepend(str(pkg))
    monkeypatch.setattr(sys, "argv", list(sys.argv))
    out = tmp_path / "out.json"
    env = _env(tmp_path, R2_ACCESS_KEY_ID="a", R2_SECRET_ACCESS_KEY="b", FAKE_OUT=str(out))
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setattr(launcher, "_start_asset_repair", lambda prep: pytest.fail("module mode must not repair assets"))
    monkeypatch.setattr(launcher, "_focus_running_instance", lambda home: pytest.fail("module mode must not defer"))
    (tmp_path / "home").mkdir(parents=True, exist_ok=True)
    window_lock = rt.FileLock(tmp_path / "home" / "instance.lock")
    assert window_lock.acquire()
    try:
        assert launcher.main(["-m", "fake_supervisor", "--headless"]) == 5
    finally:
        window_lock.release()
    assert json.loads(out.read_text()) == {"argv": ["--headless"], "data": str(tmp_path / "home" / "data")}


def test_main_reports_startup_crash(tmp_path, monkeypatch):
    env = _env(tmp_path, entry="does_not_exist_xyz:main", R2_ACCESS_KEY_ID="a", R2_SECRET_ACCESS_KEY="b")
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setattr(launcher, "_start_asset_repair", lambda prep: None)
    shown = []
    monkeypatch.setattr(rt, "message_box", lambda *a, **k: shown.append(a) or False)
    assert launcher.main([]) == 1
    assert shown and "launcher.log" in shown[0][1]
