"""The frameless window's controls and the Cloudflare Access sign-in handoff,
which run without Windows or pywebview because every part that needs them is
passed in or stands behind WINDOWS."""

from __future__ import annotations

import base64
import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

import pytest

from study import desktop


def _token(claims: dict) -> str:
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"eyJhbGciOiJSUzI1NiJ9.{payload}.c2lnbmF0dXJl"


def _post(port: int, fields: dict[str, str], path: str = desktop.SIGN_IN_PATH) -> int:
    body = urllib.parse.urlencode(fields).encode()
    request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=body, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


def test_desktop_url_marks_the_frameless_window_apart():
    assert desktop.desktop_url("https://s.example/") == "https://s.example/?sl=desktop"
    assert desktop.desktop_url("https://s.example/?connect=processor", frameless=True) == "https://s.example/?connect=processor&sl=frameless"


@pytest.mark.parametrize("url, expected", [
    ("https://team.cloudflareaccess.com/cdn-cgi/access/login/s.example?kid=1", True),
    ("https://s.example/cdn-cgi/access/login?redirect_url=%2F", True),
    ("https://s.example/?sl=frameless", False),
    ("https://cloudflareaccess.com.evil.example/", False),
    ("", False),
])
def test_is_access_login(url, expected):
    assert desktop.is_access_login(url) is expected


def test_sign_in_url_needs_https_and_drops_any_user_info():
    assert desktop.sign_in_url("https://me@s.example/?sl=frameless", 51234, "abc") == "https://s.example/api/desktop-auth?port=51234&state=abc"
    assert desktop.sign_in_url("http://s.example/", 51234, "abc") is None


def test_access_cookie_expiry_reads_exp_and_ignores_anything_else():
    later = int(time.time()) + 3600
    assert desktop.access_cookie_expiry(_token({"exp": later})) == later
    assert desktop.access_cookie_expiry(_token({"exp": 1})) is None
    assert desktop.access_cookie_expiry(_token({})) is None
    assert desktop.access_cookie_expiry("not-a-token") is None


def test_listener_accepts_one_matching_post_then_closes():
    received: list[str] = []
    closed = threading.Event()
    port, state = desktop.listen_for_sign_in(received.append, timeout=10, on_close=closed.set)
    token = _token({"exp": int(time.time()) + 60})
    assert _post(port, {"cf_auth": token, "state": "wrong"}) == 400
    assert _post(port, {"cf_auth": "<script>", "state": state}) == 400
    assert _post(port, {"cf_auth": token, "state": state}, path="/elsewhere") == 404
    assert received == []
    assert _post(port, {"cf_auth": token, "state": state}) == 200
    assert closed.wait(5)
    assert received == [token]
    with pytest.raises(OSError):
        _post(port, {"cf_auth": token, "state": state})


def test_listener_gives_up_after_its_timeout():
    closed = threading.Event()
    desktop.listen_for_sign_in(lambda token: None, timeout=0.2, on_close=closed.set)
    assert closed.wait(5)


class _FakeWindow:
    def __init__(self, url: str):
        self.url = url
        self.loaded: list[str] = []

    def get_current_url(self) -> str:
        return self.url

    def load_url(self, url: str) -> None:
        self.loaded.append(url)


def test_handoff_opens_the_browser_once_and_returns_the_window_to_the_app():
    app = "https://s.example/?sl=frameless"
    window = _FakeWindow("https://team.cloudflareaccess.com/cdn-cgi/access/login/s.example")
    opened: list[str] = []
    cookies: list[tuple[str, str]] = []
    calls: dict = {}

    def listen(on_token, on_close):
        calls.update(on_token=on_token, on_close=on_close)
        return 50000, "state123"

    handoff = desktop.SignInHandoff(window, app, listen=listen, open_browser=lambda url: opened.append(url) or True,
                                    set_cookie=lambda w, host, token: cookies.append((host, token)) or True)
    handoff.on_loaded()
    handoff.on_loaded()
    assert opened == ["https://s.example/api/desktop-auth?port=50000&state=state123"]
    calls["on_token"]("a.b.c")
    assert cookies == [("s.example", "a.b.c")]
    assert window.loaded == [app]
    calls["on_close"]()
    assert handoff.start() is True
    assert len(opened) == 2


