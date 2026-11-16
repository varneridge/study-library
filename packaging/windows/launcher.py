"""Windows entry point for Study Library.

PyInstaller compiles this file into StudyLibrary.exe. It prepares the runtime
environment (bundled tools, per-user .env, model paths), makes sure that only
one copy runs at a time, registers the studylibrary:// link handler for the
current user, and then hands control to the application entry point, which
defaults to study.desktop:main and can be overridden with STUDY_ENTRY.

``StudyLibrary.exe --self-test <report.json>`` performs every preparation step,
runs each bundled tool once, imports the entry module without calling it, looks
in the bundle for every module that the entry module lists in CHILD_MODULES as
one its child processes start by name, and writes a JSON report; the exit code
is 0 only when every check passed.

``StudyLibrary.exe -m <module> [args...]`` prepares the environment and runs
the module as ``python -m`` would, without the single-instance lock, because
study.desktop relaunches the frozen build this way for its supervisor and its
children, which run alongside the copy that holds the lock. The studylibrary://
link handler uses the same route, so that "Connect this computer" works while
the application is already running.
"""
from __future__ import annotations

import argparse
import importlib
import importlib.util
import json
import logging
import logging.handlers
import os
import runpy
import subprocess
import sys
import threading
import webbrowser
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, MutableMapping, Optional, Sequence

import slassets
import slruntime as rt

ENTRY_ENV = "STUDY_ENTRY"
DEFAULT_ENTRY = "study.desktop:main"
CHILD_MODULES_ATTR = "CHILD_MODULES"
TOOL_TIMEOUT_S = 30
# These must stay identical to desktop.CONNECT_KEYS and desktop.CONNECT_SCHEME.
CONNECT_KEYS = ("PROCESSOR_KEY", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET")
PROTOCOL = "studylibrary"
log = logging.getLogger("studylibrary.launcher")


@dataclass
class Prepared:
    home: Path
    paths: Dict[str, Path]
    specs: List[rt.ToolSpec]
    tools: Dict[str, rt.ToolStatus]
    assets: List[slassets.AssetSpec]
    env_file: Path
    env_seeded: bool
    missing_keys: List[str]


def prepare(env: MutableMapping[str, str]) -> Prepared:
    """Everything that must happen before the app is imported, in dependency order."""
    home = rt.home_dir(env)
    paths = rt.ensure_layout(home)
    resources = rt.resource_dir()
    manifest = rt.load_manifest(resources / "manifest.json")
    template = resources / "env.template"
    env_file = home / ".env"
    seeded = rt.seed_env_file(env_file, template) if template.is_file() else False
    rt.load_env_file(env_file, env)
    specs = rt.tool_specs(manifest)
    tools = rt.apply_environment(specs, rt.vendor_dir(env), home, env)
    assets = slassets.asset_specs(manifest)
    slassets.export_asset_env(assets, paths["models"], env)
    required = rt.required_keys(template.read_text(encoding="utf-8-sig")) if template.is_file() else []
    return Prepared(home, paths, specs, tools, assets, env_file, seeded, rt.missing_keys(required, env))


def protocol_command(exe: str) -> str:
    """The command Windows runs for a studylibrary:// link. It goes through the
    lock-free module route, so that it can run beside the copy holding the lock."""
    return f'"{exe}" -m study.desktop --connect "%1"'


def register_protocol(exe: str) -> None:
    """Registers the link handler for the current user, which needs no administrator rights."""
    if os.name != "nt":
        return
    import winreg

    base = rf"Software\Classes\{PROTOCOL}"
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base) as key:
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, "URL:Study Library")
        winreg.SetValueEx(key, "URL Protocol", 0, winreg.REG_SZ, "")
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base + r"\shell\open\command") as key:
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, protocol_command(exe))


def manual_keys(missing: Sequence[str]) -> List[str]:
    """The missing settings that only a person editing the file can supply, since
    the connect keys are filled in by the studylibrary:// link instead."""
    return [key for key in missing if key not in CONNECT_KEYS]


def load_entry(spec: str) -> Callable[[], Any]:
    module_name, _, func_name = spec.partition(":")
    module = importlib.import_module(module_name)
    func = getattr(module, func_name or "main")
    if not callable(func):
        raise TypeError(f"{spec} is not callable")
    return func


def _module_available(name: str) -> bool:
    """Whether ``name`` can be imported, without running it. A missing parent
    package raises rather than returning None, and counts as missing too."""
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def check_child_modules(spec: str) -> Dict[str, bool]:
    """For each module the entry module says its children start by name (for
    instance uvicorn's "tts.server:app"), whether this build can import it.
    Static analysis never sees those names, so a bundle that lacks one still
    imports its entry module cleanly and only fails once the child starts."""
    module = importlib.import_module(spec.partition(":")[0])
    names = getattr(module, CHILD_MODULES_ATTR, ())
    return {name: _module_available(name) for name in names if isinstance(name, str)}


def run_module(module: str, args: Sequence[str]) -> int:
    """What ``python -m module args`` does, since the frozen build's
    sys.executable is StudyLibrary.exe and there is no python.exe to run."""
    sys.argv = [module, *args]
    try:
        runpy.run_module(module, run_name="__main__", alter_sys=True)
    except SystemExit as exc:
        return exc.code if isinstance(exc.code, int) else (0 if exc.code is None else 1)
    return 0


def run_tool_check(path: str, args: Sequence[str]) -> Dict[str, Any]:
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        proc = subprocess.run(
            [path, *args], capture_output=True, text=True, errors="replace", timeout=TOOL_TIMEOUT_S, creationflags=flags
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"exit_code": None, "output": f"{type(exc).__name__}: {exc}"}
    lines = [ln.strip() for ln in (proc.stdout + "\n" + proc.stderr).splitlines() if ln.strip()]
    return {"exit_code": proc.returncode, "output": lines[0][:200] if lines else ""}


