"""Study Library on Windows, without WSL or Task Scheduler.

From the Start menu or desktop shortcut:  pythonw -m study.desktop
  starts the processor and the Listen speech server if they are not already
  running, then opens Study Library in its own Edge window.
From the Startup folder, at sign-in:      pythonw -m study.desktop --headless
  the same with no window; this process stays on as their supervisor.
--app-only opens the window only. --once works through the queue in the
foreground and exits, for a terminal.

Everything lives under %LOCALAPPDATA%\\StudyLibrary, or $STUDY_HOME:
  repo\\               a git checkout that follows origin/production
  repo\\backend\\.env   the processor's settings, as in WSL
  .venv\\              the Python environment
  tessdata\\           eng, fra, deu and osd for Tesseract
  models\\kokoro\\      the Kokoro ONNX model and voices
  logs\\               desktop.log, processor.log and tts.log
backend/setup-windows.ps1 builds all of it.
"""

from __future__ import annotations

import argparse
import logging
import logging.handlers
import os
import re
import subprocess
import sys
import tempfile
import time
import webbrowser
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger("study.desktop")

WINDOWS = os.name == "nt"
MUTEX_NAME = "Local\\StudyLibraryWorkerMutex"
TTS_PORT = 8765
# The processor follows origin/production, which is what the Worker runs, so
# it never expects a route that has not been deployed yet.
BRANCH = "production"
UPDATE_SECONDS = 6 * 60 * 60
# A log is set aside at each start once it passes 5 MB, keeping one old copy,
# as run-processor.sh does.
LOG_LIMIT = 5_000_000
# A job may run this long after the processor is asked to stop for an update.
STOP_GRACE_SECONDS = 2 * 60 * 60
CREATE_NO_WINDOW = 0x08000000
CREATE_NEW_PROCESS_GROUP = 0x00000200
DETACHED_PROCESS = 0x00000008
WAIT_OBJECT_0 = 0x00000000
WAIT_ABANDONED = 0x00000080


def default_home() -> Path:
    if os.environ.get("STUDY_HOME"):
        return Path(os.environ["STUDY_HOME"])
    return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / "StudyLibrary"


def load_env_file(path: Path) -> dict[str, str]:
    """KEY=value lines, as `set -a; . ./.env` reads them. Notepad's byte-order
    mark and Windows line endings are dropped, so a key never arrives as
    "\\ufeffSTUDY_URL" or with a hidden "\\r" on its value."""
    try:
        text = Path(path).read_text(encoding="utf-8-sig")
    except FileNotFoundError:
        return {}
    values: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        key, sep, value = line.partition("=")
        if not sep:
            continue
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        values[key] = value
    return values


def _get(env: Mapping[str, str], name: str) -> str | None:
    """Windows names are not case-sensitive: os.environ has PROGRAMFILES."""
    for key, value in env.items():
        if key.upper() == name.upper():
            return value
    return None


def _pop(env: dict[str, str], name: str) -> str | None:
    value = None
    for key in [k for k in env if k.upper() == name.upper()]:
        value = env.pop(key)
    return value


def _version(path: Path) -> list[int]:
    return [int(n) for n in re.findall(r"\d+", path.parent.name)]


def _scripts(home: Path) -> Path:
    return home / ".venv" / ("Scripts" if WINDOWS else "bin")


def prepare_environment(home: Path, base: Mapping[str, str] | None = None) -> dict[str, str]:
    """The environment the processor and speech server run in: the caller's,
    with the .env on top, and the tools winget installed put first on PATH,
    because the Tesseract and Ghostscript installers do not add themselves."""
    home = Path(home)
    env = dict(os.environ if base is None else base)
    env.update(load_env_file(home / "repo" / "backend" / ".env"))
    programs = Path(_get(env, "ProgramFiles") or r"C:\Program Files")
    # Newest by version, not by spelling: gs10.04.0 sorts before gs9.56.1 as text.
    ghostscript = sorted(programs.glob("gs/gs*/bin"), key=_version)
    folders = [_scripts(home), programs / "Tesseract-OCR", *ghostscript[-1:], programs / "LibreOffice" / "program"]
    local = _get(env, "LOCALAPPDATA")
    if local:
        folders.append(Path(local) / "Microsoft" / "WinGet" / "Links")
    inherited = _pop(env, "PATH")
    env["PATH"] = os.pathsep.join([str(f) for f in folders if f.is_dir()] + ([inherited] if inherited else []))
    if (home / "tessdata").is_dir():
        env["TESSDATA_PREFIX"] = str(home / "tessdata")
    # Tools print UTF-8; without this Windows decodes their output as cp1252,
    # which has no character for some bytes of names such as "Łódź".
    env["PYTHONUTF8"] = "1"
    # backend/ only, which holds both study and tts. The packaged build has no
    # repository root to import "backend" from, so putting the root here as
    # well would let a "backend.tts" import work from source and fail frozen.
    pythonpath = [str(home / "repo" / "backend"), _pop(env, "PYTHONPATH") or ""]
    env["PYTHONPATH"] = os.pathsep.join(p for p in pythonpath if p)
    env["STUDY_MODELS_DIR"] = str(home / "models")
    return env


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, check=True,
                          timeout=300, creationflags=CREATE_NO_WINDOW if WINDOWS else 0).stdout.strip()


