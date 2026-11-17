"""Study Library on Windows, without WSL or Task Scheduler.

From the Start menu or desktop shortcut:  pythonw -m study.desktop
  starts the processor and the Listen speech server if they are not already
  running, then opens Study Library in its own Edge window, at an address
  marked ?sl=desktop so that the app shows its tabs and paints the window's
  title bar in its own background, and colours the native frame to match
  through DWM once the window appears.
From the Startup folder, at sign-in:      pythonw -m study.desktop --headless
  the same with no window; this process stays on as their supervisor.
--app-only opens the window only. --once works through the queue in the
foreground and exits, for a terminal.
--connect LINK is what the studylibrary:// link handler runs for "Connect this
computer": it checks the three credentials in the link against STUDY_URL and
only then saves them to the .env in the home folder, which the supervisor
notices and restarts its children for.

Everything lives under %LOCALAPPDATA%\\StudyLibrary, or $STUDY_HOME:
  repo\\               a git checkout that follows origin/production
  repo\\backend\\.env   the processor's settings, as in WSL
  .env                 settings saved by "Connect this computer", read last
  .venv\\              the Python environment
  tessdata\\           eng, fra, deu and osd for Tesseract
  models\\kokoro\\      the Kokoro ONNX model and voices
  logs\\               desktop.log, processor.log and tts.log
backend/setup-windows.ps1 builds all of it.
"""

from __future__ import annotations

import argparse
import json
import logging
import logging.handlers
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from study import update

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
# "Connect this computer": the link scheme and the three settings it carries.
# The launcher keeps its own copies of the first two, and a test holds them equal.
CONNECT_SCHEME = "studylibrary"
CONNECT_KEYS = ("PROCESSOR_KEY", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET")
CONNECT_HINT = "connect=processor"
CONNECT_VERSION = "1"
CONNECT_TIMEOUT_SECONDS = 15
# Marks the address the desktop window opens, so that the app knows before its
# first render that it has a window of its own. A user agent cannot carry the
# mark here: Edge hands a second launch's switches to the Edge already running,
# which ignores --user-agent, and when the switch did apply it would change the
# user agent of every Edge tab, not this window's alone.
SHELL_HINT = "sl=desktop"
# Desktop Window Manager attributes for the native frame. Windows 11 honours
# all three, whereas Windows 10 accepts only the first and refuses the colours,
# which is logged and otherwise ignored.
DWMWA_USE_IMMERSIVE_DARK_MODE = 20
DWMWA_BORDER_COLOR = 34
DWMWA_CAPTION_COLOR = 35
# The warm paper of the app's light page. STUDY_TITLE_BAR_COLOUR in either
# .env file replaces it, for an appearance whose background differs.
TITLE_BAR_COLOUR = "#FAF8F5"
# How long the launcher looks for the new window before giving up, which
# delays nothing the person sees, because the launcher has no window of its own.
TITLE_BAR_WAIT_SECONDS = 10.0
# Chromium sets the frame's dark mode itself once the page first paints, so
# the attributes are set a second time after this pause.
TITLE_BAR_REPAINT_SECONDS = 1.5
EDGE_WINDOW_CLASS = "Chrome_WidgetWin_1"


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
    with the .env files on top, and the tools winget installed put first on
    PATH, because the Tesseract and Ghostscript installers do not add themselves."""
    home = Path(home)
    env = _settings(home, base)
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


def env_files(home: Path) -> tuple[Path, Path]:
    """The two settings files in the order they are read: the checkout's, then
    the home folder's, which wins because "Connect this computer" writes it."""
    home = Path(home)
    return home / "repo" / "backend" / ".env", home / ".env"


def _settings(home: Path, base: Mapping[str, str] | None = None) -> dict[str, str]:
    env = dict(os.environ if base is None else base)
    for path in env_files(home):
        env.update(load_env_file(path))
    return env


def settings_stamp(home: Path) -> tuple:
    """Changes whenever either settings file is created, edited or removed, so
    the supervisor can tell that its children need restarting."""
    stamp = []
    for path in env_files(home):
        try:
            info = path.stat()
            stamp.append((info.st_mtime_ns, info.st_size))
        except OSError:
            stamp.append(None)
    return tuple(stamp)


class ConnectError(ValueError):
    """A connect link or its credentials were refused. The message is safe to
    show and to log, because it never contains a value from the link."""


# One to 512 printable ASCII characters, without space, quotes or "#", so that
# a value is the same whether a person, Notepad or load_env_file reads it.
_CONNECT_VALUE = re.compile(r"[\x21\x24-\x26\x28-\x7e]{1,512}")
_CONNECT_LINK = re.compile(rf"{CONNECT_SCHEME}:(?://)?([^?#]*)\?(.*)", re.IGNORECASE)


def parse_connect_link(link: str) -> dict[str, str]:
    """The three settings in a studylibrary://connect?v=1&... link. Anything
    unexpected refuses the whole link: another scheme or path, another version,
    a missing, repeated or extra setting, or a value that is not plain ASCII."""
    refused = ConnectError("This is not a valid connect link.")
    match = _CONNECT_LINK.fullmatch(link.strip())
    if not match or match.group(1).strip("/") != "connect":
        raise refused
    try:
        pairs = urllib.parse.parse_qsl(match.group(2), keep_blank_values=True, strict_parsing=True, errors="strict")
    except ValueError:
        raise refused from None
    if sorted(key for key, _ in pairs) != sorted(("v", *CONNECT_KEYS)):
        raise refused
    found = dict(pairs)
    if found["v"] != CONNECT_VERSION:
        raise ConnectError("This connect link comes from a different version of Study Library.")
    if not all(_CONNECT_VALUE.fullmatch(found[key]) for key in CONNECT_KEYS):
        raise refused
    return {key: found[key] for key in CONNECT_KEYS}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Cloudflare Access answers an unknown token with a redirect to its login
    page, and following it would carry the headers somewhere else."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


def _ping(url: str, headers: Mapping[str, str]) -> Any:
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "StudyLibrary-desktop", **headers})
    with urllib.request.build_opener(_NoRedirect()).open(request, timeout=CONNECT_TIMEOUT_SECONDS) as response:
        return json.loads(response.read(65536))


