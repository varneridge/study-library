"""The frameless window's controls, its native frame calculations, the
studylibrary://open links and the Cloudflare Access sign-in handoff, which run
without Windows or pywebview because every part that needs them is passed in
or stands behind WINDOWS."""

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


@pytest.fixture(autouse=True)
def _own_window_lock(monkeypatch, tmp_path):
    """Each test takes a window lock of its own, so that none waits on another's."""
    monkeypatch.setattr(desktop, "WINDOW_MUTEX_NAME", f"StudyLibraryTest-{tmp_path.name}")


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
    monkeypatch.setattr(desktop, "open_frameless", lambda home, url, colour, navigate=None: opened.append(url) and False)
    monkeypatch.setattr(desktop, "open_window", lambda url, colour=None: opened.append(url))
    assert desktop.main(["--app-only"]) == 0
    assert opened == ["https://s.example/?connect=processor&sl=frameless", "https://s.example/?connect=processor&sl=desktop"]


def test_open_frameless_declines_off_windows(monkeypatch, tmp_path):
    monkeypatch.setattr(desktop, "WINDOWS", False)
    assert desktop.open_frameless(tmp_path, "https://s.example/") is False


# The native frame: maximised bounds, hit-test zones and mouse coordinates.

@pytest.mark.parametrize("monitor, work", [
    ((0, 0, 1920, 1080), (0, 0, 1920, 1040)),          # taskbar along the bottom
    ((0, 0, 2560, 1440), (0, 48, 2560, 1440)),         # taskbar along the top
    ((-1920, 0, 0, 1080), (-1872, 0, 0, 1080)),        # a monitor to the left, taskbar on its left
    ((1920, -300, 3840, 780), (1920, -300, 3840, 780)),  # a monitor above and right, with no taskbar
])
def test_maximised_window_fills_the_work_area_and_never_the_taskbar(monitor, work):
    border = 8
    x, y, width, height = desktop.maximised_bounds(work, monitor, border)
    window = (monitor[0] + x, monitor[1] + y, monitor[0] + x + width, monitor[1] + y + height)
    # WM_NCCALCSIZE insets a maximised window by the border, which leaves the work area exactly.
    assert desktop.inset_rect(window, border) == work


def test_maximised_bounds_reach_past_the_work_area_by_the_border_alone():
    assert desktop.maximised_bounds((0, 0, 1920, 1040), (0, 0, 1920, 1080), 8) == (-8, -8, 1936, 1056)


@pytest.mark.parametrize("x, y, expected", [
    (100, 100, desktop.HTTOPLEFT),
    (899, 100, desktop.HTTOPRIGHT),
    (100, 699, desktop.HTBOTTOMLEFT),
    (899, 699, desktop.HTBOTTOMRIGHT),
    (500, 107, desktop.HTTOP),
    (500, 692, desktop.HTBOTTOM),
    (107, 400, desktop.HTLEFT),
    (892, 400, desktop.HTRIGHT),
    (108, 400, desktop.HTCLIENT),
    (891, 400, desktop.HTCLIENT),
    (500, 108, desktop.HTCLIENT),
    (50, 50, desktop.HTNOWHERE),
    (900, 400, desktop.HTNOWHERE),
])
def test_hit_test_finds_the_edges_and_corners_within_the_border(x, y, expected):
    assert desktop.hit_test(x, y, (100, 100, 900, 700), 8, zoomed=False) == expected


def test_a_maximised_window_has_no_resize_edges():
    assert desktop.hit_test(100, 100, (100, 100, 900, 700), 8, zoomed=True) == desktop.HTCLIENT
    assert desktop.hit_test(899, 699, (100, 100, 900, 700), 8, zoomed=True) == desktop.HTCLIENT


@pytest.mark.parametrize("x, y", [(1919, 1079), (-5, 20), (-1920, -300), (0, 0)])
def test_point_from_lparam_keeps_negative_coordinates(x, y):
    assert desktop.point_from_lparam(((y & 0xFFFF) << 16) | (x & 0xFFFF)) == (x, y)


def test_native_frame_styles_keep_snap_resize_and_the_taskbar():
    for style in (desktop.WS_THICKFRAME, desktop.WS_MAXIMIZEBOX, desktop.WS_MINIMIZEBOX, desktop.WS_SYSMENU):
        assert desktop.NATIVE_FRAME_STYLES & style == style


# studylibrary://open links.

@pytest.mark.parametrize("link, expected", [
    ("studylibrary://open?path=/library/42", "/library/42"),
    ("studylibrary://open?path=%2Flibrary%2F42%3Ftab%3Dnotes%23p3", "/library/42?tab=notes#p3"),
    ("studylibrary://open/?path=/notes/caf%C3%A9%201", "/notes/caf%C3%A9%201"),
    ("STUDYLIBRARY:open?path=/a", "/a"),
    ("  studylibrary://open?path=/a  ", "/a"),
    ("studylibrary://open", "/"),
    ("studylibrary://open?path=", "/"),
    ("studylibrary://open?other=/a", "/"),
    ("studylibrary://open?path=/a&path=/b", "/"),
    ("studylibrary://open?path=library", "/"),
    ("studylibrary://open?path=//evil.example/", "/"),
    ("studylibrary://open?path=/%5Cevil.example", "/"),
    ("studylibrary://open?path=https://evil.example/", "/"),
    ("studylibrary://open?path=javascript:alert(1)", "/"),
    ("studylibrary://open?path=/a/../../b", "/"),
    ("studylibrary://open?path=/a%0Ab", "/"),
    ("studylibrary://open?path=/" + "a" * desktop.OPEN_PATH_LIMIT, "/"),
])
def test_parse_open_link_gives_a_safe_app_path(link, expected):
    assert desktop.parse_open_link(link) == expected