def update_checkout(home: Path) -> bool:
    """Moves the checkout to the newest origin/production. True only when the
    code changed and its requirements installed; any failure (offline, no
    git, local edits) is logged and leaves the code as it was."""
    repo = Path(home) / "repo"
    try:
        before = _git(repo, "rev-parse", "HEAD")
        _git(repo, "fetch", "origin", BRANCH)
        _git(repo, "merge", "--ff-only", f"origin/{BRANCH}")
        after = _git(repo, "rev-parse", "HEAD")
    except (OSError, subprocess.SubprocessError) as error:
        log.warning("could not update %s: %s", repo, getattr(error, "stderr", None) or error)
        return False
    if after == before:
        return False
    changed = _git(repo, "diff", "--name-only", before, after).splitlines()
    if "backend/requirements.txt" in changed:
        try:
            subprocess.run([_python(home), "-m", "pip", "install", "-r", str(repo / "backend" / "requirements.txt")],
                           capture_output=True, check=True, timeout=1800,
                           creationflags=CREATE_NO_WINDOW if WINDOWS else 0)
        except (OSError, subprocess.SubprocessError) as error:
            log.error("requirements for %s did not install, staying on %s: %s", after[:8], before[:8],
                      getattr(error, "stderr", None) or error)
            _git(repo, "reset", "--hard", before)
            return False
    log.info("updated from %s to %s", before[:8], after[:8])
    return True


def update_available(home: Path) -> bool:
    """Whether origin/production has moved on from the checkout by commits it
    can fast-forward to. Leaves the checkout as it is."""
    repo = Path(home) / "repo"
    try:
        _git(repo, "fetch", "origin", BRANCH)
        if _git(repo, "rev-parse", "HEAD") == _git(repo, "rev-parse", f"origin/{BRANCH}"):
            return False
        _git(repo, "merge-base", "--is-ancestor", "HEAD", f"origin/{BRANCH}")
        return True
    except (OSError, subprocess.SubprocessError):
        return False


class _Instance:
    """Holds the single-instance lock for as long as the process keeps it."""

    def __init__(self, release):
        self._release = release

    def close(self) -> None:
        if self._release:
            self._release()
            self._release = None


def acquire_single_instance(name: str = MUTEX_NAME, wait_seconds: float = 0.0) -> _Instance | None:
    """One worker per Windows user. Waits up to wait_seconds, so a successor
    started during an update takes over once the old supervisor exits. None
    when another process still holds it. Elsewhere a lock file does the same."""
    if WINDOWS:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.windll.kernel32
        kernel32.CreateMutexW.restype = wintypes.HANDLE
        kernel32.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
        kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel32.ReleaseMutex.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel32.CreateMutexW(None, False, name)
        if not handle:
            return None
        # A mutex whose owner died is "abandoned", and passes to the next waiter.
        if kernel32.WaitForSingleObject(handle, int(wait_seconds * 1000)) in (WAIT_OBJECT_0, WAIT_ABANDONED):
            return _Instance(lambda: (kernel32.ReleaseMutex(handle), kernel32.CloseHandle(handle)))
        kernel32.CloseHandle(handle)
        return None

    import fcntl

    path = Path(tempfile.gettempdir()) / (re.sub(r"[^A-Za-z0-9_.-]", "_", name) + ".lock")
    handle = open(path, "a")  # noqa: SIM115 - kept open as the lock itself
    deadline = time.monotonic() + wait_seconds
    while True:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return _Instance(handle.close)
        except BlockingIOError:
            if time.monotonic() >= deadline:
                handle.close()
                return None
            time.sleep(0.2)


