# filename: backend/tests/test_review_regressions.py
"""Regressions found in review of the 0.41.1 sync diff.

Each test asserts the safe behaviour, so each fails on the submitted change and
passes once the matching recommendation is applied. They read the real
.gitignore and app/package.json from the repository root, and need git and bash
on PATH (both are present in WSL, where test:backend runs).

Run from backend/: python -m pytest -q tests/test_review_regressions.py
"""

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
REPO = BACKEND.parent
sys.path.insert(0, str(BACKEND))


@pytest.mark.skipif(shutil.which("git") is None, reason="needs git")
def test_gitignore_does_not_hide_the_backend_study_package(tmp_path):
    """.gitignore:3 adds an unanchored `Study/`. Git for Windows sets
    core.ignorecase=true, which makes that pattern match `backend/study/`, so
    a new module added to the real Python package is silently left out of
    every commit."""
    shutil.copy(REPO / ".gitignore", tmp_path / ".gitignore")
    git = ["git", "-C", str(tmp_path), "-c", "core.ignorecase=true"]
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    new_module = tmp_path / "backend" / "study" / "new_module.py"
    new_module.parent.mkdir(parents=True)
    new_module.write_text("x = 1\n")
    ignored = subprocess.run([*git, "check-ignore", "-v", "backend/study/new_module.py"],
                             capture_output=True, text=True)
    assert ignored.returncode == 1, f"backend/study is ignored on Windows: {ignored.stdout.strip()}"


def _sync_script(name: str) -> str:
    return json.loads((REPO / "app" / "package.json").read_text(encoding="utf-8"))["scripts"][name]


@pytest.mark.skipif(shutil.which("bash") is None, reason="needs bash")
@pytest.mark.parametrize("name, module", [("sync:jobs", "sync.jobs"), ("sync:study", "sync.study")])
def test_npm_sync_scripts_pass_arguments_through_to_python(name, module, tmp_path):
    """app/package.json: `npm run sync:jobs -- --dry-run` appends --dry-run
    after the `bash -c "..."` string, where bash binds it to $0, so python
    never sees it and a run the user meant as a dry run writes for real.

    The script runs as wsl would run it, minus the wsl prefix, with rsync and
    python replaced by stubs on PATH and HOME pointed at a scratch folder, so
    nothing is copied and the stub prints the arguments python receives."""
    words = shlex.split(_sync_script(name))
    assert words[:2] == ["wsl", "bash"], words
    home, stubs = tmp_path / "home", tmp_path / "bin"
    (home / "study-library" / "backend").mkdir(parents=True)
    (home / ".venvs" / "study" / "bin").mkdir(parents=True)
    (home / ".venvs" / "study" / "bin" / "activate").write_text("")
    stubs.mkdir()
    (stubs / "rsync").write_text("#!/bin/sh\nexit 0\n")
    (stubs / "python").write_text("#!/bin/sh\nprintf '[%s]' \"$@\"\n")
    for stub in stubs.iterdir():
        stub.chmod(0o755)
    env = {**os.environ, "HOME": str(home), "PATH": f"{stubs}{os.pathsep}{os.environ['PATH']}"}
    output = subprocess.run([*words[1:], "--dry-run"], cwd=REPO / "app", env=env,
                            capture_output=True, text=True, check=True)
    assert f"[-m][{module}][--dry-run]" in output.stdout, f"python received {output.stdout!r}"


class _EmptyApi:
    def pull_all(self):
        return {"applications": {}, "application_events": {}}

    def object_chunks(self, key):
        raise AssertionError("nothing should be fetched")


def test_a_windows_destination_is_refused_on_linux_rather_than_created_in_cwd(tmp_path, monkeypatch):
    """sync/jobs.py DEFAULT_DEST is `G:\\...`. The npm scripts run the sync in
    WSL, where that string is a relative POSIX name, so the drive check in
    common.run is skipped (the anchor is empty) and the whole tree is written
    to a folder literally named "G:\\My Drive\\..." in the current directory,
    with exit code 0 and nothing in Google Drive."""
    if os.name == "nt":
        pytest.skip("the bug only exists where the path is POSIX")
    from sync import common, jobs
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(common.os.path, "ismount", lambda _p: False)
    args = jobs.base_arguments("test", jobs.DEFAULT_DEST).parse_args(["--state-dir", str(tmp_path / "state")])
    lines: list[str] = []
    code = common.run("jobs", args, jobs.build, api_factory=lambda _env: _EmptyApi(), out=lines.append)
    stray = [p.name for p in tmp_path.iterdir() if p.name != "state"]
    assert code == 2 and not stray, f"exit {code}, wrote into the working folder: {stray}"


def test_sync_uses_the_same_api_client_as_the_processor():
    """The diff patches backend/study/api.py and also adds an untracked copy at
    backend/api.py, which is the one sync/common.py imports and the one
    test_api_flaws.py tests. Two copies drift, and the copy kept alive in the
    WSL mirror (the sync scripts rsync without --delete) outlives any removal."""
    from sync import common
    import study.api
    assert common.Api is study.api.Api, "sync imports a duplicate client, not backend/study/api.py"
    assert not (BACKEND / "api.py").exists(), "backend/api.py duplicates backend/study/api.py"
