"""Windows entry point for Study Library.

PyInstaller compiles this file into StudyLibrary.exe. It prepares the runtime
environment (bundled tools, per-user .env, model paths, WebView2 settings),
makes sure that only one copy runs at a time, registers the studylibrary://
link handler for the current user, and then hands control to the application
entry point, which defaults to study.desktop:main and can be overridden with
STUDY_ENTRY.

The window itself is created by the entry module, so the launcher shapes it
from outside: WebView2 reads its background colour and extra browser arguments
from the environment, which is how the page is painted in the app's own colour
before it loads and how "SLDesktop/1" reaches the user agent, and a background
thread recolours the native title bar of every window this process shows, so
that no dark strip sits above a light page.

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
import time
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
# The web app looks for this in navigator.userAgent to know it is inside the desktop app.
DESKTOP_UA_TOKEN = "SLDesktop/1"
WEBVIEW_ARGS_ENV = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"
WEBVIEW_BACKGROUND_ENV = "WEBVIEW2_DEFAULT_BACKGROUND_COLOR"
# The Evergreen WebView2 Runtime's client id, under which EdgeUpdate records its version.
WEBVIEW_CLIENT = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
# The page background and text in each theme, which must stay identical to --bg
# and --ink in app/src/styles.css so that the title bar reads as part of the page.
CAPTION_LIGHT = "#f6f5f3"
CAPTION_DARK = "#1c1917"
CAPTION_TEXT_LIGHT = "#1c1917"
CAPTION_TEXT_DARK = "#f6f5f3"
DWMWA_USE_IMMERSIVE_DARK_MODE = 20
DWMWA_CAPTION_COLOR = 35
DWMWA_TEXT_COLOR = 36
GW_OWNER = 4
# A process that shows no window within this time is a headless child, so it stops looking.
CAPTION_WATCH_S = 120
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
    prepare_webview(env)
    required = rt.required_keys(template.read_text(encoding="utf-8-sig")) if template.is_file() else []
    return Prepared(home, paths, specs, tools, assets, env_file, seeded, rt.missing_keys(required, env))


def caption_colour(dark: bool) -> str:
    return CAPTION_DARK if dark else CAPTION_LIGHT


def colorref(colour: str) -> int:
    """A #rrggbb colour as the 0x00bbggrr COLORREF that DWM expects."""
    value = colour.lstrip("#")
    red, green, blue = (int(value[i : i + 2], 16) for i in (0, 2, 4))
    return red | (green << 8) | (blue << 16)


def background_argb(colour: str) -> str:
    """WebView2 reads its default background as ARGB hex, and a value shorter
    than eight digits counts as transparent, so the opaque alpha is spelt out."""
    return "FF" + colour.lstrip("#").upper()


def desktop_user_agent(runtime_version: str) -> Optional[str]:
    """The user agent that this WebView2 runtime sends by default, in the reduced
    form Chromium uses where only the major version is real, with the desktop
    token appended. Chromium can only replace a user agent rather than extend it,
    so the default has to be rebuilt from the runtime's version."""
    major = runtime_version.split(".", 1)[0]
    if not major.isdigit() or major == "0":
        return None
    version = f"{major}.0.0.0"
    return (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
        f"Chrome/{version} Safari/537.36 Edg/{version} {DESKTOP_UA_TOKEN}"
    )


def with_user_agent(arguments: str, agent: str) -> str:
    """Adds the user agent to any browser arguments already set, leaving a user
    agent that someone chose deliberately in place, so that a relaunched child
    never adds a second one."""
    if "--user-agent" in arguments:
        return arguments
    return f'{arguments} --user-agent="{agent}"'.strip()


def _webview_version() -> Optional[str]:
    """The installed WebView2 runtime's version, from wherever EdgeUpdate
    recorded it for a machine-wide or a per-user installation."""
    import winreg

    key_path = rf"Microsoft\EdgeUpdate\Clients\{WEBVIEW_CLIENT}"
    places = (
        (winreg.HKEY_LOCAL_MACHINE, rf"SOFTWARE\WOW6432Node\{key_path}"),
        (winreg.HKEY_LOCAL_MACHINE, rf"SOFTWARE\{key_path}"),
        (winreg.HKEY_CURRENT_USER, rf"Software\{key_path}"),
    )
    for root, path in places:
        try:
            with winreg.OpenKey(root, path) as key:
                value, _kind = winreg.QueryValueEx(key, "pv")
        except OSError:
            continue
        if isinstance(value, str) and value and value != "0.0.0.0":
            return value
    return None


