# filename: backend/sync/common.py
"""The shared core of the local sync commands.

Both commands mirror rows from the Worker into a Google Drive folder, so both
need the same protection: names that are safe on Windows whatever the user
typed, object keys checked before they reach a URL, writes that are atomic and
verified, and a manifest that tells a file the sync wrote from one the user
has since edited. Nothing here deletes anything in the destination; files and
folders that are no longer wanted are moved aside instead.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import time
import unicodedata
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path, PurePosixPath

import requests

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from study.api import Api, ApiError  # noqa: E402

WINDOWS_RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}

# The attachment types the app accepts (jobs.ts ATTACH_TYPES). The extension
# on disk always comes from here, never from the uploaded name, because the
# stored name is whatever the user's file happened to be called.
MIME_EXT = {
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/msword": ".doc",
    "text/plain": ".txt",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
}

# Study readings can also be books, slides and other documents, none of
# which run anything when opened. HTML is left out on purpose, as a local
# page opened from disk can run script.
STUDY_MIME_EXT = {
    **MIME_EXT,
    "application/epub+zip": ".epub",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "application/vnd.ms-powerpoint": ".ppt",
    "application/vnd.oasis.opendocument.text": ".odt",
    "application/rtf": ".rtf",
    "text/markdown": ".md",
    "image/gif": ".gif",
}

MAX_COMPONENT = 80
# Windows still refuses most paths over 260 characters unless long paths are
# enabled, so the sync stays well under that and reports anything longer.
MAX_PATH = 250
DELETED_DIR = "_Deleted"
OLD_DIR = "_Old"

_BAD_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f\x7f]')
_KEY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*$")
_DIGEST = re.compile(r"(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])")
RETRY_STATUSES = {429, 500, 502, 503, 504}

# Swapped out by tests so retries do not slow the suite.
sleep: Callable[[float], None] = time.sleep


class SyncError(Exception):
    """A problem with the configuration or the data that stops a whole run."""


class IntegrityError(Exception):
    """Downloaded bytes that do not match the digest or size they should have."""


class AlreadyRunning(Exception):
    """Another run holds the lock for this command."""


# Names and keys

def safe_component(text: str | None, max_len: int = MAX_COMPONENT, fallback: str = "Untitled") -> str:
    """One path component that Windows and Google Drive will both accept and
    that cannot climb out of its parent, built from arbitrary user text."""
    name = unicodedata.normalize("NFC", text or "")
    name = _BAD_CHARS.sub(" ", name)
    name = re.sub(r"\s+", " ", name).strip()
    name = name[:max_len].rstrip(" .")
    if not name or set(name) <= {"."}:
        name = fallback
    if name.split(".")[0].strip().upper() in WINDOWS_RESERVED:
        name = ("_" + name)[:max_len].rstrip(" .")
    return name


def tagged(name: str, tag: str) -> str:
    """The name with a bracketed tag before its extension, as in "Notes [ab12].md"."""
    stem, dot, ext = name.rpartition(".")
    if dot and stem and "." + ext.lower() in {*STUDY_MIME_EXT.values(), ".url", ".md", ".csv"}:
        return f"{stem} [{tag}].{ext}"
    return f"{name} [{tag}]"


def disambiguate(entries: Iterable[tuple[str, str]]) -> dict[str, str]:
    """Names for (id, name) pairs that are unique within one folder. Windows
    compares names without case, so any names that match that way all get the
    start of their id, which keeps the result the same whatever the order."""
    entries = list(entries)

    def clashes(names: Iterable[str]) -> set[str]:
        counts: dict[str, int] = {}
        for name in names:
            counts[name.casefold()] = counts.get(name.casefold(), 0) + 1
        return {name for name, count in counts.items() if count > 1}

    first = clashes(name for _, name in entries)
    result = {ident: tagged(name, ident[:8]) if name.casefold() in first else name for ident, name in entries}
    # Two ids that share their first eight characters still clash, so those
    # few fall back to the whole id.
    second = clashes(result.values())
    for ident, name in entries:
        if result[ident].casefold() in second:
            result[ident] = tagged(name, ident)
    return result


def ext_for_mime(mime: str | None, table: dict[str, str] = MIME_EXT) -> str | None:
    return table.get((mime or "").split(";")[0].strip().lower())


def csv_cell(value) -> str:
    """A CSV value that Excel will show as text rather than run as a formula."""
    text = "" if value is None else str(value)
    return "'" + text if text[:1] in ("=", "+", "-", "@", "\t", "\r") else text


def validate_key(key: str | None) -> str:
    """A stored object key, refused unless it is plain path segments, so that
    nothing in a row can steer the request to another route or object."""
    if not key or not _KEY.match(key) or any(segment in (".", "..") for segment in key.split("/")) or ".." in key:
        raise ValueError(f"unsafe object key: {key!r}")
    return key


def key_digest(key: str | None) -> str | None:
    """The SHA-256 digest a content-addressed key carries, if it carries one."""
    match = _DIGEST.search(key or "")
    return match.group(0) if match else None


def http_url(url) -> str | None:
    """The address if it is a plain http or https link, otherwise None. Line
    breaks are refused because they would add lines to a .url shortcut."""
    if not isinstance(url, str) or not url or any(ord(ch) < 33 or ord(ch) == 127 for ch in url):
        return None
    lowered = url.lower()
    if not (lowered.startswith("https://") or lowered.startswith("http://")):
        return None
    host = url.split("://", 1)[1].split("/", 1)[0]
    return url if host else None


def url_shortcut(url: str) -> str:
    """The text of a Windows .url shortcut, for http and https only."""
    if not http_url(url):
        raise ValueError("only http and https links become shortcuts")
    return f"[InternetShortcut]\r\nURL={url}\r\n"


def pick(row: dict, *names: str, default=None):
    """The first of several possible fields that the row actually has a value for."""
    for name in names:
        value = row.get(name)
        if value not in (None, ""):
            return value
    return default


# Dates, in the British form the app shows

def uk_date(value: str | None) -> str:
    if not value:
        return ""
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            parsed = date.fromisoformat(value)
            return f"{parsed.day} {parsed:%b %Y}"
        moment = datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone()
        return f"{moment.day} {moment:%b %Y, %H:%M}"
    except ValueError:
        return value


def md_cell(value) -> str:
    """Text that cannot break a Markdown table row."""
    return re.sub(r"\s+", " ", "" if value is None else str(value)).replace("|", "\\|").strip()


def md_link(rel: str) -> str:
    """A relative link to a path that may contain spaces and brackets."""
    return "<" + rel.replace("<", "%3C").replace(">", "%3E") + ">"


# Files

def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def file_chunks(path: Path) -> Iterator[bytes]:
    with open(path, "rb") as handle:
        yield from iter(lambda: handle.read(1024 * 1024), b"")


def _replace(source: str, target: Path) -> None:
    """os.replace, retried briefly, because Google Drive for Desktop can hold
    a file open for a moment while it uploads the previous version."""
    for attempt in range(6):
        try:
            os.replace(source, target)
            return
        except PermissionError:
            if attempt == 5:
                raise
            sleep(0.5 * (attempt + 1))


def atomic_write_chunks(path: Path, chunks: Iterable[bytes], expected_sha256: str | None = None,
                        expected_bytes: int | None = None) -> str:
    """Writes the chunks to a hidden temporary file in the same folder, checks
    them, and only then renames the file into place. A failure of any kind
    leaves the previous file untouched and no temporary file behind."""
    path = Path(path)
    handle_fd, temporary = tempfile.mkstemp(prefix=".~sync-", suffix=".part", dir=path.parent)
    digest, size = hashlib.sha256(), 0
    try:
        with os.fdopen(handle_fd, "wb") as handle:
            for chunk in chunks:
                handle.write(chunk)
                digest.update(chunk)
                size += len(chunk)
            handle.flush()
            os.fsync(handle.fileno())
        got = digest.hexdigest()
        if expected_sha256 and got != expected_sha256:
            raise IntegrityError(f"{path.name}: received SHA-256 {got}, expected {expected_sha256}")
        if expected_bytes is not None and size != expected_bytes:
            raise IntegrityError(f"{path.name}: received {size} bytes, expected {expected_bytes}")
        _replace(temporary, path)
        return got
    except BaseException:
        try:
            os.remove(temporary)
        except FileNotFoundError:
            pass
        raise


def classify(local: str | None, recorded: str | None, remote: str) -> str:
    """Whether to write, skip or set aside a file, from three digests: what is
    on disk now, what the sync last wrote there, and what the Worker holds."""
    if local is None:
        return "write"
    if local == remote:
        return "skip"
    if recorded is not None and local == recorded:
        return "write"
    return "conflict"


def with_retries(action: Callable[[], object], attempts: int = 3):
    """Runs an idempotent request again after a dropped connection or a
    status that means "try later", backing off between attempts."""
    for attempt in range(attempts):
        try:
            return action()
        except ApiError as error:
            if error.status not in RETRY_STATUSES or attempt == attempts - 1:
                raise
        except (requests.ConnectionError, requests.Timeout, requests.exceptions.ChunkedEncodingError):
            if attempt == attempts - 1:
                raise
        sleep(2 ** attempt)
    raise AssertionError("unreachable")


def unique_path(path: Path, is_dir: bool = False) -> Path:
    """The path, or the first "name (2)", "name (3)" and so on that is free.
    A folder keeps its whole name, as a dot in it does not start an extension."""
    if not path.exists():
        return path
    stem, suffix = (path.name, "") if is_dir else (path.stem, path.suffix)
    for number in range(2, 1000):
        candidate = path.with_name(f"{stem} ({number}){suffix}")
        if not candidate.exists():
            return candidate
    raise SyncError(f"no free name beside {path}")


# Locking

def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        # os.kill(pid, 0) would terminate the process on Windows, so the
        # process is opened for a query instead.
        import ctypes
        handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
        if not handle:
            return False
        ctypes.windll.kernel32.CloseHandle(handle)
        return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


class RunLock:
    """An exclusive lock file, so a scheduled run and a manual one never write
    the same folder at once. A lock left by a process that has since died is
    taken over, so a crash does not block every later run."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self.fd: int | None = None

    def __enter__(self) -> "RunLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        for _ in range(2):
            try:
                self.fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(self.fd, str(os.getpid()).encode())
                return self
            except FileExistsError:
                try:
                    holder = int(self.path.read_text().strip() or 0)
                except (OSError, ValueError):
                    holder = 0
                if holder and _pid_alive(holder):
                    raise AlreadyRunning(f"another run (process {holder}) holds {self.path}") from None
                try:
                    os.remove(self.path)
                except FileNotFoundError:
                    pass
        raise AlreadyRunning(f"could not take {self.path}")

    def __exit__(self, *exc) -> None:
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
            try:
                os.remove(self.path)
            except FileNotFoundError:
                pass


