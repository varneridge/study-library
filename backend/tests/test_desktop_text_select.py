"""The frameless window must leave the page's text selectable, because
pywebview otherwise injects body { user-select: none } and the reader can
neither select nor highlight anything. The window also keeps WebView2's own
menu for editable targets only, so a misspelt word can be corrected there."""

from __future__ import annotations

import sys
import types

from study import desktop


class _Event:
    def __init__(self) -> None:
        self.handlers: list = []

    def __iadd__(self, handler):  # noqa: ANN001 - pywebview's event idiom
        self.handlers.append(handler)
        return self


class _Events:
    def __init__(self) -> None:
        self.shown, self.loaded, self.maximized, self.restored = _Event(), _Event(), _Event(), _Event()


def test_frameless_window_allows_text_selection(monkeypatch, tmp_path):
    made: dict = {}

    def create_window(*args, **kwargs):
        made.update(kwargs)
        return types.SimpleNamespace(events=_Events())

    fake = types.ModuleType("webview")
    fake.create_window = create_window
    fake.start = lambda **kwargs: None
    monkeypatch.setitem(sys.modules, "webview", fake)
    monkeypatch.setattr(desktop, "WINDOWS", True)

    desktop.open_frameless(tmp_path, "https://study.example/?sl=frameless")

    assert made.get("text_select") is True


def _fake_window():
    core = types.SimpleNamespace(Settings=types.SimpleNamespace(AreDefaultContextMenusEnabled=False), ContextMenuRequested=_Event())
    form = types.SimpleNamespace(browser=types.SimpleNamespace(webview=types.SimpleNamespace(CoreWebView2=core)), Invoke=lambda call: call())
    return types.SimpleNamespace(native=form), core


def _fake_system(monkeypatch):
    class Func:
        def __getitem__(self, _kind):
            return lambda call: call

    monkeypatch.setitem(sys.modules, "System", types.SimpleNamespace(Func=Func(), Type=object))


def _right_click(core, editable):
    args = types.SimpleNamespace(ContextMenuTarget=types.SimpleNamespace(IsEditable=editable), Handled=False)
    for handler in core.ContextMenuRequested.handlers:
        handler(None, args)
    return args.Handled


def test_native_menu_is_kept_for_editable_targets_only(monkeypatch):
    _fake_system(monkeypatch)
    window, core = _fake_window()

    assert desktop.allow_spelling_menu(window) is True

    assert core.Settings.AreDefaultContextMenusEnabled is True
    # Inputs, textareas and contenteditable editors such as the notes keep the menu with its spelling suggestions.
    assert _right_click(core, editable=True) is False
    # Everything else has no menu, as before.
    assert _right_click(core, editable=False) is True


def test_native_menu_failure_leaves_window_as_it_was(monkeypatch):
    _fake_system(monkeypatch)
    window, _core = _fake_window()
    window.native.browser.webview = None

    assert desktop.allow_spelling_menu(window) is False


def test_frameless_window_turns_the_spelling_menu_on_once_a_page_has_loaded(monkeypatch, tmp_path):
    made: dict = {}
    calls: list = []

    def create_window(*args, **kwargs):
        made["window"] = types.SimpleNamespace(events=_Events())
        return made["window"]

    class Handoff:
        def __init__(self, *args, **kwargs) -> None:
            pass

        def on_loaded(self) -> None:
            pass

    fake = types.ModuleType("webview")
    fake.create_window = create_window
    fake.start = lambda **kwargs: None
    monkeypatch.setitem(sys.modules, "webview", fake)
    monkeypatch.setattr(desktop, "WINDOWS", True)
    monkeypatch.setattr(desktop, "SignInHandoff", Handoff)
    monkeypatch.setattr(desktop, "allow_spelling_menu", lambda window: calls.append(window) or True)

    desktop.open_frameless(tmp_path, "https://study.example/?sl=frameless")

    for handler in made["window"].events.loaded.handlers * 2:
        handler()
    assert calls == [made["window"]]