def self_test(report_path: Path, env: MutableMapping[str, str], execute_tools: bool = True) -> int:
    report: Dict[str, Any] = {"ok": False, "frozen": rt.is_frozen(), "install_dir": str(rt.install_dir()), "errors": []}
    try:
        prep = prepare(env)
        report.update(home=str(prep.home), env_file=str(prep.env_file), missing_keys=prep.missing_keys)
        report["tools"] = {}
        for spec in prep.specs:
            status = prep.tools[spec.name]
            entry = asdict(status)
            if status.path and execute_tools:
                entry.update(run_tool_check(status.path, spec.check_args))
                if entry["exit_code"] != 0 and spec.required:
                    report["errors"].append(f"{spec.name} check failed: {entry['output']}")
            if status.source == "missing" and spec.required:
                report["errors"].append(f"required tool {spec.name} not found")
            report["tools"][spec.name] = entry
        report["assets"] = {a.name: {"pinned": a.pinned, "path": str(a.path_in(prep.paths["models"]))} for a in prep.assets}
        report["errors"].extend(f"asset {a.name} has no pinned sha256" for a in prep.assets if not a.pinned)
        entry_spec = env.get(ENTRY_ENV, DEFAULT_ENTRY)
        try:
            load_entry(entry_spec)
            report["entry"] = {"spec": entry_spec, "importable": True}
        except Exception as exc:
            report["entry"] = {"spec": entry_spec, "importable": False, "error": f"{type(exc).__name__}: {exc}"}
            report["errors"].append(f"entry point {entry_spec} failed to import")
        else:
            children = check_child_modules(entry_spec)
            report["entry"]["child_modules"] = children
            report["errors"].extend(f"child module {name} is not in this build" for name, ok in children.items() if not ok)
    except Exception as exc:
        report["errors"].append(f"preparation failed: {type(exc).__name__}: {exc}")
    report["ok"] = not report["errors"]
    rt.atomic_write_text(report_path, json.dumps(report, indent=2))
    return 0 if report["ok"] else 1


def _configure_logging(log_dir: Path) -> None:
    handler = logging.handlers.RotatingFileHandler(log_dir / "launcher.log", maxBytes=1_000_000, backupCount=3, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.addHandler(handler)
    root.setLevel(logging.INFO)


def _focus_running_instance(home: Path) -> None:
    info = rt.read_instance_info(home)
    if info and isinstance(info.get("url"), str) and info["url"].startswith("http://127.0.0.1"):
        webbrowser.open(info["url"])
    else:
        rt.message_box("Study Library", "Study Library is already running, so this second copy will close.")


def _offer_settings(prep: Prepared, keys_to_fill: Sequence[str]) -> None:
    keys = ", ".join(keys_to_fill)
    question = (
        f"Study Library still needs these settings before every feature will work: {keys}. "
        "Would you like to open the settings file now? Save it and restart Study Library once it is filled in."
    )
    if rt.message_box("Study Library settings", question, "question") and os.name == "nt":
        subprocess.Popen(["notepad.exe", str(prep.env_file)])


def _register_link_handler() -> None:
    """Only the installed build registers itself, so that a development run never
    points the link handler at a temporary location."""
    if not rt.is_frozen():
        return
    try:
        register_protocol(sys.executable)
    except OSError:
        log.warning("could not register the %s:// link handler", PROTOCOL, exc_info=True)


def _start_asset_repair(prep: Prepared) -> None:
    def work() -> None:
        results = slassets.ensure_assets(prep.assets, prep.paths["models"])
        for name, outcome in results.items():
            (log.info if outcome == "ok" else log.warning)("asset %s: %s", name, outcome)

    # Daemon is safe: an interrupted download leaves a .part file that the next launch resumes.
    threading.Thread(target=work, name="asset-repair", daemon=True).start()


def main(argv: Optional[Sequence[str]] = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    env = os.environ
    home = rt.home_dir(env)
    paths = rt.ensure_layout(home)
    rt.redirect_std_streams(paths["logs"])
    if len(argv) >= 2 and argv[0] == "-m":
        prepare(env)
        return run_module(argv[1], argv[2:])
    parser = argparse.ArgumentParser(prog="StudyLibrary", add_help=False)
    parser.add_argument("--self-test", metavar="REPORT_JSON")
    args, _unknown = parser.parse_known_args(argv)
    if args.self_test:
        return self_test(Path(args.self_test), env)
    _configure_logging(paths["logs"])
    lock = rt.FileLock(home / "instance.lock")
    if not lock.acquire():
        _focus_running_instance(home)
        return 0
    try:
        rt.clear_instance_info(home)  # anything written from now on belongs to this process
        prep = prepare(env)
        log.info("tools: %s", {n: (s.source, s.path) for n, s in prep.tools.items()})
        _register_link_handler()
        manual = manual_keys(prep.missing_keys)
        if manual:
            _offer_settings(prep, manual)
        _start_asset_repair(prep)
        result = load_entry(env.get(ENTRY_ENV, DEFAULT_ENTRY))()
        return result if isinstance(result, int) else 0
    except SystemExit as exc:
        return exc.code if isinstance(exc.code, int) else 0
    except Exception:
        log.exception("Study Library failed to start")
        rt.message_box(
            "Study Library",
            f"Study Library could not start. Details were written to {paths['logs'] / 'launcher.log'}.",
            "error",
        )
        return 1
    finally:
        lock.release()


if __name__ == "__main__":
    import multiprocessing

    multiprocessing.freeze_support()  # without this, frozen child processes re-run the whole app
    sys.exit(main())
