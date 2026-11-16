"""Build-time helpers invoked by build.ps1.

They live in Python rather than PowerShell so that every step that touches
downloads, hashes, archive extraction or generated installer code is covered by
pytest on any platform.

Subcommands:
  fetch          download, verify (or pin) and extract the bundled tools
  gen-inno       write generated/files.iss and generated/code.iss for the models
  env-template   produce the secret-free env.template that ships in the exe
  scan           fail if a build output contains .env files or secret values
  numeric-version
                 turn a tag such as v1.4.2-3-gabc into 1.4.2.0 for Windows
"""
from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, Dict, List, Optional, Tuple

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import slassets  # noqa: E402
import slruntime as rt  # noqa: E402

SECRET_KEY_RE = re.compile(r"(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE)", re.IGNORECASE)
INNO_MODELS_DIR = r"{localappdata}\StudyLibrary\models"


class BuildError(RuntimeError):
    pass


def sha256_file(path: Path) -> str:
    return slassets.sha256_file(path).hexdigest()


# --------------------------------------------------------------------------- fetch


def download_verified(url: str, target: Path, expected: str, pin: bool, opener=urllib.request.urlopen) -> str:
    """Ensure target holds the bytes for url and return their sha256.

    With an expected hash, a cached file is reused only if it matches and a
    fresh download that does not match is deleted. Without one, the build stops
    unless pin is set, in which case the observed hash is returned for pinning.
    """
    if target.exists() and expected and sha256_file(target) == expected:
        return expected
    if target.exists() and expected:
        target.unlink()
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        part = target.with_name(target.name + ".part")
        request = urllib.request.Request(url, headers={"User-Agent": "StudyLibrary-Build/1"})
        with opener(request, timeout=120) as resp, open(part, "wb") as fh:
            shutil.copyfileobj(resp, fh, 1 << 20)
        os.replace(part, target)
    actual = sha256_file(target)
    if not expected:
        if not pin:
            raise BuildError(f"{url} has no pinned sha256; re-run build.ps1 -PinHashes, review the diff and commit it")
        return actual
    if actual != expected:
        target.unlink()
        raise BuildError(f"sha256 mismatch for {url}: expected {expected}, got {actual}")
    return actual


def _safe_extract_zip(archive: Path, dest: Path) -> None:
    root = dest.resolve()
    with zipfile.ZipFile(archive) as zf:
        for member in zf.infolist():
            target = (dest / member.filename).resolve()
            if target != root and root not in target.parents:
                raise BuildError(f"{archive.name} contains an entry outside the archive root: {member.filename}")
        zf.extractall(dest)


def _prune(root: Path, patterns: List[str], keep: List[str]) -> None:
    keep_set = {k.replace("\\", "/") for k in keep}
    for pattern in patterns:
        rt.safe_relative(pattern, f"prune pattern {pattern!r}")
        for match in sorted(root.glob(pattern.replace("\\", "/")), reverse=True):
            rel = match.relative_to(root).as_posix()
            if rel in keep_set or any(fnmatch.fnmatch(rel, k) for k in keep_set):
                continue
            shutil.rmtree(match) if match.is_dir() else match.unlink()


