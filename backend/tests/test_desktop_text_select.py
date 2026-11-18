"""The frameless window must leave the page's text selectable, because
pywebview otherwise injects body { user-select: none } and the reader can
neither select nor highlight anything."""

from __future__ import annotations

import sys
import types

from study import desktop


class _Event:
    def __iadd__(self, handler):  # noqa: ANN001 - pywebview's event idiom
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
