"""Study Library on Windows, without WSL or Task Scheduler.

From the Start menu or desktop shortcut:  pythonw -m study.desktop
  starts the processor and the Listen speech server if they are not already
  running, then opens Study Library in a frameless WebView2 window through
  pywebview, at an address marked ?sl=frameless so that the app draws its tabs
  and the window controls on one row of its own. Without pywebview it opens an
  Edge window instead, marked ?sl=desktop, whose native frame is coloured to
  match through DWM once the window appears. When the frameless window lands
  on the Cloudflare Access sign-in page, the person signs in through their
  usual browser, which hands the Access cookie back to the window.
From the Startup folder, at sign-in:      pythonw -m study.desktop --headless
  the same with no window; this process stays on as their supervisor.
--app-only opens the window only. --once works through the queue in the
foreground and exits, for a terminal.
--connect LINK is what the studylibrary:// link handler runs for "Connect this
computer": it checks the three credentials in the link against STUDY_URL and
only then saves them to the .env in the home folder, which the supervisor
notices and restarts its children for. A studylibrary://open?path=... link,
given there or on its own, opens the app at that path instead, or hands the
path to the window that is already open, which comes to the front and goes there.

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
import base64
import hmac
import http.server
import json
import logging
import logging.handlers
import os
import re
import secrets
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
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
# Marks the frameless pywebview window, whose page draws the window controls
# itself because the window has no frame to carry them.
FRAMELESS_HINT = "sl=frameless"
# The smallest size at which the top bar and the tabs still fit on their rows.
WINDOW_MIN_SIZE = (860, 600)
WINDOW_SIZE = (1280, 840)
# The Cloudflare Access sign-in handoff: the browser posts the cookie to this
# path on a one-shot listener, which gives up after this long.
ACCESS_COOKIE = "CF_Authorization"
SIGN_IN_PATH = "/auth-callback"
SIGN_IN_TIMEOUT_SECONDS = 5 * 60
SIGN_IN_BODY_LIMIT = 16384
_ACCESS_TOKEN = re.compile(r"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")
# The launcher puts the desktop user agent in the WebView2 arguments, and it is
# read back from there because pywebview sets its own arguments on the control,
# which may take the place of the environment's.
_USER_AGENT_ARGUMENT = re.compile(r'--user-agent="([^"]+)"')
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
# Win32 styles, messages and hit-test codes for the frameless window, which
# keeps the styles of a framed one so that Aero Snap, resizing, the system
# menu and the taskbar all treat it as a normal window.
GWL_STYLE = -16
GWLP_WNDPROC = -4
WS_THICKFRAME = 0x00040000
WS_MINIMIZEBOX = 0x00020000
WS_MAXIMIZEBOX = 0x00010000
WS_SYSMENU = 0x00080000
NATIVE_FRAME_STYLES = WS_THICKFRAME | WS_MAXIMIZEBOX | WS_MINIMIZEBOX | WS_SYSMENU
WM_WINDOWPOSCHANGING = 0x0046
WM_STYLECHANGING = 0x007C
WM_NCDESTROY = 0x0082
WM_NCCALCSIZE = 0x0083
WM_NCHITTEST = 0x0084
MONITOR_DEFAULTTONEAREST = 0x00000002
SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_FRAME_ONLY = SWP_NOSIZE | SWP_NOMOVE | 0x0004 | 0x0010 | 0x0020  # NOZORDER, NOACTIVATE, FRAMECHANGED
SW_RESTORE = 9
SM_CXSIZEFRAME = 32
SM_CXPADDEDBORDER = 92
HTNOWHERE = 0
HTCLIENT = 1
HTLEFT = 10
HTRIGHT = 11
HTTOP = 12
HTTOPLEFT = 13
HTTOPRIGHT = 14
HTBOTTOM = 15
HTBOTTOMLEFT = 16
HTBOTTOMRIGHT = 17
# The window procedure of each frameless window, kept here because Windows
# holds only its address, and a callback that Python collects would crash it.
_FRAME_HOOKS: dict[int, Any] = {}
# One frameless window per Windows user listens for the open links that later
# launches hand it, at the port and secret it writes to this file in the home folder.
WINDOW_MUTEX_NAME = "Local\\StudyLibraryWindowMutex"
WINDOW_FILE = "window.json"
LINK_TIMEOUT_SECONDS = 5
LINK_MESSAGE_LIMIT = 8192
OPEN_PATH_LIMIT = 2048
# Characters that keep their meaning in an app path, so that its query and
# fragment survive, whereas everything else, "%" included, is percent-encoded.
_OPEN_PATH_SAFE = "/?#&=:@!$'()*+,;~"


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


def safe_app_path(path: str) -> str:
    """The path as an address within the app, percent-encoded so that it can
    follow STUDY_URL's host as it is, or "/" for anything that could leave the
    app or confuse its router: no leading "/", a "//" or "\\" that a browser
    reads as another host, a ".." segment, a control character, or more than
    OPEN_PATH_LIMIT characters."""
    if (not isinstance(path, str) or not path.startswith("/") or path.startswith("//") or "\\" in path
            or len(path) > OPEN_PATH_LIMIT or any(ord(c) < 0x20 or ord(c) == 0x7F for c in path)
            or ".." in urllib.parse.urlsplit(path).path.split("/")):
        return "/"
    return urllib.parse.quote(path, safe=_OPEN_PATH_SAFE)


_APP_LINK = re.compile(rf"{CONNECT_SCHEME}:(?://)?([^?#]*)(.*)", re.IGNORECASE | re.DOTALL)


def parse_open_link(link: str) -> str | None:
    """The app path that a studylibrary://open?path=... link asks for, or None
    when the link is not an open link at all, so that the caller can treat it
    as a connect link instead. A missing, repeated or unsafe path opens the
    app's home page, "/", rather than refusing the link."""
    match = _APP_LINK.fullmatch(link.strip())
    if not match or match.group(1).strip("/") != "open":
        return None
    rest = match.group(2)
    paths = [value for key, value in urllib.parse.parse_qsl(rest[1:] if rest.startswith("?") else "",
                                                            keep_blank_values=True) if key == "path"]
    return safe_app_path(paths[0]) if len(paths) == 1 else "/"


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
    handle, name = tempfile.mkstemp(dir=path.parent, prefix=f"{path.name}.", suffix=".tmp")
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