def test_handoff_ignores_the_app_itself_and_a_refused_cookie():
    window = _FakeWindow("https://s.example/?sl=frameless")
    opened: list[str] = []
    handoff = desktop.SignInHandoff(window, "https://s.example/", listen=lambda on_token, on_close: (1, "s"),
                                    open_browser=opened.append, set_cookie=lambda *args: False)
    handoff.on_loaded()
    assert opened == []
    handoff._receive("a.b.c")
    assert window.loaded == []


class _Event(list):
    """Takes handlers with += as a pywebview event does."""

    def __iadd__(self, handler):
        self.append(handler)
        return self


class _Events:
    def __init__(self):
        self.maximized = _Event()
        self.restored = _Event()


class _ControlledWindow:
    def __init__(self):
        self.events = _Events()
        self.calls: list[str] = []

    def minimize(self):
        self.calls.append("minimize")

    def maximize(self):
        self.calls.append("maximize")

    def restore(self):
        self.calls.append("restore")

    def destroy(self):
        self.calls.append("destroy")


def test_window_api_drives_the_window_and_follows_its_state():
    window = _ControlledWindow()
    api = desktop.WindowApi()
    api._bind(window)
    assert api.toggle_maximize() is True
    assert api.toggle_maximize() is False
    api.minimize()
    api.close()
    assert window.calls == ["maximize", "restore", "minimize", "destroy"]
    # A maximise by Windows itself, such as Win+Up, is followed too.
    window.events.maximized[0]()
    assert api.is_maximized() is True
    window.events.restored[0]()
    assert api.is_maximized() is False


def test_window_api_hides_the_window_from_the_page():
    exposed = {name for name in dir(desktop.WindowApi()) if not name.startswith("_")}
    assert exposed == {"minimize", "toggle_maximize", "is_maximized", "close", "open_in_browser"}


def test_open_in_browser_refuses_anything_but_http(monkeypatch):
    opened: list[str] = []
    monkeypatch.setattr(desktop.webbrowser, "open", lambda url: opened.append(url) or True)
    api = desktop.WindowApi()
    assert api.open_in_browser("https://example.org/") is True
    assert api.open_in_browser("file:///C:/Windows/System32/calc.exe") is False
    assert api.open_in_browser("ms-settings:") is False
    assert opened == ["https://example.org/"]


def test_webview_user_agent_comes_from_the_launcher():
    agent = "Mozilla/5.0 (Windows NT 10.0) Edg/131.0.0.0 SLDesktop/1"
    assert desktop.webview_user_agent({"WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS": f'--x --user-agent="{agent}"'}) == agent
    assert desktop.webview_user_agent({}) is None


def test_main_falls_back_to_edge_without_the_frameless_window(monkeypatch, tmp_path):
    monkeypatch.setenv("STUDY_HOME", str(tmp_path))
    (tmp_path / ".env").write_text("STUDY_URL=https://s.example/\n")
    opened: list[str] = []
    monkeypatch.setattr(desktop, "open_frameless", lambda home, url, colour: opened.append(url) and False)
    monkeypatch.setattr(desktop, "open_window", lambda url, colour: opened.append(url))
    assert desktop.main(["--app-only"]) == 0
    assert opened == ["https://s.example/?connect=processor&sl=frameless", "https://s.example/?connect=processor&sl=desktop"]


def test_open_frameless_declines_off_windows(monkeypatch, tmp_path):
    monkeypatch.setattr(desktop, "WINDOWS", False)
    assert desktop.open_frameless(tmp_path, "https://s.example/") is False
