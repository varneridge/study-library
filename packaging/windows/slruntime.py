"""Runtime support for the packaged Windows build of Study Library.

This module never imports the application, which means it can be unit tested on
any operating system. It owns four responsibilities: working out where the
install and the per-user data live, putting the bundled command-line tools on
PATH, loading the per-user .env file, and guaranteeing that only one copy of the
app runs against a given data directory at any moment.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, Dict, Iterable, List, Mapping, MutableMapping, Optional, Tuple

APP_DIR_NAME = "StudyLibrary"
HOME_ENV = "STUDY_LIBRARY_HOME"
VENDOR_ENV = "STUDY_VENDOR_DIR"
LAYOUT = ("data", "models", "logs")
TOOL_KINDS = ("zip", "nsis", "system")
_ENV_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class ManifestError(ValueError):
    """Raised when manifest.json is malformed or names a path outside its root."""


@dataclass(frozen=True)
class ToolSpec:
    name: str
    kind: str
    exe: str
    bin_dir: str = "."
    required: bool = False
    check_args: Tuple[str, ...] = ()
    env_dirs: Mapping[str, str] = field(default_factory=dict)
    env_exe: Tuple[str, ...] = ()
    search: Tuple[str, ...] = ()


@dataclass
class ToolStatus:
    name: str
    source: str  # "bundled", "system" or "missing"
    path: Optional[str]
    required: bool


# --------------------------------------------------------------------------- manifest


def safe_relative(value: str, what: str) -> str:
    """Return value unchanged if it is a relative path that cannot escape its root."""
    if not isinstance(value, str) or not value:
        raise ManifestError(f"{what} must be a non-empty string")
    posix = PurePosixPath(value.replace("\\", "/"))
    drive_like = len(value) > 1 and value[1] == ":"
    if posix.is_absolute() or drive_like or ".." in posix.parts:
        raise ManifestError(f"{what} must be a relative path inside its root, got {value!r}")
    return value


def load_manifest(path: Path) -> Dict[str, Any]:
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        raise ManifestError(f"cannot read manifest {path}: {exc}") from exc
    if not isinstance(raw, dict) or not isinstance(raw.get("tools"), list) or not isinstance(raw.get("assets"), list):
        raise ManifestError("manifest must be an object with 'tools' and 'assets' lists")
    return raw


def tool_specs(manifest: Mapping[str, Any]) -> List[ToolSpec]:
    specs: List[ToolSpec] = []
    seen = set()
    for item in manifest["tools"]:
        try:
            name, kind, exe = item["name"], item["kind"], item["exe"]
        except (KeyError, TypeError) as exc:
            raise ManifestError(f"tool entry is missing {exc}") from None
        if kind not in TOOL_KINDS:
            raise ManifestError(f"tool {name!r} has unknown kind {kind!r}")
        if name in seen:
            raise ManifestError(f"tool {name!r} is listed twice")
        seen.add(name)
        safe_relative(name, f"tool name {name!r}")
        safe_relative(exe, f"{name}.exe")
        env_dirs = {k: safe_relative(v, f"{name}.env_dirs.{k}") for k, v in item.get("env_dirs", {}).items()}
        specs.append(
            ToolSpec(
                name=name,
                kind=kind,
                exe=exe,
                bin_dir=safe_relative(item.get("bin_dir", "."), f"{name}.bin_dir"),
                required=bool(item.get("required", False)),
                check_args=tuple(item.get("check_args", ())),
                env_dirs=env_dirs,
                env_exe=tuple(item.get("env_exe", ())),
                search=tuple(item.get("search", ())),
            )
        )
    return specs


# --------------------------------------------------------------------------- locations


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def install_dir() -> Path:
    """Directory containing StudyLibrary.exe, or this source folder in development."""
    if is_frozen():
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def resource_dir() -> Path:
    """Directory holding manifest.json and env.template (PyInstaller's _internal when frozen)."""
    base = getattr(sys, "_MEIPASS", None)
    return Path(base) if base else Path(__file__).resolve().parent


def vendor_dir(env: Mapping[str, str] = os.environ) -> Path:
    override = env.get(VENDOR_ENV)
    if override:
        return Path(override)
    if is_frozen():
        return install_dir() / "vendor"
    return Path(__file__).resolve().parents[2] / "build" / "windows" / "vendor"


def home_dir(env: Mapping[str, str] = os.environ) -> Path:
    """Root of all mutable per-user state; never inside the install directory."""
    override = env.get(HOME_ENV)
    if override:
        return Path(override)
    base = env.get("LOCALAPPDATA")
    if base:
        return Path(base) / APP_DIR_NAME
    return Path.home() / ".local" / "share" / APP_DIR_NAME


def ensure_layout(home: Path) -> Dict[str, Path]:
    """Create home and its fixed subdirectories, then prove that home is writable."""
    home.mkdir(parents=True, exist_ok=True)
    paths = {"home": home}
    for name in LAYOUT:
        sub = home / name
        sub.mkdir(exist_ok=True)
        paths[name] = sub
    fd, probe = tempfile.mkstemp(prefix=".write-test-", dir=home)
    os.close(fd)
    os.unlink(probe)
    return paths


# --------------------------------------------------------------------------- tools


def _expand(value: str, env: Mapping[str, str]) -> str:
    return re.sub(r"%([^%]+)%", lambda m: env.get(m.group(1), m.group(0)), value)


def resolve_tool(spec: ToolSpec, vendor: Path, env: Mapping[str, str] = os.environ) -> ToolStatus:
    """Bundled copy first, then known install folders, then PATH."""
    if spec.kind != "system":
        candidate = vendor / spec.name / spec.bin_dir / spec.exe
        if candidate.is_file():
            return ToolStatus(spec.name, "bundled", str(candidate), spec.required)
    for folder in spec.search:
        expanded = _expand(folder, env)
        if "%" in expanded:
            continue
        candidate = Path(expanded) / spec.exe
        if candidate.is_file():
            return ToolStatus(spec.name, "system", str(candidate), spec.required)
    search_path = env.get("PATH", "")
    found = shutil.which(spec.exe, path=search_path)
    if not found and spec.exe.lower().endswith(".exe"):
        found = shutil.which(spec.exe[:-4], path=search_path)
    if found:
        return ToolStatus(spec.name, "system", found, spec.required)
    return ToolStatus(spec.name, "missing", None, spec.required)


def prepend_path(current: str, dirs: Iterable[str]) -> str:
    """Prepend dirs to a PATH string, removing duplicates; applying it twice changes nothing."""
    seen = set()
    merged: List[str] = []
    for entry in list(dirs) + [p for p in current.split(os.pathsep) if p]:
        key = os.path.normcase(os.path.normpath(entry))
        if key not in seen:
            seen.add(key)
            merged.append(entry)
    return os.pathsep.join(merged)


def apply_environment(
    specs: Iterable[ToolSpec], vendor: Path, home: Path, env: MutableMapping[str, str]
) -> Dict[str, ToolStatus]:
    """Expose tools and data locations to the application through environment variables.

    Bundled tools override whatever the user has configured, because their
    variables (TESSDATA_PREFIX in particular) must match the bundled binary.
    System tools and data locations only fill gaps, so a user override wins.
    """
    statuses: Dict[str, ToolStatus] = {}
    bundled_bins: List[str] = []
    for spec in specs:
        status = resolve_tool(spec, vendor, env)
        statuses[spec.name] = status
        if status.path is None:
            continue
        exe_path = Path(status.path)
        if status.source == "bundled":
            bundled_bins.append(str(exe_path.parent))
            root = vendor / spec.name
            for var, rel in spec.env_dirs.items():
                env[var] = str(root / rel)
            for var in spec.env_exe:
                env[var] = str(exe_path)
        else:
            for var in spec.env_exe:
                env.setdefault(var, str(exe_path))
    env["PATH"] = prepend_path(env.get("PATH", ""), bundled_bins)
    env.setdefault("STUDY_DATA_DIR", str(home / "data"))
    env.setdefault("STUDY_MODELS_DIR", str(home / "models"))
    env.setdefault("HF_HOME", str(home / "models" / "hf"))
    return statuses


# --------------------------------------------------------------------------- .env handling


def parse_env_text(text: str) -> Dict[str, str]:
    values: Dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        key, sep, value = line.partition("=")
        key = key.strip()
        if not sep or not _ENV_KEY.match(key):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        elif " #" in value:
            value = value.split(" #", 1)[0].rstrip()
        values[key] = value
    return values


def load_env_file(path: Path, env: MutableMapping[str, str]) -> List[str]:
    """Copy keys from path into env unless env already has a non-empty value."""
    try:
        text = Path(path).read_text(encoding="utf-8-sig")
    except FileNotFoundError:
        return []
    applied = []
    for key, value in parse_env_text(text).items():
        if not env.get(key):
            env[key] = value
            applied.append(key)
    return applied


def required_keys(template_text: str) -> List[str]:
    """Keys preceded by a comment containing @required are mandatory."""
    keys: List[str] = []
    pending = False
    for raw in template_text.splitlines():
        line = raw.strip()
        if line.startswith("#"):
            pending = pending or "@required" in line
            continue
        key = line.partition("=")[0].strip()
        if pending and _ENV_KEY.match(key):
            keys.append(key)
        if line:
            pending = False
    return keys


def missing_keys(keys: Iterable[str], env: Mapping[str, str]) -> List[str]:
    return [k for k in keys if not env.get(k, "").strip()]


def seed_env_file(target: Path, template: Path) -> bool:
    """Create target from template without ever overwriting an existing file."""
    if target.exists():
        return False
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".env-seed-", dir=target.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(Path(template).read_text(encoding="utf-8-sig"))
        try:
            os.link(tmp, target)  # atomic and refuses to clobber
        except FileExistsError:
            return False
        except OSError:
            if target.exists():  # filesystem without hard links
                return False
            os.replace(tmp, target)
        return True
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


# --------------------------------------------------------------------------- locking and instance info


if os.name == "nt":
    import msvcrt

    def _try_lock(fh) -> None:
        fh.seek(0)
        msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)

    def _unlock(fh) -> None:
        fh.seek(0)
        msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)