def desktop_url(url: str, frameless: bool = False) -> str:
    """The address for the desktop window, marked so that the app shows its
    tabs and keeps the window's title bar the colour of its own background,
    and, in the frameless window, draws the window controls beside the tabs."""
    return _with_query(url, FRAMELESS_HINT if frameless else SHELL_HINT)


def open_url(url: str, path: str) -> str:
    """STUDY_URL with its path replaced by an app path from safe_app_path, or
    STUDY_URL itself for the home page, so that a plain launch opens exactly
    the address it always has."""
    return url if path == "/" else urllib.parse.urljoin(url, path)


def app_address(url: str, path: str, env: Mapping[str, str], frameless: bool) -> str:
    """The address a desktop window opens for an app path, carrying the
    connect hint while this computer is not connected and the mark for the
    kind of window, ahead of any fragment the path has."""
    return desktop_url(window_url(open_url(url, path), env), frameless=frameless)


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


def is_access_login(url: str) -> bool:
    """Whether the window shows Cloudflare Access's sign-in page, which lives
    on the team domain or under /cdn-cgi/access/login on the app's own host."""
    parts = urllib.parse.urlsplit(url or "")
    host = (parts.hostname or "").lower()
    return host == "cloudflareaccess.com" or host.endswith(".cloudflareaccess.com") or parts.path.startswith("/cdn-cgi/access/login")


def sign_in_url(app_url: str, port: int, state: str) -> str | None:
    """The address that sends the browser's Access session back to this
    computer, or None unless the app is an https address, since the Worker
    route only exists behind Access."""
    parts = urllib.parse.urlsplit(app_url or "")
    if parts.scheme != "https" or not parts.hostname:
        return None
    query = urllib.parse.urlencode({"port": port, "state": state})
    return f"https://{parts.netloc.rpartition('@')[2]}/api/desktop-auth?{query}"


