"""In-app updates: studylibrary://update?version=X downloads the installer and starts it as a silent in-place update.

Any web page can open a studylibrary:// link, so the link is trusted only to
name a version. The file, its size and its digest come from GitHub's answer for
the latest release of varneridge/study-library, the link must name that same
release, and the installer starts only once the download matches, which means
a page can neither choose the file nor push an older release onto the computer.
Once the download matches, every other Study Library process is closed
(desktop.close_for_update), so that the supervisor can neither restart its
children nor hold a file open while the installer (installer.iss, /UPDATE=1)
swaps the new files in, puts the old ones back if anything fails, and reopens
the app. When the installer cannot start at all, as when the person declines
the elevation prompt, Study Library is opened again as it was.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import sys
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path
from typing import BinaryIO, Callable, Optional, Sequence

log = logging.getLogger(__name__)

SCHEME = "studylibrary"
LATEST_API = "https://api.github.com/repos/varneridge/study-library/releases/latest"
ASSET = "StudyLibrarySetup.exe"
DOWNLOAD_PREFIX = "https://github.com/varneridge/study-library/releases/download/"
REDIRECT_HOSTS = frozenset({"github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"})
_VERSION = re.compile(r"v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})")
_AGENT = "StudyLibrary-updater"
_MISMATCH = "The download did not match the published installer, so it was deleted and nothing was installed."
_NO_DIGEST = "GitHub did not publish a checksum for this installer, so it was not downloaded and nothing was installed."
# The same silent flags build.ps1 verifies, minus /CURRENTUSER and /DIR, so that Inno Setup
# reuses the existing installation's folder and install mode (UsePreviousAppDir, UsePreviousPrivileges).
INSTALL_ARGS = ("/SILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/NOCLOSEAPPLICATIONS", "/SKIPMODELS=1",
                '/MERGETASKS="!libreoffice"', "/UPDATE=1")

Notify = Callable[..., None]
Hook = Callable[[], None]
# The signature Windows writes at the start of every VS_FIXEDFILEINFO.
_FIXED_FILE_INFO = 0xFEEF04BD


class UpdateError(Exception):
    """A reason not to install, already worded for the person reading the notification."""


def _version(text: object) -> Optional[str]:
    match = _VERSION.fullmatch(text) if isinstance(text, str) else None
    return ".".join(str(int(part)) for part in match.groups()) if match else None


def _nothing() -> None:
    return None


def _file_version(path: Path) -> Optional[str]:
    """The product version that the build stamped into the executable, read
    from its version resource, or None when it carries none or is unstamped."""
    if os.name != "nt":
        return None
    import ctypes
    from ctypes import wintypes

    library = ctypes.WinDLL("version")
    library.GetFileVersionInfoSizeW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(wintypes.DWORD)]
    library.GetFileVersionInfoW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p]
    library.VerQueryValueW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_void_p),
                                       ctypes.POINTER(wintypes.UINT)]
    size = library.GetFileVersionInfoSizeW(str(path), None)
    if not size:
        return None
    data = ctypes.create_string_buffer(size)
    block, length = ctypes.c_void_p(), wintypes.UINT()
    if (not library.GetFileVersionInfoW(str(path), 0, size, data)
            or not library.VerQueryValueW(data, "\\", ctypes.byref(block), ctypes.byref(length))
            or length.value < 13 * 4):
        return None
    fields = ctypes.cast(block, ctypes.POINTER(ctypes.c_uint32 * 13)).contents
    if fields[0] != _FIXED_FILE_INFO or not (fields[4] or fields[5]):
        return None
    return f"{fields[4] >> 16}.{fields[4] & 0xFFFF}.{fields[5] >> 16}"


def installed_version() -> Optional[str]:
    """The version of this installation rather than of the web page, which can
    be newer, from study.__version__ when the package carries one and otherwise
    from the version stamped into StudyLibrary.exe, or None when neither says."""
    import study

    found = _version(getattr(study, "__version__", None))
    if found is None and getattr(sys, "frozen", False):
        try:
            found = _version(_file_version(Path(sys.executable)))
        except (OSError, AttributeError, ValueError):
            log.debug("the executable's version resource could not be read", exc_info=True)
    return found


def is_update_link(link: str) -> bool:
    parts = urllib.parse.urlsplit(link.strip())
    return parts.scheme.lower() == SCHEME and (parts.netloc + parts.path).strip("/").lower() == "update"


def parse_update_link(link: str) -> str:
    if not is_update_link(link):
        raise UpdateError("That link is not a Study Library update link, so nothing was installed.")
    query = urllib.parse.parse_qsl(urllib.parse.urlsplit(link.strip()).query, keep_blank_values=True)
    version = _version(query[0][1]) if len(query) == 1 and query[0][0] == "version" else None
    if version is None:
        raise UpdateError("The update link did not name a release version, so nothing was installed.")
    return version


def latest_release(fetch_json: Callable[[str], object]) -> tuple[str, str, int, str]:
    """Returns (version, download URL, size, digest) for the newest published release."""
    try:
        release = fetch_json(LATEST_API)
    except (OSError, ValueError) as exc:
        raise UpdateError("GitHub could not be reached to check the release, so nothing was installed.") from exc
    assets = release.get("assets") if isinstance(release, dict) else None
    asset = next((a for a in assets if isinstance(a, dict) and a.get("name") == ASSET), {}) if isinstance(assets, list) else {}
    version = _version(release.get("tag_name")) if isinstance(release, dict) else None
    url, size, digest = asset.get("browser_download_url"), asset.get("size"), asset.get("digest") or ""
    if (version is None or not isinstance(url, str) or not url.startswith(DOWNLOAD_PREFIX)
            or type(size) is not int or size <= 0 or not isinstance(digest, str)):
        raise UpdateError("GitHub's answer did not describe a usable installer, so nothing was installed.")
    if not digest:
        raise UpdateError(_NO_DIGEST)
    return version, url, size, digest


class _GitHubOnly(urllib.request.HTTPRedirectHandler):
    """Follows GitHub's own redirect to its file storage and refuses every other destination."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parts = urllib.parse.urlsplit(newurl)
        if parts.scheme != "https" or parts.hostname not in REDIRECT_HOSTS:
            raise UpdateError("The download was redirected away from GitHub, so nothing was installed.")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _fetch_json(url: str) -> object:
    request = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": _AGENT})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def _stream(url: str, out: BinaryIO, limit: int) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": _AGENT})
    with urllib.request.build_opener(_GitHubOnly()).open(request, timeout=60) as response:
        written = 0
        for chunk in iter(lambda: response.read(1 << 20), b""):
            written += len(chunk)
            if written > limit:
                raise UpdateError(_MISMATCH)
            out.write(chunk)