# Configuration

def load_env(path: Path) -> None:
    """Reads KEY=VALUE lines into the environment without overriding values
    already set, so a variable set for one run still wins over the file."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        name = name.removeprefix("export ").strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        elif " #" in value:
            value = value.split(" #", 1)[0].rstrip()
        os.environ.setdefault(name, value)


def api_for_sync(env_path: Path) -> Api:
    """A client with the Access service token only. The sync never sends the
    processor key, because the mirror and the jobs push both use routes that
    the Access token alone may call, and neither has any use for its powers."""
    load_env(env_path)
    base = os.environ.get("STUDY_URL")
    client_id = os.environ.get("CF_ACCESS_CLIENT_ID")
    secret = os.environ.get("CF_ACCESS_CLIENT_SECRET")
    missing = [name for name, value in (("STUDY_URL", base), ("CF_ACCESS_CLIENT_ID", client_id),
                                        ("CF_ACCESS_CLIENT_SECRET", secret)) if not value]
    if missing:
        raise SyncError(f"missing from the environment and {env_path}: {', '.join(missing)}")
    return Api(base_url=base, access_client_id=client_id, access_client_secret=secret, timeout=120)


def default_state_dir() -> Path:
    """Sync state is kept on this machine, not in Drive, because a lock or
    manifest inside Drive would sync to other machines and race with theirs."""
    base = os.environ.get("LOCALAPPDATA")
    return Path(base) / "StudySync" if base else Path.home() / ".local" / "state" / "studysync"


def resolve_dest(text: str, flag: str = "--dest") -> Path:
    """A destination as an absolute path on this system, named in errors by
    the option it came from. Under WSL a
    Windows path such as G:\\My Drive\\... is a relative POSIX name, which
    would quietly build the tree in the working folder, so it is mapped to its
    drvfs mount instead, and refused if that drive is not mounted."""
    drive = re.match(r"^([A-Za-z]):[\\/]*(.*)$", text)
    if os.name != "nt" and drive:
        letter = drive.group(1).lower()
        mount = Path("/mnt") / letter
        if not os.path.ismount(mount):
            raise SyncError(f"{letter.upper()}: is not mounted in WSL. Run: sudo mkdir -p {mount} && "
                            f"sudo mount -t drvfs {letter.upper()}: {mount}")
        return mount.joinpath(*[part for part in re.split(r"[\\/]+", drive.group(2)) if part])
    path = Path(text)
    if not path.is_absolute():
        raise SyncError(f"{flag} must be an absolute path, not {text!r}")
    return path


def base_arguments(description: str, default_dest: str) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument("--dest", default=default_dest, help=f"destination folder (default: {default_dest})")
    parser.add_argument("--env", default=str(BACKEND / ".env"), help="the .env file with STUDY_URL and the Access token")
    parser.add_argument("--state-dir", default=None, help="where the lock and manifest are kept")
    parser.add_argument("--dry-run", action="store_true", help="report what would change without writing")
    parser.add_argument("--verbose", action="store_true", help="list every file, not only changes")
    parser.add_argument("--inspect", action="store_true", help="list the tables and columns the Worker returns, then stop")
    parser.add_argument("--allow-mass-retire", action="store_true",
                        help="allow a run to move aside more than half of the folders it manages")
    return parser


def inspect_tables(tables: dict[str, dict[str, dict]]) -> str:
    """Table names, row counts and column names, with no values, so the
    schema can be checked without printing anyone's data."""
    lines = []
    for name in sorted(tables):
        rows = list(tables[name].values())
        columns = sorted({column for row in rows for column in row})
        lines.append(f"{name} ({len(rows)} rows): {', '.join(columns)}")
    return "\n".join(lines)


