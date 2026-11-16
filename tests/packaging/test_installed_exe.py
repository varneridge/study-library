"""End-to-end check of an installed StudyLibrary.exe.

Skipped unless SL_INSTALLED_EXE points at an installed exe; build.ps1 -Verify
installs the freshly built setup silently and sets it before running this file.
"""
import json
import os
import subprocess
from pathlib import Path

import pytest

EXE = os.environ.get("SL_INSTALLED_EXE")
pytestmark = pytest.mark.skipif(not EXE, reason="SL_INSTALLED_EXE is not set (build.ps1 -Verify sets it)")


@pytest.fixture(scope="module")
def report(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("selftest")
    out = tmp / "report.json"
    env = dict(os.environ, STUDY_LIBRARY_HOME=str(tmp / "home"))
    env.pop("STUDY_VENDOR_DIR", None)
    proc = subprocess.run([EXE, "--self-test", str(out)], env=env, timeout=300)
    assert out.is_file(), f"self-test wrote no report (exit code {proc.returncode})"
    data = json.loads(out.read_text(encoding="utf-8"))
    data["_exit_code"] = proc.returncode
    return data


def test_self_test_passes(report):
    assert report["ok"], json.dumps(report, indent=2)
    assert report["_exit_code"] == 0
    assert report["frozen"] is True


def test_required_tools_are_bundled_and_run(report):
    for name, tool in report["tools"].items():
        if tool["required"]:
            assert tool["source"] == "bundled", f"{name} resolved to {tool}"
            assert tool["exit_code"] == 0, f"{name} check failed: {tool['output']}"
    assert "tessdata" in report["tools"]["tesseract"]["output"].lower(), "tesseract did not find its bundled tessdata"


def test_app_entry_point_imports(report):
    assert report["entry"]["importable"], report["entry"]


def test_no_env_files_shipped():
    offenders = [p for p in Path(EXE).parent.rglob(".env*")]
    assert offenders == []
