"""Verified, resumable downloads of large model files into the per-user models directory.

The installer normally fetches these files itself; this module is the repair
path that runs in the background whenever the app starts, so a user who
installed offline, cancelled the download or deleted a file still ends up with
a working copy without doing anything.

Invariants:
  * A file at its final path is only ever produced by os.replace of a fully
    downloaded .part whose SHA256 matched the manifest.
  * Only one process or thread downloads a given asset at a time (FileLock),
    and the installed check is repeated after the lock is taken.
  * An interrupted download leaves a .part that the next attempt resumes with
    an HTTP Range request; the hash is still computed over the whole file.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Dict, Iterable, List, Mapping, MutableMapping, Optional

from slruntime import FileLock, ManifestError, atomic_write_text, safe_relative

USER_AGENT = "StudyLibrary-Launcher/1"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
Progress = Callable[[str, int, Optional[int]], None]


class AssetError(RuntimeError):
    """Base class for every failure raised by ensure_asset."""


class AssetConfigError(AssetError):
    """The manifest entry cannot be used, for example because it has no pinned hash."""


class AssetIntegrityError(AssetError):
    """The downloaded bytes did not match the pinned SHA256; the partial file was deleted."""


class AssetDownloadError(AssetError):
    """Network or disk failure; any partial data is kept so that the next attempt resumes."""


class AssetBusyError(AssetError):
    """Another process holds the asset lock, or the destination file is open elsewhere."""


@dataclass(frozen=True)
class AssetSpec:
    name: str
    url: str
    sha256: str
    dest: str
    size: Optional[int] = None
    env: Optional[str] = None

    @property
    def pinned(self) -> bool:
        return bool(SHA256_RE.match(self.sha256))

    def path_in(self, models_dir: Path) -> Path:
        return Path(models_dir).joinpath(*PurePosixPath(self.dest.replace("\\", "/")).parts)


def asset_specs(manifest: Mapping[str, Any]) -> List[AssetSpec]:
    specs: List[AssetSpec] = []
    seen = set()
    for item in manifest["assets"]:
        try:
            name, url, dest = item["name"], item["url"], item["dest"]
        except (KeyError, TypeError) as exc:
            raise ManifestError(f"asset entry is missing {exc}") from None
        if name in seen:
            raise ManifestError(f"asset {name!r} is listed twice")
        seen.add(name)
        if not str(url).startswith("https://"):
            raise ManifestError(f"asset {name!r} must use an https URL")
        sha = str(item.get("sha256", "")).lower()
        if sha and not SHA256_RE.match(sha):
            raise ManifestError(f"asset {name!r} has a malformed sha256")
        size = item.get("size")
        specs.append(AssetSpec(name, url, sha, safe_relative(dest, f"{name}.dest"), int(size) if size else None, item.get("env")))
    return specs


def export_asset_env(specs: Iterable[AssetSpec], models_dir: Path, env: MutableMapping[str, str]) -> None:
    """Point each asset's environment variable at its deterministic path, even before it exists."""
    for spec in specs:
        if spec.env:
            env.setdefault(spec.env, str(spec.path_in(models_dir)))


def _stamp_path(dest: Path) -> Path:
    return dest.with_name(dest.name + ".ok")


def _write_stamp(dest: Path, sha256: str) -> None:
    st = dest.stat()
    atomic_write_text(_stamp_path(dest), json.dumps({"sha256": sha256, "size": st.st_size, "mtime_ns": st.st_mtime_ns}))


