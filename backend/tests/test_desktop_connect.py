# filename: repo/backend/tests/test_desktop_connect.py
"""Acceptance tests for "Connect this computer" (docs/connect-design.md).

Run from the repository root:  python -m pytest backend/tests/test_desktop_connect.py -q
They run on any OS, because every Windows-only call is behind WINDOWS or is
replaced here, and they need no network, because the ping is injected.
"""
from __future__ import annotations

import importlib.util
import io
import json
import sys
import types
import urllib.error
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
REPO = BACKEND.parent
sys.path.insert(0, str(BACKEND))

from study import desktop  # noqa: E402

# Byte-for-byte what connectLink() returns in connect.test.ts for the same secrets.
GOLDEN_LINK = "studylibrary://connect?v=1&PROCESSOR_KEY=a%2Bb%2Fc%3D&CF_ACCESS_CLIENT_ID=0f.access&CF_ACCESS_CLIENT_SECRET=ff"
GOLDEN = {"PROCESSOR_KEY": "a+b/c=", "CF_ACCESS_CLIENT_ID": "0f.access", "CF_ACCESS_CLIENT_SECRET": "ff"}
SECRET = "5ecret5ecret5ecret"


def link(**overrides: str) -> str:
    from urllib.parse import urlencode

    values = {"v": "1", **GOLDEN, **overrides}
    return "studylibrary://connect?" + urlencode({k: v for k, v in values.items() if v is not None})


class Ping:
    """Stands in for desktop._ping and records where the secret went."""

    def __init__(self, answer=None, raises: BaseException | None = None):
        self.answer = {"ok": True} if answer is None else answer
        self.raises = raises
        self.calls: list[tuple[str, dict]] = []

    def __call__(self, url, headers):
        self.calls.append((url, dict(headers)))
        if self.raises:
            raise self.raises
        return self.answer


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("STUDY_HOME", str(tmp_path))
    for key in ("STUDY_URL", *desktop.CONNECT_KEYS):
        monkeypatch.delenv(key, raising=False)
    (tmp_path / ".env").write_text(
        "\ufeff# Study Library\nSTUDY_URL=https://study.example.org\nPROCESSOR_KEY=\nCF_ACCESS_CLIENT_ID=\n"
        "CF_ACCESS_CLIENT_SECRET=\nLOG_LEVEL=DEBUG\n",
        encoding="utf-8",
    )
    return tmp_path


# 1. The link format shared with the Worker.

def test_golden_link_parses_to_the_three_settings():
    assert desktop.parse_connect_link(GOLDEN_LINK) == GOLDEN


@pytest.mark.parametrize("variant", [
    GOLDEN_LINK.replace("connect?", "connect/?"),
    GOLDEN_LINK.replace("studylibrary://", "StudyLibrary://"),
    GOLDEN_LINK.replace("studylibrary://", "studylibrary:"),
    "  " + GOLDEN_LINK + "\n",
])
def test_harmless_spellings_of_the_link_are_accepted(variant):
    assert desktop.parse_connect_link(variant) == GOLDEN


@pytest.mark.parametrize("bad", [
    GOLDEN_LINK.replace("studylibrary", "https"),
    GOLDEN_LINK.replace("connect?", "disconnect?"),
    link(v="2"),
    link(v=None),
    link(PROCESSOR_KEY=None),
    link(PROCESSOR_KEY=""),
    link(STUDY_URL="https://evil.example"),
    link(PATH="C:\\evil"),
    GOLDEN_LINK + "&PROCESSOR_KEY=again",
    link(PROCESSOR_KEY="has space"),
    link(PROCESSOR_KEY='has"quote'),
    link(PROCESSOR_KEY="has#hash"),
    link(PROCESSOR_KEY="line\nbreak"),
    link(PROCESSOR_KEY="x" * 513),
    link(PROCESSOR_KEY="caf\u00e9"),
])
def test_anything_else_refuses_the_whole_link(bad):
    with pytest.raises(desktop.ConnectError):
        desktop.parse_connect_link(bad)


def test_refusals_never_echo_a_value():
    with pytest.raises(desktop.ConnectError) as caught:
        desktop.parse_connect_link(link(PROCESSOR_KEY=SECRET + " "))
    assert SECRET not in str(caught.value)