def access_cookie_expiry(token: str) -> int | None:
    """When the Access token expires, from its exp claim, so that the cookie
    outlasts a restart of the window. None when the claim cannot be read, which
    leaves the cookie for this session alone."""
    try:
        payload = token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        expiry = int(claims["exp"])
    except (IndexError, KeyError, TypeError, ValueError):
        return None
    return expiry if expiry > time.time() else None


def listen_for_sign_in(
    on_token: Callable[[str], None],
    timeout: float = SIGN_IN_TIMEOUT_SECONDS,
    on_close: Callable[[], None] | None = None,
) -> tuple[int, str]:
    """Starts a one-shot listener on 127.0.0.1 for the form that /api/desktop-auth
    posts, and returns its port and the state the form must carry back. Only a
    post with that state and a well-formed token is accepted, after which, or
    once timeout passes, the listener closes and on_close runs. Nothing it
    receives is logged, because the token is a live sign-in."""
    state = secrets.token_urlsafe(24)
    done = threading.Event()

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, format, *args):  # noqa: A002, ANN001 - the request line is not worth a log
            pass

        def _answer(self, code: int, text: str) -> None:
            body = (f"<!doctype html><meta charset=utf-8><title>Study Library</title>"
                    f"<p style=\"font:16px system-ui;margin:3rem\">{text}</p>").encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802 - the name http.server calls
            self._answer(405, "This address only accepts the sign-in that Study Library sends it.")

        def do_POST(self) -> None:  # noqa: N802 - the name http.server calls
            if urllib.parse.urlsplit(self.path).path != SIGN_IN_PATH:
                self._answer(404, "This address only accepts the sign-in that Study Library sends it.")
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            if not 0 < length <= SIGN_IN_BODY_LIMIT:
                self._answer(400, "The sign-in could not be read, so please try again from Study Library.")
                return
            fields = urllib.parse.parse_qs(self.rfile.read(length).decode("ascii", "replace"))
            token, given = fields.get("cf_auth", []), fields.get("state", [])
            if (len(token) != 1 or len(given) != 1 or not hmac.compare_digest(given[0], state)
                    or not _ACCESS_TOKEN.fullmatch(token[0])):
                self._answer(400, "This sign-in was not the one Study Library asked for, so it was ignored.")
                return
            self._answer(200, "You are signed in, so you can close this tab and go back to Study Library.")
            done.set()
            try:
                on_token(token[0])
            except Exception:  # noqa: BLE001 - the listener must still close
                log.exception("the sign-in could not be passed to the window")

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    server.timeout = 0.5

    def serve() -> None:
        deadline = time.monotonic() + timeout
        try:
            while not done.is_set() and time.monotonic() < deadline:
                server.handle_request()
        finally:
            server.server_close()
            if on_close:
                on_close()

    threading.Thread(target=serve, name="sign-in", daemon=True).start()
    return server.server_address[1], state


def set_access_cookie(window: Any, host: str, token: str) -> bool:
    """Puts the Access cookie into the window's WebView2 cookie store for the
    app's host, on the window's own thread, as WebView2 requires. False when
    the control cannot be reached, which leaves the sign-in page as it was."""
    import System  # pythonnet, which pywebview has loaded by now

    form = window.native
    control = form.browser.webview
    expiry = access_cookie_expiry(token)
    added: list[bool] = []

    def add() -> None:
        try:
            manager = control.CoreWebView2.CookieManager
            cookie = manager.CreateCookie(ACCESS_COOKIE, token, host, "/")
            cookie.IsSecure = True
            cookie.IsHttpOnly = True
            if expiry:
                try:
                    cookie.Expires = System.DateTimeOffset.FromUnixTimeSeconds(expiry).UtcDateTime
                except Exception:  # noqa: BLE001 - a session cookie still signs the window in
                    log.debug("the Access cookie keeps no expiry", exc_info=True)
            manager.AddOrUpdateCookie(cookie)
            added.append(True)
        except Exception:  # noqa: BLE001 - raised on the UI thread, reported below
            log.warning("WebView2 refused the Access cookie", exc_info=True)

    form.Invoke(System.Func[System.Type](add))
    return bool(added)