def _frozen() -> bool:
    """True in the PyInstaller build, where sys.executable is StudyLibrary.exe."""
    return bool(getattr(sys, "frozen", False))


def _python(home: Path, windowless: bool = False) -> str:
    """The environment's Python: python.exe for children, whose hidden console
    their own children (Tesseract, ffmpeg, LibreOffice) inherit, so no window
    appears; pythonw.exe for the supervisor itself. The packaged build has no
    separate Python, so it relaunches StudyLibrary.exe, which runs "-m module"
    as python.exe would, and it ignores any .venv that a source install may
    have left in the same home."""
    if _frozen():
        return sys.executable
    name = ("pythonw.exe" if windowless else "python.exe") if WINDOWS else "python"
    for candidate in (_scripts(Path(home)) / name, Path(sys.executable).with_name(name)):
        if candidate.is_file():
            return str(candidate)
    return sys.executable


def _workdir(home: Path) -> Path:
    """The folder each child starts in. A source install uses repo\\backend so
    that "-m study..." finds the package there, whereas the packaged build has
    no checkout at all and carries the package inside the executable, so it
    uses home, which main has created by then. Windows refuses a folder that
    does not exist with WinError 267 before the child runs."""
    home = Path(home)
    return home if _frozen() else home / "repo" / "backend"


def _log(home: Path, name: str):
    folder = Path(home) / "logs"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / name
    if path.exists() and path.stat().st_size > LOG_LIMIT:
        os.replace(path, path.with_name(name + ".1"))
    return open(path, "ab")  # noqa: SIM115 - handed to the child process


def _stop_file(home: Path) -> Path:
    return Path(home) / "processor.stop"


# The speech server is named relative to backend/, as study is, because that
# is the one folder both layouts share: a source install runs from
# repo\backend with it on PYTHONPATH, and the packaged build carries study and
# tts as top-level packages, with no "backend" package anywhere inside it.
TTS_APP = "tts.server:app"

COMMANDS = {
    "processor": ["-m", "study.processor"],
    "tts": ["-m", "uvicorn", TTS_APP, "--host", "127.0.0.1", "--port", str(TTS_PORT)],
}


def _child_modules(commands: Mapping[str, list[str]]) -> tuple[str, ...]:
    """The modules the children import first: each one after "-m", and the
    application uvicorn loads by name, which no static analysis can see."""
    found: list[str] = []
    for args in commands.values():
        module = args[args.index("-m") + 1]
        found.append(module)
        if module == "uvicorn":
            found.append(args[args.index("-m") + 2].partition(":")[0])
    return tuple(dict.fromkeys(found))


# The packaged build's --self-test looks for each of these inside the bundle,
# because importing study.desktop alone proves nothing about its children.
CHILD_MODULES = _child_modules(COMMANDS)


def _start(home: Path, env: Mapping[str, str], name: str) -> subprocess.Popen:
    home = Path(home)
    with _log(home, f"{name}.log") as out:
        return subprocess.Popen(
            [_python(home), *COMMANDS[name]], cwd=_workdir(home), env=dict(env),
            stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT,
            creationflags=CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP if WINDOWS else 0,
        )


def spawn_worker(home: Path, env: Mapping[str, str] | None = None) -> dict[str, subprocess.Popen]:
    """Starts the processor and the speech server, each logging to its own file."""
    env = dict(prepare_environment(home) if env is None else env)
    env["PROCESSOR_STOP_FILE"] = str(_stop_file(home))
    return {name: _start(home, env, name) for name in COMMANDS}