def _digest_matches(path: Path, digest: str) -> bool:
    algorithm, _, expected = digest.partition(":")
    if algorithm != "sha256":
        return False
    hasher = hashlib.sha256()
    with open(path, "rb") as source:
        for block in iter(lambda: source.read(1 << 20), b""):
            hasher.update(block)
    return hasher.hexdigest() == expected.lower()


def fetch_installer(url: str, size: int, digest: str, version: str,
                    stream: Callable[[str, BinaryIO, int], None] = _stream, folder: Optional[Path] = None) -> Path:
    final = Path(folder or tempfile.gettempdir()) / f"StudyLibrarySetup-{version}.exe"
    partial = final.with_name(final.name + ".part")
    try:
        with open(partial, "wb") as out:
            stream(url, out, size)
        if partial.stat().st_size != size or not _digest_matches(partial, digest):
            raise UpdateError(_MISMATCH)
        os.replace(partial, final)
    except BaseException:
        partial.unlink(missing_ok=True)
        raise
    return final


def installer_arguments(path: Path) -> str:
    return " ".join((*INSTALL_ARGS, f'/LOG="{path.with_suffix(".log")}"'))


def _launch(path: Path) -> None:
    # ShellExecute rather than CreateProcess, because an installer that writes to
    # Program Files asks for elevation and CreateProcess refuses that with error 740.
    if not hasattr(os, "startfile"):
        raise UpdateError("The installer only runs on Windows, so it was downloaded but not started.")
    os.startfile(str(path), "open", installer_arguments(path))


def run(link: str, notify: Notify, *, fetch_json: Callable[[str], object] = _fetch_json,
        stream: Callable[[str, BinaryIO, int], None] = _stream, launch: Callable[[Path], None] = _launch,
        folder: Optional[Path] = None, close: Hook = _nothing, reopen: Hook = _nothing) -> int:
    """Closes the running app only once the installer is on disk and matches,
    so that a failed check or download leaves it open, and opens it again when
    the installer cannot be started, since nothing would reopen it otherwise."""
    try:
        wanted = parse_update_link(link)
        version, url, size, digest = latest_release(fetch_json)
        if wanted != version:
            raise UpdateError(f"Study Library {wanted} is not the latest release ({version}), so nothing was installed.")
        notify(f"Downloading Study Library {version}, after which Study Library will close, install it and reopen by itself.")
        installer = fetch_installer(url, size, digest, version, stream, folder)
        try:
            close()
            launch(installer)
        except BaseException:
            reopen()
            raise
    except UpdateError as exc:
        reason = str(exc)
    except OSError:
        log.exception("Update download or launch failed")
        reason = "The update could not be downloaded or started, so nothing on this computer was changed."
    else:
        return 0
    log.warning("Update refused: %s", reason)
    notify(reason, error=True)
    return 2


def route(argv: Optional[Sequence[str]], notify: Notify, close: Optional[Hook] = None,
          reopen: Optional[Hook] = None) -> Optional[int]:
    """Called first by desktop.main, returning an exit code for update invocations and None otherwise.

    Windows registers one command for the whole studylibrary scheme, and that
    command passes --connect, so update links arrive that way as well as by --update.
    close and reopen come from desktop.main, because this module cannot import it.
    """
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) == 2 and (args[0] == "--update" or (args[0] == "--connect" and is_update_link(args[1]))):
        return run(args[1], notify, close=close or _nothing, reopen=reopen or _nothing)
    return None