else:
    import fcntl

    def _try_lock(fh) -> None:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

    def _unlock(fh) -> None:
        fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


class FileLock:
    """Exclusive OS-level lock on a file, released by the kernel if the process dies.

    Because the lock lives in the kernel rather than in the file's existence, a
    crash can never leave a stale lock that blocks the next launch.
    """

    def __init__(self, path: Path):
        self.path = Path(path)
        self._fh = None

    @property
    def held(self) -> bool:
        return self._fh is not None

    def acquire(self, timeout: float = 0.0, poll: float = 0.2) -> bool:
        if self._fh is not None:
            return True
        self.path.parent.mkdir(parents=True, exist_ok=True)
        deadline = time.monotonic() + max(timeout, 0.0)
        while True:
            fh = open(self.path, "a+b")
            try:
                _try_lock(fh)
            except OSError:
                fh.close()
                if time.monotonic() >= deadline:
                    return False
                time.sleep(poll)
                continue
            self._fh = fh
            return True

    def release(self) -> None:
        if self._fh is None:
            return
        try:
            _unlock(self._fh)
        finally:
            self._fh.close()
            self._fh = None

    def __enter__(self) -> "FileLock":
        if not self.acquire():
            raise RuntimeError(f"{self.path} is locked by another process")
        return self

    def __exit__(self, *exc) -> None:
        self.release()