class SignInHandoff:
    """Lets a person sign in to Cloudflare Access in their usual browser, where
    they are usually signed in already, instead of in the window's own profile.
    When the window lands on the sign-in page, a one-shot listener starts, the
    browser opens /api/desktop-auth, which posts the Access cookie back to the
    listener, and the window takes the cookie and returns to the app."""

    def __init__(
        self,
        window: Any,
        app_url: str,
        listen: Callable[..., tuple[int, str]] = listen_for_sign_in,
        open_browser: Callable[[str], bool] = webbrowser.open,
        set_cookie: Callable[[Any, str, str], bool] = set_access_cookie,
    ):
        self._window = window
        self._app_url = app_url
        self._host = urllib.parse.urlsplit(app_url).hostname or ""
        self._listen = listen
        self._open = open_browser
        self._set_cookie = set_cookie
        # Held while a listener is open, so a reload of the sign-in page never opens a second browser tab.
        self._busy = threading.Lock()

    def on_loaded(self) -> None:
        if is_access_login(self._window.get_current_url() or ""):
            self.start()

    def start(self) -> bool:
        if not self._host or not self._busy.acquire(blocking=False):
            return False
        try:
            port, state = self._listen(self._receive, on_close=self._busy.release)
        except OSError as error:
            self._busy.release()
            log.warning("could not listen for the browser sign-in: %s", error)
            return False
        address = sign_in_url(self._app_url, port, state)
        if address is None or not self._open(address):
            log.info("the browser sign-in was not started, so the window's own sign-in page stays")
            return False
        log.info("opened the browser to sign in to Cloudflare Access")
        return True

    def _receive(self, token: str) -> None:
        if self._set_cookie(self._window, self._host, token):
            log.info("signed the window in with the browser's Access session")
            self._window.load_url(self._app_url)


class WindowApi:
    """What the page reaches as window.pywebview.api, for the window controls it
    draws beside the tabs. pywebview hides every name that starts with an
    underscore from the page, which is where the window itself is kept."""

    def __init__(self) -> None:
        self._window: Any = None
        self._maximised = False

    def _bind(self, window: Any) -> None:
        self._window = window
        window.events.maximized += self._on_maximised
        window.events.restored += self._on_restored

    def _on_maximised(self) -> None:
        self._maximised = True

    def _on_restored(self) -> None:
        self._maximised = False

    def minimize(self) -> None:
        self._window.minimize()

    def toggle_maximize(self) -> bool:
        """Maximises the window or restores it, and returns whether it is now maximised."""
        target = not self._maximised
        self._maximised = target
        if target:
            self._window.maximize()
        else:
            self._window.restore()
        return target

    def is_maximized(self) -> bool:
        return self._maximised

    def close(self) -> None:
        self._window.destroy()

    def open_in_browser(self, url: str) -> bool:
        """Opens an http or https address in the default browser. Any other
        scheme is refused, because the page must never start a program."""
        if not isinstance(url, str) or urllib.parse.urlsplit(url).scheme not in ("http", "https"):
            return False
        return bool(webbrowser.open(url))


def point_from_lparam(lparam: int) -> tuple[int, int]:
    """The screen point in a mouse message's lParam, read as GET_X_LPARAM and
    GET_Y_LPARAM read it, so that a monitor to the left of or above the
    primary one gives negative coordinates rather than large positive ones."""
    x, y = lparam & 0xFFFF, (lparam >> 16) & 0xFFFF
    return x - 0x10000 if x & 0x8000 else x, y - 0x10000 if y & 0x8000 else y


def inset_rect(rect: tuple[int, int, int, int], border: int) -> tuple[int, int, int, int]:
    left, top, right, bottom = rect
    return left + border, top + border, right - border, bottom - border


def maximised_rect(work: tuple[int, int, int, int], border: int) -> tuple[int, int, int, int]:
    """The screen rectangle of a maximised window whose page fills the
    monitor's work area exactly. The window reaches past the work area by the
    resize border on every side, as a framed window does, because
    WM_NCCALCSIZE takes that border back off a maximised window, so the page
    never covers the taskbar and loses no pixels at the screen's edges."""
    return inset_rect(work, -border)