def windows_dark_mode() -> bool:
    """Whether Windows is set to dark mode for apps, which the title bar follows
    until the page can tell the shell which of its own themes is showing."""
    if os.name != "nt":
        return False
    import winreg

    try:
        path = r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path) as key:
            value, _kind = winreg.QueryValueEx(key, "AppsUseLightTheme")
    except OSError:
        return False
    return value == 0


def prepare_webview(env: MutableMapping[str, str]) -> None:
    """Sets what every WebView2 started by this process or its children reads
    from the environment. Calling it again is harmless, since a child inherits
    the values its parent set and keeps them."""
    if os.name != "nt":
        return
    env.setdefault(WEBVIEW_BACKGROUND_ENV, background_argb(caption_colour(windows_dark_mode())))
    version = _webview_version()
    agent = desktop_user_agent(version) if version else None
    if agent:
        env[WEBVIEW_ARGS_ENV] = with_user_agent(env.get(WEBVIEW_ARGS_ENV, ""), agent)
    else:
        log.warning("the WebView2 runtime version could not be read, so %s is not in the user agent", DESKTOP_UA_TOKEN)


def apply_caption(hwnd: int, dark: bool) -> bool:
    """Colours one window's title bar to match the page. Windows 10 has no
    caption colour, so there only the dark mode flag takes effect."""
    import ctypes
    from ctypes import wintypes

    dwm = ctypes.windll.dwmapi

    def set_attribute(attribute: int, value: int) -> bool:
        data = wintypes.DWORD(value)
        return dwm.DwmSetWindowAttribute(wintypes.HWND(hwnd), attribute, ctypes.byref(data), ctypes.sizeof(data)) == 0

    set_attribute(DWMWA_USE_IMMERSIVE_DARK_MODE, int(dark))
    coloured = set_attribute(DWMWA_CAPTION_COLOR, colorref(caption_colour(dark)))
    set_attribute(DWMWA_TEXT_COLOR, colorref(CAPTION_TEXT_DARK if dark else CAPTION_TEXT_LIGHT))
    return coloured


def _own_windows() -> List[int]:
    """The visible top-level windows that belong to this process."""
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    user32.GetWindow.restype = wintypes.HWND
    pid = os.getpid()
    found: List[int] = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def visit(hwnd: Optional[int], _param: int) -> bool:
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if hwnd and owner.value == pid and user32.IsWindowVisible(hwnd) and not user32.GetWindow(hwnd, GW_OWNER):
            found.append(hwnd)
        return True

    user32.EnumWindows(visit, 0)
    return found


def _start_caption_watch() -> None:
    """Recolours each window's title bar as it appears, and again whenever
    Windows switches between light and dark mode."""
    if os.name != "nt":
        return

    def work() -> None:
        styled: Dict[int, bool] = {}
        started = time.monotonic()
        try:
            while styled or time.monotonic() - started < CAPTION_WATCH_S:
                dark = windows_dark_mode()
                present = _own_windows()
                for hwnd in present:
                    if styled.get(hwnd) != dark:
                        apply_caption(hwnd, dark)
                        styled[hwnd] = dark
                styled = {hwnd: styled[hwnd] for hwnd in present}
                time.sleep(1.0 if styled else 0.25)
        except Exception:
            log.warning("the title bar could not be recoloured", exc_info=True)

    # Daemon is safe: a title bar left uncoloured costs nothing when the app exits.
    threading.Thread(target=work, name="caption-colour", daemon=True).start()


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
        report["webview"] = {"arguments": env.get(WEBVIEW_ARGS_ENV, ""), "background": env.get(WEBVIEW_BACKGROUND_ENV, "")}
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
        _start_caption_watch()
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
        _start_caption_watch()
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