def extract_tool(tool: Dict[str, Any], archive: Path, vendor: Path, seven_zip: Optional[str], system_dir: Optional[Path]) -> Path:
    """Extract into a private staging folder, validate, then move into place in one rename."""
    name = rt.safe_relative(tool["name"], "tool name")
    vendor.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{name}-", dir=vendor))
    try:
        if tool["kind"] == "zip":
            _safe_extract_zip(archive, staging)
        elif tool["kind"] == "nsis":
            if not seven_zip:
                raise BuildError(f"{name} is an NSIS installer and needs 7-Zip (pass --seven-zip)")
            subprocess.run([seven_zip, "x", "-y", f"-o{staging}", str(archive)], check=True, stdout=subprocess.DEVNULL)
        else:
            raise BuildError(f"{name} has kind {tool['kind']!r} and cannot be extracted")
        root = staging
        if tool.get("strip_root"):
            entries = list(staging.iterdir())
            if len(entries) != 1 or not entries[0].is_dir():
                raise BuildError(f"{name}: strip_root expects exactly one top-level folder, found {len(entries)} entries")
            root = entries[0]
        _prune(root, tool.get("prune", []), tool.get("keep", []))
        crt = tool.get("app_local_crt", [])
        if crt:
            if system_dir is None:
                raise BuildError(f"{name} needs {crt} copied app-locally; pass --system-dir")
            bin_dir = root / tool.get("bin_dir", ".")
            for dll in crt:
                source = system_dir / dll
                if not source.is_file():
                    raise BuildError(f"{name} needs {source}; install the Visual C++ 2015-2022 x64 redistributable on the build machine")
                shutil.copy2(source, bin_dir / dll)
        missing = [rel for rel in tool.get("expect", []) if not (root / rel).exists()]
        if missing:
            raise BuildError(f"{name}: extracted archive lacks {missing}; the upstream layout changed")
        final = vendor / name
        if final.exists():
            shutil.rmtree(final)
        os.replace(root, final)
        return final
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def cmd_fetch(args) -> int:
    manifest_path = Path(args.manifest)
    manifest = rt.load_manifest(manifest_path)
    rt.tool_specs(manifest)
    slassets.asset_specs(manifest)
    cache, vendor = Path(args.cache), Path(args.vendor)
    changed = False
    for tool in manifest["tools"]:
        if tool["kind"] == "system":
            continue
        archive = cache / f"{tool['name']}-{PurePosixPath(tool['url']).name}"
        actual = download_verified(tool["url"], archive, tool.get("sha256", ""), args.pin)
        if actual != tool.get("sha256"):
            tool["sha256"], changed = actual, True
            print(f"pinned {tool['name']} sha256={actual}")
        extract_tool(tool, archive, vendor, args.seven_zip, Path(args.system_dir) if args.system_dir else None)
        print(f"vendored {tool['name']} -> {vendor / tool['name']}")
    for asset in manifest["assets"]:
        if asset.get("sha256") and not args.verify_assets:
            continue  # the installer downloads pinned assets on the user's machine
        target = cache / f"asset-{asset['name']}"
        actual = download_verified(asset["url"], target, asset.get("sha256", ""), args.pin)
        if actual != asset.get("sha256"):
            asset["sha256"], asset["size"], changed = actual, target.stat().st_size, True
            print(f"pinned asset {asset['name']} sha256={actual}")
    if changed:
        rt.atomic_write_text(manifest_path, json.dumps(manifest, indent=2) + "\n")
        print(f"updated {manifest_path}; review and commit it")
    return 0


# --------------------------------------------------------------------------- Inno Setup includes


def _pascal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def render_inno(manifest: Dict[str, Any]) -> Tuple[str, str]:
    """Return (files.iss, code.iss) that download each pinned model inside the installer."""
    files = ["; Generated by build_helpers.py gen-inno. Do not edit."]
    code = [
        "{ Generated by build_helpers.py gen-inno. Do not edit. }",
        "function AddModelDownloads(Page: TDownloadWizardPage): Integer;",
        "begin",
        "  Result := 0;",
    ]
    for spec in slassets.asset_specs(manifest):
        if not spec.pinned:
            raise BuildError(f"asset {spec.name} has no pinned sha256; run build.ps1 -PinHashes")
        parts = PurePosixPath(spec.dest.replace("\\", "/"))
        dest_dir = INNO_MODELS_DIR + "".join("\\" + p for p in parts.parent.parts)
        tmp_name = f"sl-asset-{spec.name}"
        files.append(
            f'Source: "{{tmp}}\\{tmp_name}"; DestDir: "{dest_dir}"; DestName: "{parts.name}"; '
            "Flags: external skipifsourcedoesntexist ignoreversion uninsneveruninstall"
        )
        code += [
            f"  if not FileExists(ExpandConstant({_pascal(dest_dir + chr(92) + parts.name)})) then",
            "  begin",
            f"    Page.Add({_pascal(spec.url)}, {_pascal(tmp_name)}, {_pascal(spec.sha256)});",
            "    Result := Result + 1;",
            "  end;",
        ]
    code.append("end;")
    return "\n".join(files) + "\n", "\n".join(code) + "\n"