# 2. The credential check against this installation's own STUDY_URL.

def test_check_sends_the_token_only_to_study_url_ping():
    ping = Ping()
    desktop.check_credentials("https://study.example.org/some/path?q=1", GOLDEN, ping)
    assert ping.calls == [("https://study.example.org/api/ping",
                           {"CF-Access-Client-Id": "0f.access", "CF-Access-Client-Secret": "ff"})]


@pytest.mark.parametrize("url", ["", "http://study.example.org", "study.example.org", "https://"])
def test_no_https_study_url_means_nothing_is_sent(url):
    ping = Ping()
    with pytest.raises(desktop.ConnectError):
        desktop.check_credentials(url, GOLDEN, ping)
    assert ping.calls == []


@pytest.mark.parametrize("ping", [
    Ping(raises=urllib.error.HTTPError("u", 302, "Found", {}, io.BytesIO())),
    Ping(raises=urllib.error.HTTPError("u", 403, "Forbidden", {}, io.BytesIO())),
    Ping(raises=urllib.error.URLError("offline")),
    Ping(raises=TimeoutError()),
    Ping(raises=json.JSONDecodeError("x", "<html>", 0)),
    Ping(answer={"ok": False}),
    Ping(answer=["ok"]),
])
def test_any_refusal_or_failure_is_a_connect_error(ping):
    with pytest.raises(desktop.ConnectError):
        desktop.check_credentials("https://study.example.org", GOLDEN, ping)


def test_redirects_are_not_followed():
    handler = desktop._NoRedirect()
    assert handler.redirect_request(None, None, 302, "Found", {}, "https://x.cloudflareaccess.com/login") is None


# 3. Saving.

def test_merge_fills_template_lines_in_place_and_keeps_the_rest():
    text = "# c\nexport PROCESSOR_KEY=old\nSTUDY_URL=https://s\nCF_ACCESS_CLIENT_ID=\nCF_ACCESS_CLIENT_ID=dup\n#CF_ACCESS_CLIENT_SECRET=x\n"
    merged = desktop.merge_env_text(text, GOLDEN)
    assert merged.splitlines() == [
        "# c", "PROCESSOR_KEY=a+b/c=", "STUDY_URL=https://s", "CF_ACCESS_CLIENT_ID=0f.access",
        "#CF_ACCESS_CLIENT_SECRET=x", "CF_ACCESS_CLIENT_SECRET=ff",
    ]
    assert desktop.merge_env_text(merged, GOLDEN) == merged


def test_connect_saves_and_every_reader_sees_the_values(home):
    ping = Ping()
    path = desktop.connect(home, GOLDEN_LINK, ping)
    assert path == home / ".env"
    saved = desktop.load_env_file(path)
    assert {k: saved[k] for k in GOLDEN} == GOLDEN
    assert saved["STUDY_URL"] == "https://study.example.org" and saved["LOG_LEVEL"] == "DEBUG"
    assert ping.calls[0][0] == "https://study.example.org/api/ping"
    assert not list(home.glob(".env.*.tmp"))


def test_a_refused_link_leaves_the_file_byte_for_byte(home):
    before = (home / ".env").read_bytes()
    with pytest.raises(desktop.ConnectError):
        desktop.connect(home, GOLDEN_LINK, Ping(answer={"ok": False}))
    assert (home / ".env").read_bytes() == before


def test_a_failed_write_leaves_the_old_file_and_no_temporary(home, monkeypatch):
    before = (home / ".env").read_bytes()

    def broken_replace(*_):
        raise OSError("disk full")

    monkeypatch.setattr(desktop.os, "replace", broken_replace)
    with pytest.raises(OSError):
        desktop.connect(home, GOLDEN_LINK, Ping())
    assert (home / ".env").read_bytes() == before
    assert not list(home.glob(".env.*.tmp"))


def test_connect_works_without_any_env_file_if_study_url_is_in_the_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("STUDY_URL", "https://study.example.org")
    desktop.connect(tmp_path, GOLDEN_LINK, Ping())
    assert desktop.load_env_file(tmp_path / ".env")["PROCESSOR_KEY"] == "a+b/c="