def check_credentials(study_url: str, values: Mapping[str, str], ping: Callable[[str, Mapping[str, str]], Any] = _ping) -> None:
    """Asks this installation's own STUDY_URL, and nowhere else, whether the
    credentials are accepted. Nothing is sent unless STUDY_URL is an https address."""
    parts = urllib.parse.urlsplit(study_url or "")
    if parts.scheme != "https" or not parts.hostname:
        raise ConnectError("STUDY_URL is not set to an https address, so the credentials cannot be checked.")
    url = f"https://{parts.netloc.rpartition('@')[2]}/api/ping"
    headers = {"CF-Access-Client-Id": values["CF_ACCESS_CLIENT_ID"], "CF-Access-Client-Secret": values["CF_ACCESS_CLIENT_SECRET"]}
    try:
        answer = ping(url, headers)
    except urllib.error.HTTPError:
        raise ConnectError("Study Library refused these credentials.") from None
    except OSError:
        raise ConnectError("Study Library could not be reached to check the credentials.") from None
    except ValueError:
        raise ConnectError("Study Library gave an answer that was not understood.") from None
    if not isinstance(answer, dict) or answer.get("ok") is not True:
        raise ConnectError("Study Library did not accept these credentials.")


def merge_env_text(text: str, values: Mapping[str, str]) -> str:
    """The .env text with each setting in values written once, in place of its
    first line, with any repeats dropped and any missing ones added at the end.
    Comments and every other line stay exactly as they were."""
    lines: list[str] = []
    written: set[str] = set()
    for raw in text.splitlines():
        line = raw.strip()
        if line and not line.startswith("#"):
            if line.startswith("export "):
                line = line[len("export "):].lstrip()
            key = line.partition("=")[0].strip()
            if key in values:
                if key not in written:
                    written.add(key)
                    lines.append(f"{key}={values[key]}")
                continue
        lines.append(raw)
    lines.extend(f"{key}={value}" for key, value in values.items() if key not in written)
    return "\n".join(lines) + "\n"


def _write_atomic(path: Path, text: str) -> None:
    handle, name = tempfile.mkstemp(dir=path.parent, prefix=".env.", suffix=".tmp")
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="") as out:
            out.write(text)
            out.flush()
            os.fsync(out.fileno())
        os.replace(name, path)
    except BaseException:
        Path(name).unlink(missing_ok=True)
        raise


def connect(home: Path, link: str, ping: Callable[[str, Mapping[str, str]], Any] = _ping) -> Path:
    """Checks the link's credentials against this installation's STUDY_URL and,
    only if they are accepted, saves them to the .env in the home folder. A
    refused link or a failed write leaves the existing file as it was."""
    home = Path(home)
    values = parse_connect_link(link)
    check_credentials(_settings(home).get("STUDY_URL", ""), values, ping)
    home.mkdir(parents=True, exist_ok=True)
    path = home / ".env"
    try:
        text = path.read_text(encoding="utf-8-sig")
    except FileNotFoundError:
        text = ""
    _write_atomic(path, merge_env_text(text, values))
    return path