def hit_test(x: int, y: int, rect: tuple[int, int, int, int], border: int, zoomed: bool) -> int:
    """The WM_NCHITTEST answer for a screen point: an edge or corner within
    the resize border of a window that is not maximised, since a maximised
    window cannot be resized from its edges, and otherwise HTCLIENT, so that
    the page receives the mouse as it always has."""
    left, top, right, bottom = rect
    if not (left <= x < right and top <= y < bottom):
        return HTNOWHERE
    if zoomed:
        return HTCLIENT
    column = 0 if x < left + border else 2 if x >= right - border else 1
    row = 0 if y < top + border else 2 if y >= bottom - border else 1
    return ((HTTOPLEFT, HTTOP, HTTOPRIGHT), (HTLEFT, HTCLIENT, HTRIGHT),
            (HTBOTTOMLEFT, HTBOTTOM, HTBOTTOMRIGHT))[row][column]


def install_native_frame(hwnd: int) -> bool:
    """Gives the frameless window back the styles of a framed one and
    subclasses its window procedure so that the whole window stays the page's
    client area, the edges and corners resize it, and maximising fills the
    monitor's work area alone. Runs on the window's own thread. False, leaving
    the window exactly as pywebview made it, when Windows refuses the subclass."""
    import ctypes
    from ctypes import wintypes

    class WINDOWPOS(ctypes.Structure):
        _fields_ = [("hwnd", wintypes.HWND), ("hwndInsertAfter", wintypes.HWND), ("x", ctypes.c_int), ("y", ctypes.c_int),
                    ("cx", ctypes.c_int), ("cy", ctypes.c_int), ("flags", wintypes.UINT)]

    class MONITORINFO(ctypes.Structure):
        _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT), ("rcWork", wintypes.RECT),
                    ("dwFlags", wintypes.DWORD)]

    class NCCALCSIZE_PARAMS(ctypes.Structure):  # noqa: N801 - the Win32 name
        _fields_ = [("rgrc", wintypes.RECT * 3), ("lppos", ctypes.c_void_p)]

    class STYLESTRUCT(ctypes.Structure):
        _fields_ = [("styleOld", wintypes.DWORD), ("styleNew", wintypes.DWORD)]

    # A private copy of user32, so that the prototypes set here never change
    # how pywebview's own calls into the same functions are converted.
    user32 = ctypes.WinDLL("user32")
    long_ptr = ctypes.c_ssize_t
    get_long = getattr(user32, "GetWindowLongPtrW", None) or user32.GetWindowLongW
    set_long = getattr(user32, "SetWindowLongPtrW", None) or user32.SetWindowLongW
    get_long.argtypes, get_long.restype = [wintypes.HWND, ctypes.c_int], long_ptr
    set_long.argtypes, set_long.restype = [wintypes.HWND, ctypes.c_int, long_ptr], long_ptr
    user32.CallWindowProcW.argtypes = [ctypes.c_void_p, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    user32.CallWindowProcW.restype = wintypes.LPARAM
    user32.IsZoomed.argtypes = [wintypes.HWND]
    user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    user32.MonitorFromRect.argtypes, user32.MonitorFromRect.restype = [ctypes.POINTER(wintypes.RECT), wintypes.DWORD], wintypes.HMONITOR
    user32.GetMonitorInfoW.argtypes = [wintypes.HMONITOR, ctypes.POINTER(MONITORINFO)]
    user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                    ctypes.c_int, wintypes.UINT]

    def border(handle: int) -> int:
        """The width of a framed window's resize border at this window's DPI."""
        try:
            dpi = user32.GetDpiForWindow(handle)
            return user32.GetSystemMetricsForDpi(SM_CXSIZEFRAME, dpi) + user32.GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi)
        except AttributeError:  # Windows 10 before 1607
            return user32.GetSystemMetrics(SM_CXSIZEFRAME) + user32.GetSystemMetrics(SM_CXPADDEDBORDER)

    def as_tuple(rect: wintypes.RECT) -> tuple[int, int, int, int]:
        return rect.left, rect.top, rect.right, rect.bottom

    failed: list[bool] = []

    def procedure(handle, message, wparam, lparam):  # noqa: ANN001, ANN202 - called by Windows
        try:
            if message == WM_NCCALCSIZE and wparam:
                if user32.IsZoomed(handle):
                    params = NCCALCSIZE_PARAMS.from_address(lparam)
                    params.rgrc[0] = wintypes.RECT(*inset_rect(as_tuple(params.rgrc[0]), border(handle)))
                return 0
            if message == WM_NCHITTEST:
                rect = wintypes.RECT()
                if user32.GetWindowRect(handle, ctypes.byref(rect)):
                    zone = hit_test(*point_from_lparam(lparam), as_tuple(rect), border(handle), bool(user32.IsZoomed(handle)))
                    if zone not in (HTCLIENT, HTNOWHERE):
                        return zone
            elif message == WM_WINDOWPOSCHANGING and user32.IsZoomed(handle):
                # Windows reads MINMAXINFO's maximised size as the primary monitor's and grows it on any larger
                # monitor, so the final rectangle is set here, once WinForms and Windows have applied their limits.
                result = user32.CallWindowProcW(previous, handle, message, wparam, lparam)
                pos = WINDOWPOS.from_address(lparam)
                if not pos.flags & SWP_NOSIZE:
                    proposed = wintypes.RECT(pos.x, pos.y, pos.x + pos.cx, pos.y + pos.cy)
                    monitor = user32.MonitorFromRect(ctypes.byref(proposed), MONITOR_DEFAULTTONEAREST)
                    info = MONITORINFO(cbSize=ctypes.sizeof(MONITORINFO))
                    if monitor and user32.GetMonitorInfoW(monitor, ctypes.byref(info)):
                        left, top, right, bottom = maximised_rect(as_tuple(info.rcWork), border(handle))
                        pos.x, pos.y, pos.cx, pos.cy = left, top, right - left, bottom - top
                        pos.flags &= ~SWP_NOMOVE
                return result
            elif message == WM_STYLECHANGING and wparam & 0xFFFFFFFF == GWL_STYLE & 0xFFFFFFFF:
                # WinForms rebuilds a borderless form's styles whenever it updates them, so they are kept here.
                result = user32.CallWindowProcW(previous, handle, message, wparam, lparam)
                STYLESTRUCT.from_address(lparam).styleNew |= NATIVE_FRAME_STYLES
                return result
            elif message == WM_NCDESTROY:
                # The callback stays in _FRAME_HOOKS, because Windows is still running it.
                set_long(handle, GWLP_WNDPROC, previous)
        except Exception:  # noqa: BLE001 - an error must never stop the window's messages
            if not failed:
                failed.append(True)
                log.exception("the native frame could not handle message %#x", message)
        return user32.CallWindowProcW(previous, handle, message, wparam, lparam)

    callback = ctypes.WINFUNCTYPE(wintypes.LPARAM, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)(procedure)
    _FRAME_HOOKS[hwnd] = callback
    previous = set_long(hwnd, GWLP_WNDPROC, ctypes.cast(callback, ctypes.c_void_p).value)
    if not previous:
        _FRAME_HOOKS.pop(hwnd, None)
        return False
    set_long(hwnd, GWL_STYLE, get_long(hwnd, GWL_STYLE) | NATIVE_FRAME_STYLES)
    user32.SetWindowPos(hwnd, None, 0, 0, 0, 0, SWP_FRAME_ONLY)
    return True