# Reporting

@dataclass
class Report:
    verbose: bool = False
    written: int = 0
    unchanged: int = 0
    moved: int = 0
    conflicts: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    out: Callable[[str], None] = print

    def note(self, text: str, always: bool = True) -> None:
        if always or self.verbose:
            self.out(text)

    def summary(self) -> str:
        parts = [f"{self.written} written", f"{self.unchanged} unchanged", f"{self.moved} moved aside",
                 f"{len(self.conflicts)} conflicts", f"{len(self.skipped)} skipped", f"{len(self.errors)} errors"]
        return ", ".join(parts)

    @property
    def clean(self) -> bool:
        return not (self.conflicts or self.skipped or self.errors)


# The manifest and the syncer

class Manifest:
    """What the sync last wrote: each managed folder by the id of its row, and
    each managed file with its digest, size, modification time and source
    key. Size and time let an unchanged file skip re-hashing on later runs.
    extras holds whatever a command needs to remember between runs about
    its own rows, which this module stores without interpreting."""

    VERSION = 1

    def __init__(self, path: Path):
        self.path = Path(path)
        self.folders: dict[str, str] = {}
        self.files: dict[str, dict] = {}
        self.extras: dict = {}
        if self.path.exists():
            data = json.loads(self.path.read_text(encoding="utf-8"))
            if data.get("version") == self.VERSION:
                self.folders = dict(data.get("folders", {}))
                self.files = dict(data.get("files", {}))
                self.extras = dict(data.get("extras", {}))

    def rekey_prefix(self, old: str, new: str) -> None:
        def moved(rel: str) -> str:
            return new + rel[len(old):] if rel == old or rel.startswith(old + "/") else rel
        self.folders = {ident: moved(rel) for ident, rel in self.folders.items()}
        self.files = {moved(rel): entry for rel, entry in self.files.items()}

    def drop_prefix(self, prefix: str) -> None:
        self.folders = {i: r for i, r in self.folders.items() if not (r == prefix or r.startswith(prefix + "/"))}
        self.files = {r: e for r, e in self.files.items() if not r.startswith(prefix + "/")}

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data = json.dumps({"version": self.VERSION, "folders": self.folders, "files": self.files,
                           "extras": self.extras}, indent=1, sort_keys=True).encode("utf-8")
        atomic_write_chunks(self.path, [data])