def _edge() -> str | None:
    import winreg

    key = r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe"
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        try:
            with winreg.OpenKey(hive, key) as handle:
                path = winreg.QueryValue(handle, None)
                if path and Path(path).is_file():
                    return path
        except OSError:
            continue
    for root in (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles")):
        path = Path(root or "") / "Microsoft" / "Edge" / "Application" / "msedge.exe"
        if root and path.is_file():
            return str(path)
    return None


def open_window(url: str) -> None:
    """Study Library in its own Edge window, in the Edge profile that already
    holds its Access sign-in, offline copy and service worker. Without Edge,
    the default browser."""
    edge = _edge() if WINDOWS else None
    if edge:
        subprocess.Popen([edge, f"--app={url}"], creationflags=DETACHED_PROCESS)
    else:
        webbrowser.open(url)


def _spawn_supervisor(home: Path, handover: bool) -> None:
    env = dict(os.environ)
    if handover:
        env["STUDY_HANDOVER"] = "1"
    else:
        env.pop("STUDY_HANDOVER", None)
    subprocess.Popen(
        [_python(home, windowless=True), "-m", "study.desktop", "--headless"],
        cwd=_workdir(home), env=env,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP if WINDOWS else 0,
        start_new_session=not WINDOWS,
    )


@dataclass
class _Child:
    name: str
    proc: subprocess.Popen
    started: float
    delay: float = 5.0
    retry_at: float | None = None


def _stop_children(home: Path, children: dict[str, _Child]) -> None:
    """Lets the processor finish its job, then stops both."""
    _stop_file(home).touch()
    processor = children["processor"].proc
    try:
        processor.wait(STOP_GRACE_SECONDS)
    except subprocess.TimeoutExpired:
        log.warning("the processor did not stop within the grace period; ending it")
    for child in children.values():
        if child.proc.poll() is None:
            child.proc.terminate()
            try:
                child.proc.wait(30)
            except subprocess.TimeoutExpired:
                child.proc.kill()
    _stop_file(home).unlink(missing_ok=True)


def _apply_update(home: Path, children: dict[str, _Child]) -> bool:
    """Moves to new code while the processor and speech server are stopped:
    on Windows pip cannot replace a library such as numpy, onnxruntime or
    PyMuPDF while a running process has it loaded. If the update does not
    go through, the supervisor's loop starts the children again."""
    if not update_available(home):
        return False
    _stop_children(home, children)
    return update_checkout(home)


def supervise(home: Path) -> int:
    """Keeps the processor and speech server running, restarts either if it
    exits, and moves to new code every six hours."""
    home = Path(home)
    instance = acquire_single_instance(MUTEX_NAME, 120.0 if os.environ.get("STUDY_HANDOVER") else 0.0)
    if instance is None:
        log.info("the processor is already running")
        return 0
    if update_checkout(home):
        # The new code may include this file, so a fresh supervisor runs it.
        _spawn_supervisor(home, handover=True)
        return 0
    _stop_file(home).unlink(missing_ok=True)
    env = prepare_environment(home)
    env["PROCESSOR_STOP_FILE"] = str(_stop_file(home))
    now = time.monotonic()
    children = {name: _Child(name, _start(home, env, name), now) for name in COMMANDS}
    log.info("started the processor and the speech server")
    next_update = now + UPDATE_SECONDS
    while True:
        now = time.monotonic()
        for child in children.values():
            if child.proc.poll() is None:
                continue
            if child.retry_at is None:
                # A child that ran a minute or more had a real run; one that
                # exits at once (a missing setting, a taken port) is retried
                # less and less often, up to every half hour.
                child.delay = 5.0 if now - child.started >= 60 else min(child.delay * 2, 1800.0)
                child.retry_at = now + child.delay
                log.warning("%s exited with %s; restarting in %.0f s", child.name, child.proc.returncode, child.delay)
            elif now >= child.retry_at:
                try:
                    child.proc, child.started, child.retry_at = _start(home, env, child.name), now, None
                except OSError:
                    log.exception("could not start %s", child.name)
                    child.retry_at = now + child.delay
        if now >= next_update:
            next_update = now + UPDATE_SECONDS
            if _apply_update(home, children):
                _spawn_supervisor(home, handover=True)
                instance.close()
                return 0
        time.sleep(5)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m study.desktop")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--headless", action="store_true", help="Run the processor and speech server, with no window")
    mode.add_argument("--app-only", action="store_true", help="Open the window only")
    mode.add_argument("--once", action="store_true", help="Work through the queue in this window, then exit")
    args = parser.parse_args(argv)
    home = default_home()
    (home / "logs").mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s %(message)s",
        handlers=[logging.handlers.RotatingFileHandler(home / "logs" / "desktop.log", maxBytes=1_000_000,
                                                       backupCount=1, encoding="utf-8")],
    )
    if args.once:
        return subprocess.call([_python(home), "-m", "study.processor", "--once"],
                               cwd=_workdir(home), env=prepare_environment(home))
    if args.headless:
        try:
            return supervise(home)
        except Exception:  # noqa: BLE001 - pythonw has nowhere else to say it
            log.exception("the supervisor stopped")
            return 1
    if not args.app_only:
        # Exits at once if a supervisor is already running.
        _spawn_supervisor(home, handover=False)
    url = prepare_environment(home).get("STUDY_URL")
    if not url:
        log.error("STUDY_URL is not set in %s", home / "repo" / "backend" / ".env")
        return 1
    open_window(url)
    return 0


if __name__ == "__main__":
    sys.exit(main())