def adopt_native_frame(window: Any) -> int | None:
    """Installs the native frame on the pywebview window's form, on the form's
    own thread, and returns its window handle for bringing it to the front
    later. None when the form cannot be reached, which leaves the window as
    pywebview made it."""
    found: list[int] = []
    try:
        import System  # pythonnet, which pywebview has loaded by now

        form = window.native

        def install() -> None:
            found.append(int(form.Handle.ToInt64()))
            try:
                if not install_native_frame(found[0]):
                    log.warning("Windows refused the native frame, so the window keeps pywebview's frameless one")
            except Exception:  # noqa: BLE001 - raised on the UI thread, reported here
                log.warning("could not give the window a native frame", exc_info=True)

        form.Invoke(System.Func[System.Type](install))
    except Exception:  # noqa: BLE001 - the window still works without it
        log.warning("could not reach the window to give it a native frame", exc_info=True)
    return found[0] if found else None


def focus_window(hwnd: int | None) -> None:
    """Brings the window to the front, restoring it first if it is minimised.
    Windows allows this because the launch that forwarded the link, which the
    person has just started, handed its right to the foreground to this process."""
    if not WINDOWS or not hwnd:
        return
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32")
    user32.IsIconic.argtypes = [wintypes.HWND]
    user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.SetForegroundWindow.argtypes = [wintypes.HWND]
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, SW_RESTORE)
    user32.SetForegroundWindow(hwnd)