Fetcher = Callable[[str], Iterable[bytes]]


class Syncer:
    """Mirrors folders and files into one destination. Callers declare every
    folder and file that should exist, parents before children, and finish()
    then moves aside whatever the sync manages that was not declared."""

    def __init__(self, root: Path, manifest: Manifest, fetch: Fetcher, report: Report,
                 dry_run: bool = False, allow_mass_retire: bool = False, today: date | None = None):
        self.root = Path(root)
        self.manifest = manifest
        self.fetch = fetch
        self.report = report
        self.dry_run = dry_run
        self.allow_mass_retire = allow_mass_retire
        self.today = today or date.today()
        self.seen_folders: set[str] = set()
        self.seen_files: set[str] = set()
        self._downloads: dict[str, tuple[Path, str]] = {}
        self._scratch = Path(tempfile.mkdtemp(prefix="studysync-"))

    # Paths

    def path(self, rel: str) -> Path:
        parts = PurePosixPath(rel).parts
        if not parts or any(part in ("", ".", "..") for part in parts) or rel.startswith("/"):
            raise SyncError(f"refusing an unsafe relative path: {rel!r}")
        target = self.root.joinpath(*parts)
        if os.path.commonpath([os.path.abspath(target), os.path.abspath(self.root)]) != os.path.abspath(self.root):
            raise SyncError(f"refusing a path outside the destination: {rel!r}")
        return target

    def _too_long(self, rel: str) -> bool:
        if len(str(self.path(rel))) > MAX_PATH:
            self.report.skipped.append(f"{rel}: the full path is over {MAX_PATH} characters")
            self.report.note(f"skipped (path too long): {rel}")
            return True
        return False

    # Folders

    def folder(self, ident: str, rel: str) -> str:
        """Makes sure the folder for a row exists at rel, renaming it from
        where the manifest last saw it if the row's name has changed."""
        self.path(rel)
        previous = self.manifest.folders.get(ident)
        if previous and previous != rel:
            old, new = self.path(previous), self.path(rel)
            case_only = previous.casefold() == rel.casefold()
            if old.is_dir() and (case_only or not new.exists()):
                self.report.note(f"renamed: {previous} -> {rel}")
                if not self.dry_run:
                    new.parent.mkdir(parents=True, exist_ok=True)
                    if case_only:
                        # A case-only rename goes through a temporary name,
                        # because Windows sees the two names as the same.
                        bridge = old.with_name(old.name + ".~rename")
                        _replace(str(old), bridge)
                        _replace(str(bridge), new)
                    else:
                        _replace(str(old), new)
                self.manifest.rekey_prefix(previous, rel)
            elif old.is_dir():
                self.report.conflicts.append(f"{rel}: could not rename {previous} because {rel} already exists")
                self.report.note(f"conflict: {previous} and {rel} both exist")
        self.manifest.folders[ident] = rel
        self.seen_folders.add(ident)
        if not self.dry_run:
            self.path(rel).mkdir(parents=True, exist_ok=True)
        return rel

    # Files

    def _local_sha(self, target: Path, entry: dict | None) -> str | None:
        if not target.is_file():
            return None
        if entry:
            stat = target.stat()
            if stat.st_size == entry.get("size") and stat.st_mtime_ns == entry.get("mtime_ns"):
                return entry.get("sha")
        return sha256_file(target)

    def _record(self, rel: str, sha: str, source: str) -> None:
        target = self.path(rel)
        if self.dry_run or not target.is_file():
            self.manifest.files[rel] = {"sha": sha, "key": source}
            return
        stat = target.stat()
        self.manifest.files[rel] = {"sha": sha, "key": source, "size": stat.st_size, "mtime_ns": stat.st_mtime_ns}

    def _download(self, key: str, digest: str | None, size: int | None) -> tuple[Path, str]:
        """Downloads an object once per run into scratch space on this
        machine, checked against its digest and size, so an object shared by
        several files is fetched only once."""
        if key not in self._downloads:
            scratch = self._scratch / hashlib.sha256(key.encode()).hexdigest()
            sha = with_retries(lambda: atomic_write_chunks(scratch, self.fetch(key), digest, size))
            self._downloads[key] = (scratch, sha)
        return self._downloads[key]

    def seed(self, key: str, path: Path, sha: str) -> None:
        """Copies a local file that holds an object's bytes into scratch space,
        checked against its digest, so a file this run has just uploaded is
        not fetched back. The copy is taken at once because the original may
        be renamed or edited before the mirror reaches it."""
        if key not in self._downloads:
            scratch = self._scratch / hashlib.sha256(key.encode()).hexdigest()
            self._downloads[key] = (scratch, atomic_write_chunks(scratch, file_chunks(Path(path)), sha))

    def mirrors(self, rel: str) -> bool:
        """Whether the file at rel is still exactly what the sync last wrote
        there, as opposed to a file of the user's or one they have edited."""
        entry = self.manifest.files.get(rel)
        if not entry:
            return False
        try:
            return self._local_sha(self.path(rel), entry) == entry.get("sha")
        except (OSError, SyncError):
            return False

    def put_bytes(self, rel: str, data: bytes) -> None:
        sha = hashlib.sha256(data).hexdigest()
        self._place(rel, source="generated", remote=sha, chunks=lambda: [data])

    def put_text(self, rel: str, text: str) -> None:
        self.put_bytes(rel, text.encode("utf-8"))

    def put_object(self, rel: str, key: str, digest: str | None = None, size: int | None = None) -> None:
        validate_key(key)
        entry = self.manifest.files.get(rel)
        known = digest or (entry.get("sha") if entry and entry.get("key") == key else None)

        def chunks() -> Iterable[bytes]:
            scratch, _ = self._download(key, digest, size)
            return file_chunks(scratch)

        self._place(rel, source=key, remote=known, chunks=chunks,
                    resolve=lambda: self._download(key, digest, size)[1])

    def _place(self, rel: str, source: str, remote: str | None, chunks: Callable[[], Iterable[bytes]],
               resolve: Callable[[], str] | None = None) -> None:
        # The file counts as seen before anything can fail, so an error on
        # this run never causes a good local copy to be moved aside.
        self.seen_files.add(rel)
        try:
            if self._too_long(rel):
                return
            target = self.path(rel)
            if target.is_dir():
                self.report.conflicts.append(f"{rel}: a folder is in the way")
                return
            entry = self.manifest.files.get(rel)
            local = self._local_sha(target, entry)
            if remote is None:
                if self.dry_run:
                    self.report.note(f"would fetch and compare: {rel}")
                    return
                remote = resolve() if resolve else None
                assert remote is not None
            action = classify(local, entry.get("sha") if entry else None, remote)
            if action == "skip":
                self.report.unchanged += 1
                self.report.note(f"unchanged: {rel}", always=False)
                if not self.dry_run:
                    self._record(rel, remote, source)
                return
            if action == "write":
                self.report.written += 1
                self.report.note(f"{'would write' if self.dry_run else 'written'}: {rel}")
                if not self.dry_run:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    atomic_write_chunks(target, chunks(), expected_sha256=remote)
                    self._record(rel, remote, source)
                return
            # The local copy was changed by someone else, so the Worker's
            # version is saved beside it and the local one is left alone.
            alternative = target.with_name(f"{target.stem} (from Study Library {self.today.isoformat()}){target.suffix}")
            self.report.conflicts.append(f"{rel}: changed locally, the current version is saved as {alternative.name}")
            self.report.note(f"conflict: {rel}")
            if not self.dry_run and not (alternative.is_file() and sha256_file(alternative) == remote):
                atomic_write_chunks(alternative, chunks(), expected_sha256=remote)
        except (ApiError, IntegrityError, OSError, ValueError, SyncError, requests.RequestException) as error:
            self.report.errors.append(f"{rel}: {error}")
            self.report.note(f"error: {rel}: {error}")

    # Finishing

    def _move_aside(self, source: Path, destination: Path) -> None:
        destination = unique_path(destination, is_dir=source.is_dir())
        self.report.moved += 1
        self.report.note(f"{'would move' if self.dry_run else 'moved'} aside: {source.relative_to(self.root)}"
                         f" -> {destination.relative_to(self.root)}")
        if not self.dry_run:
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(source), str(destination))

    def finish(self) -> None:
        """Moves aside the folders of rows that are gone into _Deleted, and
        files that are no longer wanted into an _Old folder beside them. A
        file the user has edited is left where it is and reported instead."""
        stale = sorted(((ident, rel) for ident, rel in self.manifest.folders.items() if ident not in self.seen_folders),
                       key=lambda item: item[1].count("/"))
        managed = len(self.manifest.folders)
        if stale and len(stale) > 3 and len(stale) * 2 > managed and not self.allow_mass_retire:
            raise SyncError(f"{len(stale)} of {managed} folders would be moved aside, which looks like the wrong "
                            "account or an empty response. Run again with --allow-mass-retire if it is intended.")
        for ident, rel in stale:
            target = self.path(rel)
            if target.is_dir():
                self._move_aside(target, self.root / DELETED_DIR / target.name)
            self.manifest.drop_prefix(rel)
            self.manifest.folders.pop(ident, None)
        for rel in [rel for rel in self.manifest.files if rel not in self.seen_files]:
            entry = self.manifest.files.pop(rel)
            target = self.path(rel)
            if not target.is_file():
                continue
            if self._local_sha(target, entry) == entry.get("sha"):
                self._move_aside(target, target.parent / OLD_DIR / target.name)
            else:
                self.report.skipped.append(f"{rel}: no longer synced, but left in place because it was edited")
        if not self.dry_run:
            self.manifest.save()

    def close(self) -> None:
        shutil.rmtree(self._scratch, ignore_errors=True)


