"""Guards against the two ways build.ps1 -Verify hung in v0.53.7, plus the scratch home it relied on.

Reproducing the hangs needs Windows, Inno Setup and a CI runner, so these tests pin the source patterns
that caused them, which lets them run anywhere, including build.ps1's packaging unit-test step.
"""
import importlib.util
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BUILD = (ROOT / "packaging" / "windows" / "build.ps1").read_text(encoding="utf-8")
ISS = (ROOT / "packaging" / "windows" / "installer.iss").read_text(encoding="utf-8")


def test_setup_is_awaited_alone_and_with_a_time_limit():
    # Start-Process -Wait waits for every descendant, and the in-place update reopens Study Library as one,
    # so only the uninstaller (whose descendant is its own copy in %TEMP%, which exits) may be awaited that way.
    waiting = [line.strip() for line in BUILD.splitlines()
               if not line.lstrip().startswith("#") and re.search(r"\bStart-Process\b.*\s-Wait\b", line, re.I)]
    assert all("$uninstaller" in line for line in waiting), waiting
    assert re.search(r"\.WaitForExit\(\d+\)", BUILD), "Setup must be awaited with a time limit"


def test_unattended_update_cannot_block_on_a_message_box():
    # MsgBox ignores /SUPPRESSMSGBOXES, so every one must be skipped when nobody is there to close it.
    boxes = [line.strip() for line in ISS.splitlines() if re.search(r"(?<!Suppressible)MsgBox\(", line)]
    assert boxes and all("not IsUnattended()" in line for line in boxes), boxes
    update_args = re.search(r"\$updateArgs = @\((.*?)\)", BUILD, re.S).group(1)
    assert '"/VERYSILENT"' in update_args and '"/UPDATE=1"' in update_args, update_args


def test_real_users_still_get_the_failure_box():
    spec = importlib.util.spec_from_file_location("update_under_test", ROOT / "backend" / "study" / "update.py")
    update = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(update)
    assert "/SILENT" in update.INSTALL_ARGS and "/VERYSILENT" not in update.INSTALL_ARGS
    assert "/UPDATE=1" in update.INSTALL_ARGS


def test_relaunched_copy_gets_the_scratch_home_the_app_reads():
    exe_test = (ROOT / "tests" / "packaging" / "test_installed_exe.py").read_text(encoding="utf-8")
    assert "STUDY_LIBRARY_HOME" in exe_test
    assert "$env:STUDY_LIBRARY_HOME = " in BUILD
    assert "STUDY_HOME" not in BUILD.replace("STUDY_LIBRARY_HOME", "")