@pytest.mark.parametrize("link", [
    "studylibrary://connect?v=1&PROCESSOR_KEY=a&CF_ACCESS_CLIENT_ID=b&CF_ACCESS_CLIENT_SECRET=c",
    "studylibrary://openx?path=/a",
    "https://s.example/?path=/a",
    "",
])
def test_parse_open_link_leaves_other_links_alone(link):
    assert desktop.parse_open_link(link) is None


def test_app_address_puts_the_path_on_the_app_host_ahead_of_the_hints():
    connected = dict.fromkeys(desktop.CONNECT_KEYS, "x")
    assert desktop.app_address("https://s.example/", "/", connected, frameless=True) == "https://s.example/?sl=frameless"
    assert (desktop.app_address("https://s.example/app/", "/library/42?tab=notes#p3", {}, frameless=False)
            == "https://s.example/library/42?tab=notes&connect=processor&sl=desktop#p3")


def test_a_forwarded_link_reaches_the_open_window_once_checked(tmp_path):
    received: list[str] = []
    arrived = threading.Event()
    stop = desktop.listen_for_links(tmp_path, lambda path: (received.append(path), arrived.set()))
    try:
        assert desktop.forward_to_window(tmp_path, "/library/42") is True
        assert arrived.wait(5)
        arrived.clear()
        # A launch that skipped the checks still cannot send the window elsewhere.
        assert desktop.forward_to_window(tmp_path, "//evil.example/") is True
        assert arrived.wait(5)
        assert received == ["/library/42", "/"]
        info = json.loads((tmp_path / desktop.WINDOW_FILE).read_text())
        (tmp_path / desktop.WINDOW_FILE).write_text(json.dumps({**info, "secret": "guessed"}))
        assert desktop.forward_to_window(tmp_path, "/elsewhere") is False
        assert received == ["/library/42", "/"]
    finally:
        stop()
    assert not (tmp_path / desktop.WINDOW_FILE).exists()
    assert desktop.forward_to_window(tmp_path, "/library/42") is False


def test_main_hands_an_open_link_to_the_window_already_open(monkeypatch, tmp_path):
    monkeypatch.setenv("STUDY_HOME", str(tmp_path))
    forwarded: list[str] = []
    monkeypatch.setattr(desktop, "forward_to_window", lambda home, path: forwarded.append(path) or True)
    monkeypatch.setattr(desktop, "_spawn_supervisor", lambda home, handover: pytest.fail("started a supervisor"))
    monkeypatch.setattr(desktop, "open_frameless", lambda *args, **kwargs: pytest.fail("opened a second window"))
    held = desktop.acquire_single_instance(desktop.WINDOW_MUTEX_NAME)
    assert held is not None
    try:
        assert desktop.main(["--connect", "studylibrary://open?path=/library/42"]) == 0
    finally:
        held.close()
    assert forwarded == ["/library/42"]


def test_main_opens_a_fresh_window_at_the_link_and_listens_for_more(monkeypatch, tmp_path):
    monkeypatch.setenv("STUDY_HOME", str(tmp_path))
    (tmp_path / ".env").write_text("STUDY_URL=https://s.example/\n")
    monkeypatch.setattr(desktop, "_spawn_supervisor", lambda home, handover: None)
    monkeypatch.setattr(desktop, "forward_to_window", lambda home, path: pytest.fail("no window was open"))
    opened: list[tuple[str, str]] = []

    def frameless(home, url, colour, navigate=None):
        opened.append((url, navigate("/next")))
        return True

    monkeypatch.setattr(desktop, "open_frameless", frameless)
    assert desktop.main(["studylibrary://open?path=/library/42"]) == 0
    assert opened == [("https://s.example/library/42?connect=processor&sl=frameless",
                       "https://s.example/next?connect=processor&sl=frameless")]
    # The window lock is let go once the window closes.
    again = desktop.acquire_single_instance(desktop.WINDOW_MUTEX_NAME)
    assert again is not None
    again.close()


def test_main_still_runs_connect_for_a_connect_link(monkeypatch, tmp_path):
    monkeypatch.setenv("STUDY_HOME", str(tmp_path))
    links: list[str] = []
    monkeypatch.setattr(desktop, "_run_connect", lambda home, link: links.append(link) or 2)
    assert desktop.main(["--connect", "studylibrary://connect?v=1"]) == 2
    assert links == ["studylibrary://connect?v=1"]