def _with_query(url: str, part: str) -> str:
    """The address with part added to its query, ahead of any fragment."""
    base, hash_, fragment = url.partition("#")
    return f"{base}{'&' if '?' in base else '?'}{part}{hash_}{fragment}"


def window_url(url: str, env: Mapping[str, str]) -> str:
    """The address to open, with the hint that makes the app offer to connect
    this computer for as long as any of the three settings is missing."""
    if all(env.get(key) for key in CONNECT_KEYS):
        return url
    return _with_query(url, CONNECT_HINT)


def desktop_url(url: str) -> str:
    """The address for the desktop window, marked so that the app shows its
    tabs and keeps the window's title bar the colour of its own background."""
    return _with_query(url, SHELL_HINT)


def _notify(text: str, error: bool = False) -> None:
    """Says the outcome of --connect, which runs under pythonw with no console."""
    (log.error if error else log.info)("%s", text)
    if WINDOWS:
        import ctypes

        ctypes.windll.user32.MessageBoxW(None, text, "Study Library", 0x10 if error else 0x40)


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


def colorref(colour: str) -> int:
    """A "#RRGGBB" colour as the 0x00BBGGRR COLORREF that DWM reads, so that
    red sits in the lowest byte rather than the highest."""
    value = colour.strip().lstrip("#")
    if not re.fullmatch(r"[0-9A-Fa-f]{6}", value):
        raise ValueError(f"{colour!r} is not a #RRGGBB colour")
    red, green, blue = (int(value[i:i + 2], 16) for i in (0, 2, 4))
    return red | green << 8 | blue << 16


def app_window(before: Mapping[int, tuple[str, str]], now: Mapping[int, tuple[str, str]]) -> int | None:
    """The Edge app window that has appeared since before, given each visible
    top-level window's class and title. An ordinary Edge window is passed
    over, because its title ends in "Microsoft Edge" whereas an --app
    window's is the page's alone, and one with no title yet is waited for."""
    for handle, (cls, title) in now.items():
        if handle in before or cls != EDGE_WINDOW_CLASS or not title.strip():
            continue
        if title.rstrip().endswith("Microsoft Edge"):
            continue
        return handle
    return None


def _visible_windows() -> dict[int, tuple[str, str]]:
    """Every visible top-level window, by handle, with its class and title."""
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    enum_proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows.argtypes = [enum_proc, wintypes.LPARAM]
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    found: dict[int, tuple[str, str]] = {}

    def visit(handle, _lparam):  # noqa: ANN001
        if handle and user32.IsWindowVisible(handle):
            cls = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(handle, cls, len(cls))
            size = user32.GetWindowTextLengthW(handle) + 1
            title = ctypes.create_unicode_buffer(size)
            user32.GetWindowTextW(handle, title, size)
            found[int(handle)] = (cls.value, title.value)
        return True

    user32.EnumWindows(enum_proc(visit), 0)
    return found


def _paint_frame(handle: int, colour: str) -> None:
    """Asks DWM for light caption buttons and for the caption and border in
    colour. An attribute this version of Windows does not know is refused,
    which is logged and otherwise left alone."""
    import ctypes
    from ctypes import wintypes

    dwmapi = ctypes.windll.dwmapi
    dwmapi.DwmSetWindowAttribute.argtypes = [wintypes.HWND, wintypes.DWORD, wintypes.LPCVOID, wintypes.DWORD]
    dwmapi.DwmSetWindowAttribute.restype = ctypes.c_long
    paper = wintypes.DWORD(colorref(colour))
    attributes = ((DWMWA_USE_IMMERSIVE_DARK_MODE, wintypes.BOOL(0)), (DWMWA_BORDER_COLOR, paper),
                  (DWMWA_CAPTION_COLOR, paper))
    for attribute, value in attributes:
        result = dwmapi.DwmSetWindowAttribute(handle, attribute, ctypes.byref(value), ctypes.sizeof(value))
        if result:
            log.debug("DWM refused attribute %s with %#x", attribute, result & 0xFFFFFFFF)