def cmd_gen_inno(args) -> int:
    files, code = render_inno(rt.load_manifest(Path(args.manifest)))
    out = Path(args.out)
    rt.atomic_write_text(out / "files.iss", files)
    rt.atomic_write_text(out / "code.iss", code)
    print(f"wrote {out / 'files.iss'} and {out / 'code.iss'}")
    return 0


# --------------------------------------------------------------------------- env template and secret scan


def sanitise_env_template(text: str) -> str:
    """Blank the value of every secret-looking key while keeping comments and other defaults."""
    out = []
    for line in text.splitlines():
        stripped = line.strip()
        key, sep, _ = stripped.partition("=")
        key = key.replace("export ", "").strip()
        if sep and not stripped.startswith("#") and SECRET_KEY_RE.search(key):
            out.append(f"{key}=")
        else:
            out.append(line)
    return "\n".join(out) + "\n"


def secret_findings(template_text: str) -> List[str]:
    return [f"{k} has a value" for k, v in rt.parse_env_text(template_text).items() if SECRET_KEY_RE.search(k) and v]


def cmd_env_template(args) -> int:
    root = Path(args.root)
    for rel in (".env.example", "backend/.env.example"):
        candidate = root / rel
        if candidate.is_file():
            source = candidate
            break
    else:
        source = HERE / "env.template"
    text = sanitise_env_template(source.read_text(encoding="utf-8-sig"))
    rt.atomic_write_text(Path(args.out), text)
    print(f"env template from {source} -> {args.out}")
    return 0


def scan_dist(dist: Path) -> List[str]:
    problems = []
    for path in dist.rglob("*"):
        if path.is_file() and path.name.lower().startswith(".env"):
            problems.append(f"{path.relative_to(dist)} must not be shipped")
        if path.is_file() and path.name == "env.template":
            problems += [f"{path.relative_to(dist)}: {p}" for p in secret_findings(path.read_text(encoding="utf-8-sig"))]
    return problems


def cmd_scan(args) -> int:
    problems = scan_dist(Path(args.dist))
    for problem in problems:
        print(f"SECRET SCAN: {problem}", file=sys.stderr)
    return 1 if problems else 0


# --------------------------------------------------------------------------- versions


def numeric_version(tag: str) -> str:
    numbers = re.findall(r"\d+", tag.split("-", 1)[0]) or ["0"]
    return ".".join((numbers + ["0", "0", "0"])[:4])


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="build_helpers")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("fetch")
    p.add_argument("--manifest", default=str(HERE / "manifest.json"))
    p.add_argument("--cache", required=True)
    p.add_argument("--vendor", required=True)
    p.add_argument("--seven-zip")
    p.add_argument("--system-dir")
    p.add_argument("--pin", action="store_true")
    p.add_argument("--verify-assets", action="store_true")
    p.set_defaults(func=cmd_fetch)
    p = sub.add_parser("gen-inno")
    p.add_argument("--manifest", default=str(HERE / "manifest.json"))
    p.add_argument("--out", default=str(HERE / "generated"))
    p.set_defaults(func=cmd_gen_inno)
    p = sub.add_parser("env-template")
    p.add_argument("--root", required=True)
    p.add_argument("--out", required=True)
    p.set_defaults(func=cmd_env_template)
    p = sub.add_parser("scan")
    p.add_argument("--dist", required=True)
    p.set_defaults(func=cmd_scan)
    p = sub.add_parser("numeric-version")
    p.add_argument("tag")
    p.set_defaults(func=lambda a: print(numeric_version(a.tag)) or 0)
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (BuildError, rt.ManifestError, subprocess.CalledProcessError, OSError) as exc:
        print(f"build_helpers {args.cmd} failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
