"""The in-place update closes every other Study Library process only once the
installer is ready, reopens the app when the installer cannot start, and
reports the installed version to the page through pywebview and the speech server."""
from __future__ import annotations

import hashlib
import sys
from pathlib import Path

import pytest

import study
from study import desktop, update

INSTALLER = b"installer bytes"


def _release(version: str = "0.54.0") -> dict:
    return {"tag_name": f"v{version}", "assets": [{
        "name": update.ASSET, "size": len(INSTALLER), "digest": "sha256:" + hashlib.sha256(INSTALLER).hexdigest(),
        "browser_download_url": f"{update.DOWNLOAD_PREFIX}v{version}/{update.ASSET}",
    }]}


def _stream(_url, out, _limit) -> None:
    out.write(INSTALLER)


def _run(tmp_path: Path, events: list[str], launch=None, link: str = "studylibrary://update?version=0.54.0") -> int:
    def launched(path: Path) -> None:
        events.append("launch")
        if launch:
            launch(path)

    return update.run(link, lambda *_a, **_k: None, fetch_json=lambda _url: _release(), stream=_stream,
                      launch=launched, folder=tmp_path, close=lambda: events.append("close"),
                      reopen=lambda: events.append("reopen"))


def test_the_app_closes_after_the_download_and_before_the_installer_starts(tmp_path):
    events: list[str] = []
    assert _run(tmp_path, events) == 0
    assert events == ["close", "launch"]


def test_a_refused_installer_reopens_the_app(tmp_path):
    events: list[str] = []

    def refuse(_path: Path) -> None:
        raise OSError(1223, "The operation was cancelled by the user")

    assert _run(tmp_path, events, launch=refuse) == 2
    assert events == ["close", "launch", "reopen"]


def test_a_refused_link_leaves_the_app_open(tmp_path):
    events: list[str] = []
    assert _run(tmp_path, events, link="studylibrary://update?version=0.53.0") == 2
    assert events == []


def test_route_passes_the_hooks_to_the_update(monkeypatch):
    seen: dict = {}
    monkeypatch.setattr(update, "run", lambda link, notify, **hooks: seen.update(hooks, link=link) or 0)
    close, reopen = (lambda: None), (lambda: None)
    assert update.route(["--update", "studylibrary://update?version=1.0.0"], print, close, reopen) == 0
    assert seen["close"] is close and seen["reopen"] is reopen
    assert update.route(["--update", "studylibrary://update?version=1.0.0"], print) == 0
    assert callable(seen["close"]) and callable(seen["reopen"])


def test_installed_version_comes_from_the_package(monkeypatch):
    monkeypatch.setattr(study, "__version__", "v0.53.8", raising=False)
    assert update.installed_version() == "0.53.8"


def test_installed_version_is_none_when_nothing_says(monkeypatch):
    monkeypatch.delattr(study, "__version__", raising=False)
    monkeypatch.delattr(sys, "frozen", raising=False)
    assert update.installed_version() is None


def test_the_window_and_the_children_learn_the_installed_version(monkeypatch, tmp_path):
    monkeypatch.setattr(update, "installed_version", lambda: "0.53.8")
    assert desktop.WindowApi().app_version() == "0.53.8"
    assert desktop.prepare_environment(tmp_path, {"STUDY_APP_VERSION": "0.1.0"})["STUDY_APP_VERSION"] == "0.53.8"
    monkeypatch.setattr(update, "installed_version", lambda: None)
    assert "STUDY_APP_VERSION" not in desktop.prepare_environment(tmp_path, {"STUDY_APP_VERSION": "0.1.0"})


def test_parse_tasklist_skips_this_process_and_the_no_tasks_line():
    text = ('"StudyLibrary.exe","4120","Console","1","98,304 K"\n'
            '"StudyLibrary.exe","77","Console","1","12,004 K"\n'
            '"StudyLibrary.exe","5000","Console","1","40,000 K"\n')
    assert desktop.parse_tasklist(text, own=77) == [4120, 5000]
    assert desktop.parse_tasklist("INFO: No tasks are running which match the specified criteria.\n", own=1) == []


class _Lock:
    def __init__(self) -> None:
        self.closed = False

    def close(self) -> None:
        self.closed = True


def test_close_for_update_stops_the_supervisor_first_then_ends_what_stays_open(tmp_path):
    lock, events = _Lock(), []

    def acquire(name: str, wait: float):
        assert (tmp_path / "update.stop").exists()
        events.append(("acquire", name, wait))
        return lock

    listings = iter([[10, 11], [11], [11]])
    desktop.close_for_update(tmp_path, acquire=acquire, processes=lambda: next(listings, [11]),
                             end=lambda pid, force: events.append((pid, force)), sleep=lambda _s: None,
                             window_seconds=1.0)
    assert events == [("acquire", desktop.MUTEX_NAME, desktop.UPDATE_CLOSE_SECONDS), (10, False), (11, False), (11, True)]
    assert lock.closed
    assert not (tmp_path / "update.stop").exists()


def test_close_for_update_ends_everything_when_the_supervisor_will_not_stop(tmp_path):
    ended: list[tuple[int, bool]] = []
    desktop.close_for_update(tmp_path, acquire=lambda _n, _w: None, processes=lambda: [] if ended else [42],
                             end=lambda pid, force: ended.append((pid, force)), sleep=lambda _s: None)
    assert ended == [(42, False)]
    assert not (tmp_path / "update.stop").exists()


def test_health_reports_the_installed_version(monkeypatch):
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from tts.server import create_app

    class Engine:
        def synthesise(self, text, voice):
            raise AssertionError

        def device(self):
            return "cpu"

    monkeypatch.setenv("STUDY_APP_VERSION", "0.53.8")
    assert TestClient(create_app(Engine(), token="")).get("/tts/v1/health").json()["appVersion"] == "0.53.8"
    monkeypatch.delenv("STUDY_APP_VERSION")
    assert TestClient(create_app(Engine(), token="")).get("/tts/v1/health").json()["appVersion"] is None