# 4. Reading: one file for both layouts, with home\.env last.

def test_home_env_wins_over_the_checkout_env_and_the_environment(tmp_path):
    (tmp_path / "repo" / "backend").mkdir(parents=True)
    (tmp_path / "repo" / "backend" / ".env").write_text("PROCESSOR_KEY=repo\nONLY_REPO=1\n")
    (tmp_path / ".env").write_text("PROCESSOR_KEY=home\n")
    env = desktop.prepare_environment(tmp_path, {"PROCESSOR_KEY": "inherited", "PATH": ""})
    assert env["PROCESSOR_KEY"] == "home" and env["ONLY_REPO"] == "1"


def test_settings_stamp_moves_when_a_file_changes(tmp_path):
    first = desktop.settings_stamp(tmp_path)
    (tmp_path / ".env").write_text("A=1\n")
    second = desktop.settings_stamp(tmp_path)
    (tmp_path / ".env").write_text("A=12\n")
    assert first != second != desktop.settings_stamp(tmp_path)


# 5. The window hint.

def test_window_url_hints_only_while_a_setting_is_missing():
    assert desktop.window_url("https://s.org", {}) == "https://s.org?connect=processor"
    assert desktop.window_url("https://s.org/?tab=x", {"PROCESSOR_KEY": "k"}) == "https://s.org/?tab=x&connect=processor"
    assert desktop.window_url("https://s.org", dict(GOLDEN)) == "https://s.org"


def test_main_opens_the_window_with_the_hint(home, monkeypatch):
    opened = []
    monkeypatch.setattr(desktop, "open_window", opened.append)
    assert desktop.main(["--app-only"]) == 0
    assert opened == ["https://study.example.org?connect=processor"]


# 6. The --connect mode end to end, as the protocol handler runs it.

def test_main_connect_succeeds_and_says_so(home, monkeypatch, caplog):
    said = []
    monkeypatch.setattr(desktop, "_ping", Ping())
    monkeypatch.setattr(desktop, "connect", lambda h, l, ping=desktop._ping: desktop.connect.__wrapped__(h, l, ping))
    monkeypatch.setattr(desktop, "_notify", lambda text, error=False: said.append((text, error)))
    monkeypatch.setattr(desktop, "connect", _connect_with(Ping()))
    assert desktop.main(["--connect", GOLDEN_LINK]) == 0
    assert said and said[0][1] is False
    assert desktop.load_env_file(home / ".env")["CF_ACCESS_CLIENT_SECRET"] == "ff"
    assert "ff" not in caplog.text.replace("off", "")


def test_main_connect_refusal_exits_2_and_logs_no_secret(home, monkeypatch, caplog):
    said = []
    monkeypatch.setattr(desktop, "_notify", lambda text, error=False: said.append((text, error)))
    monkeypatch.setattr(desktop, "connect", _connect_with(Ping(answer={"ok": False})))
    assert desktop.main(["--connect", link(PROCESSOR_KEY=SECRET)]) == 2
    assert said and said[0][1] is True
    assert SECRET not in caplog.text and SECRET not in said[0][0]


_real_connect = desktop.connect


def _connect_with(ping):
    return lambda h, l: _real_connect(h, l, ping)


# 7. The supervisor restarts its children with new settings within one tick.

class FakeProc:
    def __init__(self, env):
        self.env, self.returncode = env, None

    def poll(self):
        return self.returncode

    def wait(self, _timeout=None):
        self.returncode = 0 if self.returncode is None else self.returncode
        return self.returncode

    def terminate(self):
        self.returncode = 1

    def kill(self):
        self.returncode = -9


class StopLoop(Exception):
    pass