def recolour_title_bar(
    before: Mapping[int, tuple[str, str]],
    colour: str = TITLE_BAR_COLOUR,
    wait_seconds: float = TITLE_BAR_WAIT_SECONDS,
    windows: Callable[[], Mapping[int, tuple[str, str]]] = _visible_windows,
    paint: Callable[[int, str], None] = _paint_frame,
    sleep: Callable[[float], None] = time.sleep,
) -> bool:
    """Waits for the window Edge has just opened and colours its frame, twice,
    because Chromium resets the frame's dark mode when the page first paints.
    False when the window never appears or Windows refuses, which leaves the
    window exactly as Edge drew it."""
    deadline = time.monotonic() + wait_seconds
    try:
        colorref(colour)
        while True:
            handle = app_window(before, windows())
            if handle is not None:
                paint(handle, colour)
                sleep(TITLE_BAR_REPAINT_SECONDS)
                paint(handle, colour)
                return True
            if time.monotonic() >= deadline:
                log.info("the Study Library window did not appear, so its title bar keeps Edge's colours")
                return False
            sleep(0.2)
    except (OSError, AttributeError, ValueError) as error:
        log.warning("could not colour the title bar: %s", error)
        return False


def open_window(url: str, colour: str = TITLE_BAR_COLOUR) -> None:
    """Study Library in its own Edge window, in the Edge profile that already
    holds its Access sign-in, offline copy and service worker, or in the
    default browser when there is no Edge. Edge paints most of the frame
    itself from the page's theme colour, which the app keeps equal to its own
    background, but DWM still decides the caption buttons' scheme and the
    border, and the caption too wherever Edge leaves it to DWM, so once the
    new window appears those are set to the paper colour as well."""
    edge = _edge() if WINDOWS else None
    if not edge:
        webbrowser.open(url)
        return
    try:
        before: Mapping[int, tuple[str, str]] | None = _visible_windows()
    except (OSError, AttributeError) as error:
        log.warning("could not list the open windows, so the title bar keeps Edge's colours: %s", error)
        before = None
    subprocess.Popen([edge, f"--app={url}"], creationflags=DETACHED_PROCESS)
    if before is not None:
        recolour_title_bar(before, colour)


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


def _child_environment(home: Path) -> dict[str, str]:
    env = prepare_environment(home)
    env["PROCESSOR_STOP_FILE"] = str(_stop_file(home))
    return env


def supervise(home: Path) -> int:
    """Keeps the processor and speech server running, restarts either if it
    exits, restarts both when a settings file changes, and moves to new code
    every six hours."""
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
    stamp = settings_stamp(home)
    env = _child_environment(home)
    now = time.monotonic()
    children = {name: _Child(name, _start(home, env, name), now) for name in COMMANDS}
    log.info("started the processor and the speech server")
    next_update = now + UPDATE_SECONDS
    while True:
        if settings_stamp(home) != stamp:
            # Taken before the settings are read, so that an edit made in
            # between is noticed on the next tick instead of being lost.
            stamp = settings_stamp(home)
            log.info("the settings changed; restarting the processor and the speech server")
            _stop_children(home, children)
            env = _child_environment(home)
            now = time.monotonic()
            children = {name: _Child(name, _start(home, env, name), now) for name in COMMANDS}
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


def _run_connect(home: Path, link: str) -> int:
    """What the studylibrary:// link handler runs. Exits 0 once saved, 2 when
    the link or its credentials are refused, and 1 when the file cannot be written."""
    try:
        connect(home, link)
    except ConnectError as error:
        log.warning("connect refused: %s", error)
        _notify(f"Study Library could not connect this computer. {error}", error=True)
        return 2
    except OSError:
        log.exception("connect could not save the settings")
        _notify("Study Library could not save the settings, so this computer is not connected yet.", error=True)
        return 1
    log.info("connected this computer")
    _notify("This computer is connected to Study Library. It starts using the new settings within a few seconds.")
    return 0


def main(argv: list[str] | None = None) -> int:
    if (code := update.route(argv, _notify)) is not None:
        return code
    parser = argparse.ArgumentParser(prog="python -m study.desktop")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--headless", action="store_true", help="Run the processor and speech server, with no window")
    mode.add_argument("--app-only", action="store_true", help="Open the window only")
    mode.add_argument("--once", action="store_true", help="Work through the queue in this window, then exit")
    mode.add_argument("--connect", metavar="LINK", help="Check and save the credentials in a studylibrary:// link")
    args = parser.parse_args(argv)
    home = default_home()
    (home / "logs").mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s %(message)s",
        handlers=[logging.handlers.RotatingFileHandler(home / "logs" / "desktop.log", maxBytes=1_000_000,
                                                       backupCount=1, encoding="utf-8")],
    )
    if args.connect is not None:
        return _run_connect(home, args.connect)
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
    env = prepare_environment(home)
    url = env.get("STUDY_URL")
    if not url:
        log.error("STUDY_URL is not set in %s or %s", *env_files(home))
        return 1
    open_window(desktop_url(window_url(url, env)), env.get("STUDY_TITLE_BAR_COLOUR") or TITLE_BAR_COLOUR)
    return 0


if __name__ == "__main__":
    sys.exit(main())