def _read_stamp(dest: Path) -> Optional[Dict[str, Any]]:
    try:
        return json.loads(_stamp_path(dest).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def sha256_file(path: Path, digest=None):
    digest = digest or hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            digest.update(block)
    return digest


def is_installed(spec: AssetSpec, models_dir: Path, verify_unstamped: bool = True) -> bool:
    """True when the file exists and is known to match the pinned hash.

    A stamp recording size and mtime avoids rehashing hundreds of megabytes on
    every launch. Files placed by the installer have no stamp yet, so they are
    hashed once and stamped if they match.
    """
    if not spec.pinned:
        return False
    dest = spec.path_in(models_dir)
    if not dest.is_file():
        return False
    st = dest.stat()
    if spec.size is not None and st.st_size != spec.size:
        return False
    if _read_stamp(dest) == {"sha256": spec.sha256, "size": st.st_size, "mtime_ns": st.st_mtime_ns}:
        return True
    if not verify_unstamped or sha256_file(dest).hexdigest() != spec.sha256:
        return False
    _write_stamp(dest, spec.sha256)
    return True


def _content_total(resp, offset: int) -> Optional[int]:
    headers = getattr(resp, "headers", None) or {}
    content_range = headers.get("Content-Range") if hasattr(headers, "get") else None
    if content_range and "/" in content_range:
        total = content_range.rsplit("/", 1)[1].strip()
        if total.isdigit():
            return int(total)
    length = headers.get("Content-Length") if hasattr(headers, "get") else None
    return offset + int(length) if length and str(length).isdigit() else None


def _download(spec: AssetSpec, part: Path, opener, progress: Optional[Progress], chunk_size: int) -> None:
    have = part.stat().st_size if part.exists() else 0
    if spec.size is not None and have > spec.size:
        part.unlink()
        have = 0
    headers = {"User-Agent": USER_AGENT}
    if have:
        headers["Range"] = f"bytes={have}-"
    request = urllib.request.Request(spec.url, headers=headers)
    digest = hashlib.sha256()
    try:
        with opener(request, timeout=60) as resp:
            status = getattr(resp, "status", None) or resp.getcode()
            if have and status == 206:
                sha256_file(part, digest)
                mode, done = "ab", have
            else:
                mode, done = "wb", 0  # server ignored Range: start again
            total = _content_total(resp, done)
            with open(part, mode) as fh:
                while True:
                    block = resp.read(chunk_size)
                    if not block:
                        break
                    fh.write(block)
                    digest.update(block)
                    done += len(block)
                    if progress:
                        progress(spec.name, done, total)
                fh.flush()
                os.fsync(fh.fileno())
    except urllib.error.HTTPError as exc:
        if exc.code == 416:
            part.unlink(missing_ok=True)
        raise AssetDownloadError(f"{spec.name}: HTTP {exc.code} from {spec.url}") from exc
    except (urllib.error.URLError, OSError) as exc:
        raise AssetDownloadError(f"{spec.name}: download interrupted ({exc}); partial data kept for resume") from exc
    actual = digest.hexdigest()
    if actual != spec.sha256:
        part.unlink(missing_ok=True)
        raise AssetIntegrityError(f"{spec.name}: sha256 {actual} does not match pinned {spec.sha256}")


def ensure_asset(
    spec: AssetSpec,
    models_dir: Path,
    *,
    opener=None,
    progress: Optional[Progress] = None,
    lock_timeout: float = 600.0,
    chunk_size: int = 1 << 20,
) -> Path:
    """Return the verified path of spec, downloading it first if necessary."""
    if not spec.pinned:
        raise AssetConfigError(f"{spec.name} has no pinned sha256; run build.ps1 -PinHashes and commit manifest.json")
    dest = spec.path_in(models_dir)
    dest.parent.mkdir(parents=True, exist_ok=True)
    lock = FileLock(dest.with_name(dest.name + ".lock"))
    if not lock.acquire(timeout=lock_timeout):
        raise AssetBusyError(f"{spec.name}: another process is downloading it")
    try:
        if is_installed(spec, models_dir):
            return dest
        part = dest.with_name(dest.name + ".part")
        _download(spec, part, opener or urllib.request.urlopen, progress, chunk_size)
        try:
            os.replace(part, dest)
        except PermissionError as exc:
            raise AssetBusyError(f"{spec.name}: {dest} is in use; close Study Library and retry") from exc
        _write_stamp(dest, spec.sha256)
        return dest
    finally:
        lock.release()


def ensure_assets(specs: Iterable[AssetSpec], models_dir: Path, **kwargs) -> Dict[str, str]:
    """Best-effort repair of every pinned asset; returns name -> "ok" or the error text."""
    results: Dict[str, str] = {}
    for spec in specs:
        if not spec.pinned:
            results[spec.name] = "skipped: no pinned sha256"
            continue
        try:
            ensure_asset(spec, models_dir, **kwargs)
            results[spec.name] = "ok"
        except AssetError as exc:
            results[spec.name] = str(exc)
    return results