def test_supervisor_reloads_settings_without_waiting_for_backoff(home, monkeypatch):
    started: list[tuple[str, dict]] = []

    def fake_start(_home, env, name):
        started.append((name, dict(env)))
        proc = FakeProc(env)
        if not env.get("PROCESSOR_KEY") and name == "processor":
            proc.returncode = 1  # exits at once without its settings, as the real one does
        return proc

    ticks = {"n": 0}

    def fake_sleep(_seconds):
        ticks["n"] += 1
        if ticks["n"] == 2:
            desktop.connect(home, GOLDEN_LINK, Ping())
        if ticks["n"] == 4:
            raise StopLoop

    monkeypatch.setattr(desktop, "acquire_single_instance", lambda *a: desktop._Instance(None))
    monkeypatch.setattr(desktop, "update_checkout", lambda _h: False)
    monkeypatch.setattr(desktop, "_start", fake_start)
    monkeypatch.setattr(desktop.time, "sleep", fake_sleep)
    with pytest.raises(StopLoop):
        desktop.supervise(home)
    processor_envs = [env for name, env in started if name == "processor"]
    assert processor_envs[0]["PROCESSOR_KEY"] == ""
    assert processor_envs[-1]["PROCESSOR_KEY"] == "a+b/c="
    assert processor_envs[-1]["PROCESSOR_STOP_FILE"] == str(home / "processor.stop")
    assert [env["PROCESSOR_KEY"] for name, env in started if name == "tts"][-1] == "a+b/c="
    assert not (home / "processor.stop").exists()


# 8. The launcher: protocol registration, no Notepad for these keys, routing.

def _find_launcher() -> Path | None:
    direct = REPO / "packaging" / "windows" / "launcher.py"
    if direct.is_file():
        return direct
    skip = {".venv", "node_modules", "build", "dist", ".git", "Study"}
    for path in REPO.rglob("launcher.py"):
        if not skip & set(path.parts) and "STUDY_ENTRY" in path.read_text(encoding="utf-8", errors="ignore"):
            return path
    return None


@pytest.fixture
def launcher(monkeypatch):
    path = _find_launcher()
    if path is None:
        pytest.skip("launcher.py is not in this checkout")
    for name in ("slassets", "slruntime"):
        monkeypatch.setitem(sys.modules, name, types.ModuleType(name))
    spec = importlib.util.spec_from_file_location("launcher_under_test", path)
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, "launcher_under_test", module)
    spec.loader.exec_module(module)
    return module


def test_launcher_and_desktop_agree_on_the_connect_keys(launcher):
    assert tuple(launcher.CONNECT_KEYS) == desktop.CONNECT_KEYS
    assert launcher.PROTOCOL == desktop.CONNECT_SCHEME


def test_protocol_command_goes_through_the_lock_free_module_path(launcher):
    assert launcher.protocol_command(r"C:\Program Files\Study Library\StudyLibrary.exe") == (
        r'"C:\Program Files\Study Library\StudyLibrary.exe" -m study.desktop --connect "%1"'
    )


def test_only_other_missing_keys_send_the_person_to_notepad(launcher):
    assert launcher.manual_keys(list(desktop.CONNECT_KEYS)) == []
    assert launcher.manual_keys(["STUDY_URL", "PROCESSOR_KEY"]) == ["STUDY_URL"]


def test_the_protocol_command_reaches_desktop_connect(launcher, tmp_path, monkeypatch):
    rt = sys.modules["slruntime"]
    rt.home_dir = lambda env: tmp_path
    rt.ensure_layout = lambda home: {"logs": tmp_path}
    rt.redirect_std_streams = lambda logs: None
    ran = []
    monkeypatch.setattr(launcher, "prepare", lambda env: None)
    monkeypatch.setattr(launcher, "run_module", lambda module, args: ran.append((module, list(args))) or 0)
    assert launcher.main(["-m", "study.desktop", "--connect", GOLDEN_LINK]) == 0
    assert ran == [("study.desktop", ["--connect", GOLDEN_LINK])]


# 9. The packaged settings template ships STUDY_URL and leaves the secrets empty.

def test_env_template_ships_study_url_but_no_secret():
    direct = REPO / "packaging" / "windows" / "env.template"
    templates = [direct] if direct.is_file() else []
    if not templates:
        pytest.skip("env.template is not in this checkout")
    for template in templates:
        values = desktop.load_env_file(template)
        assert values.get("STUDY_URL", "").startswith("https://"), template
        assert all(not values.get(key) for key in desktop.CONNECT_KEYS), template