def _window_file(home: Path) -> Path:
    return Path(home) / WINDOW_FILE


def listen_for_links(home: Path, on_path: Callable[[str], None]) -> Callable[[], None]:
    """Listens on 127.0.0.1 for the app paths that later launches forward, and
    writes the port and a fresh secret to window.json in the home folder,
    which only this Windows user can read. A message without that secret is
    ignored, and every path is checked again before on_path sees it. Returns
    the function that stops listening and removes the file."""
    secret = secrets.token_urlsafe(24)

    class Handler(socketserver.StreamRequestHandler):
        timeout = LINK_TIMEOUT_SECONDS

        def handle(self) -> None:
            try:
                message = json.loads(self.rfile.readline(LINK_MESSAGE_LIMIT))
            except (OSError, ValueError):
                return
            given = message.get("secret") if isinstance(message, dict) else None
            if not isinstance(given, str) or not hmac.compare_digest(given.encode("utf-8"), secret.encode("ascii")):
                return
            path = message.get("path")
            try:
                self.wfile.write(b"ok\n")
                self.wfile.flush()
            except OSError:
                pass
            try:
                on_path(safe_app_path(path) if isinstance(path, str) else "/")
            except Exception:  # noqa: BLE001 - the listener must keep listening
                log.exception("the window could not go to a forwarded link")

    server = socketserver.TCPServer(("127.0.0.1", 0), Handler)
    try:
        _write_atomic(_window_file(home), json.dumps({"port": server.server_address[1], "secret": secret,
                                                       "pid": os.getpid()}))
    except BaseException:
        server.server_close()
        raise
    threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.5}, name="links", daemon=True).start()

    def stop() -> None:
        server.shutdown()
        server.server_close()
        _window_file(home).unlink(missing_ok=True)

    return stop


def forward_to_window(home: Path, path: str) -> bool:
    """Hands an app path to the window that is already open, which comes to
    the front and goes there. False when no window answers, so that the
    caller opens one of its own instead."""
    try:
        found = json.loads(_window_file(home).read_text(encoding="utf-8"))
        port, secret, pid = int(found["port"]), str(found["secret"]), int(found.get("pid") or 0)
        if WINDOWS and pid:
            import ctypes

            ctypes.windll.user32.AllowSetForegroundWindow(pid)
        with socket.create_connection(("127.0.0.1", port), timeout=LINK_TIMEOUT_SECONDS) as connection:
            connection.sendall(json.dumps({"secret": secret, "path": path}).encode("utf-8") + b"\n")
            with connection.makefile("rb") as reply:
                return reply.readline(16) == b"ok\n"
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return False


def webview_user_agent(env: Mapping[str, str]) -> str | None:
    """The desktop user agent that the launcher prepared for WebView2, if any."""
    match = _USER_AGENT_ARGUMENT.search(env.get("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", ""))
    return match.group(1) if match else None