def atomic_write_text(path: Path, text: str) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def write_instance_info(home: Path, url: str) -> None:
    """Called by the app (optionally) once its UI URL is known, so a second launch can focus it."""
    atomic_write_text(Path(home) / "instance.json", json.dumps({"url": url, "pid": os.getpid()}))


def read_instance_info(home: Path) -> Optional[Dict[str, Any]]:
    try:
        data = json.loads((Path(home) / "instance.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def clear_instance_info(home: Path) -> None:
    try:
        (Path(home) / "instance.json").unlink()
    except FileNotFoundError:
        pass


# --------------------------------------------------------------------------- windowed-mode helpers


def redirect_std_streams(log_dir: Path) -> None:
    """A windowed PyInstaller exe has no console, so sys.stdout is None and print() would crash."""
    for name in ("stdout", "stderr"):
        if getattr(sys, name) is None:
            setattr(sys, name, open(Path(log_dir) / f"{name}.log", "a", encoding="utf-8", buffering=1))


def message_box(title: str, text: str, kind: str = "info") -> bool:
    """Show a native dialog on Windows; returns True for OK or Yes, and False elsewhere."""
    flags = {"info": 0x40, "error": 0x10, "question": 0x24}[kind] | 0x10000
    if os.name == "nt":
        try:
            import ctypes

            return ctypes.windll.user32.MessageBoxW(None, text, title, flags) in (1, 6)
        except Exception:  # pragma: no cover - only reachable on a broken Windows session
            pass
    print(f"[{title}] {text}", file=sys.stderr)
    return False