def manifest_path(state_dir: Path, command: str, root: Path) -> Path:
    """One manifest per command and destination, so pointing --dest at a test
    folder never confuses the record for the real one."""
    tag = hashlib.sha256(str(Path(root).resolve()).casefold().encode()).hexdigest()[:12]
    return state_dir / f"{command}-{tag}.json"


def run(command: str, args: argparse.Namespace, build: Callable[[dict, Syncer], None],
        api_factory: Callable[[Path], Api] = api_for_sync, out: Callable[[str], None] = print) -> int:
    """The common shape of a run: lock, pull, build the tree, finish, report.
    Exit codes: 0 clean, 1 finished with conflicts, skips or errors,
    2 configuration or Worker failure, 3 another run is in progress."""
    report = Report(verbose=args.verbose, out=out)
    state_dir = Path(args.state_dir) if args.state_dir else default_state_dir()
    try:
        api = api_factory(Path(args.env))
        if args.inspect:
            out(inspect_tables(with_retries(api.pull_all)))
            return 0
        # Resolved after --inspect, which writes nothing and so needs no drive.
        root = resolve_dest(args.dest)
        if not Path(root.anchor).exists():
            raise SyncError(f"{root.anchor} is not available. Is Google Drive for Desktop running?")
        with RunLock(state_dir / f"{command}.lock"):
            tables = with_retries(api.pull_all)
            if not args.dry_run:
                root.mkdir(parents=True, exist_ok=True)
            syncer = Syncer(root, Manifest(manifest_path(state_dir, command, root)), api.object_chunks, report,
                            dry_run=args.dry_run, allow_mass_retire=args.allow_mass_retire)
            try:
                build(tables, syncer)
                syncer.finish()
            finally:
                syncer.close()
    except AlreadyRunning as error:
        out(f"Not started: {error}")
        return 3
    except (SyncError, ApiError, requests.RequestException) as error:
        out(f"Stopped: {error}")
        return 2
    for line in report.conflicts + report.skipped + report.errors:
        out(f"  {line}")
    out(f"{command}: {report.summary()}{' (dry run)' if args.dry_run else ''}")
    return 0 if report.clean else 1