def open_frameless(home: Path, url: str, colour: str = TITLE_BAR_COLOUR,
                   navigate: Callable[[str], str] | None = None) -> bool:
    """Study Library in a frameless WebView2 window, whose page draws its own
    tabs and window controls, kept open until the person closes it. Once it
    appears it takes on a native frame's behaviour through
    install_native_frame. The profile lives in the home folder, so the window
    keeps its Access sign-in, offline copy and service worker from one start
    to the next. When navigate is given, which main does while this process
    holds the window lock, the window also takes the open links that later
    launches forward, coming to the front at the address navigate gives for
    each path. False, before anything is shown, when this is not Windows,
    pywebview is missing or WebView2 cannot start, so that the caller can
    open Edge instead."""
    if not WINDOWS:
        return False
    try:
        import webview
    except ImportError:
        log.info("pywebview is not installed, so Study Library opens in Edge")
        return False
    try:
        colorref(colour)
    except ValueError:
        colour = TITLE_BAR_COLOUR
    shown = threading.Event()
    frame: list[int] = []
    stop_links: Callable[[], None] | None = None
    try:
        api = WindowApi()
        window = webview.create_window(
            "Study Library", url, js_api=api, width=WINDOW_SIZE[0], height=WINDOW_SIZE[1],
            min_size=WINDOW_MIN_SIZE, frameless=True, easy_drag=False, background_color=colour,
        )
        api._bind(window)  # noqa: SLF001 - kept private so the page cannot see it

        def adopt() -> None:
            hwnd = adopt_native_frame(window)
            if hwnd:
                frame.append(hwnd)

        window.events.shown += shown.set
        window.events.shown += adopt
        window.events.loaded += SignInHandoff(window, url).on_loaded
        if navigate is not None:
            def on_link(path: str) -> None:
                focus_window(frame[0] if frame else None)
                window.load_url(navigate(path))

            try:
                stop_links = listen_for_links(home, on_link)
            except OSError as error:
                log.warning("could not listen for open links, so each one opens a window of its own: %s", error)
        log.info("opening the frameless window through pywebview %s", getattr(webview, "__version__", "unknown"))
        webview.start(gui="edgechromium", private_mode=False, storage_path=str(Path(home) / "webview"),
                      user_agent=webview_user_agent(os.environ))
    except Exception:  # noqa: BLE001 - any failure before the window shows falls back to Edge
        log.exception("the frameless window could not run")
    finally:
        if stop_links is not None:
            stop_links()
    return shown.is_set()


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
    parser.add_argument("link", nargs="?", help="A studylibrary:// link, as the link handler passes it")
    args = parser.parse_args(argv)
    home = default_home()
    (home / "logs").mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s %(message)s",
        handlers=[logging.handlers.RotatingFileHandler(home / "logs" / "desktop.log", maxBytes=1_000_000,
                                                       backupCount=1, encoding="utf-8")],
    )
    link = args.connect if args.connect is not None else args.link
    start_path = "/"
    if link is not None:
        opened = parse_open_link(link)
        if opened is None:
            return _run_connect(home, link)
        start_path = opened
    if args.once:
        return subprocess.call([_python(home), "-m", "study.processor", "--once"],
                               cwd=_workdir(home), env=prepare_environment(home))
    if args.headless:
        try:
            return supervise(home)
        except Exception:  # noqa: BLE001 - pythonw has nowhere else to say it
            log.exception("the supervisor stopped")
            return 1
    window_lock = acquire_single_instance(WINDOW_MUTEX_NAME)
    try:
        if window_lock is None and link is not None and forward_to_window(home, start_path):
            log.info("handed the link to the window that is already open")
            return 0
        if not args.app_only:
            # Exits at once if a supervisor is already running.
            _spawn_supervisor(home, handover=False)
        env = prepare_environment(home)
        url = env.get("STUDY_URL")
        if not url:
            log.error("STUDY_URL is not set in %s or %s", *env_files(home))
            return 1
        colour = env.get("STUDY_TITLE_BAR_COLOUR") or TITLE_BAR_COLOUR

        def navigate(path: str) -> str:
            # Read afresh, so that a link followed after connecting drops the connect hint.
            return app_address(url, path, _settings(home), frameless=True)

        if not open_frameless(home, app_address(url, start_path, env, frameless=True), colour,
                              navigate=navigate if window_lock is not None else None):
            edge = app_address(url, start_path, env, frameless=False)
            open_window(edge, colour) if env.get("STUDY_TITLE_BAR_COLOUR") else open_window(edge)
        return 0
    finally:
        if window_lock is not None:
            window_lock.close()


if __name__ == "__main__":
    sys.exit(main())
