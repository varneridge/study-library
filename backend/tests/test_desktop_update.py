# filename: backend/tests/test_desktop_update.py
"""Acceptance tests for the in-app updater (studylibrary://update).

Run from the repository root:  python -m pytest backend/tests/test_desktop_update.py -q
They run on any OS and need no network, because GitHub, the download and the
installer launch are all injected.
"""
from __future__ import annotations

import hashlib
import io
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from study import desktop, update  # noqa: E402

BODY = b"MZ pretend installer"
URL = "https://github.com/varneridge/study-library/releases/download/v1.4.0/StudyLibrarySetup.exe"
LINK = "studylibrary://update?version=1.4.0"


def release(tag="v1.4.0", **asset):
    found = {"name": "StudyLibrarySetup.exe", "size": len(BODY), "browser_download_url": URL,
             "digest": "sha256:" + hashlib.sha256(BODY).hexdigest(), **asset}
    return {"tag_name": tag, "assets": [{"name": "Source.zip"}, found]}


class Fake:
    """Stands in for GitHub, the download and the launch, and records each so a test can say what happened."""

    def __init__(self, answer=None, body=BODY, raises: BaseException | None = None):
        self.answer = release() if answer is None else answer
        self.body, self.raises = body, raises
        self.asked, self.fetched, self.launched, self.said = [], [], [], []

    def fetch_json(self, url):
        self.asked.append(url)
        if self.raises:
            raise self.raises
        return self.answer

    def stream(self, url, out, limit):
        self.fetched.append(url)
        out.write(self.body[: limit + 1])

    def notify(self, text, error=False):
        self.said.append((text, error))

    def run(self, link, folder):
        return update.run(link, self.notify, fetch_json=self.fetch_json, stream=self.stream,
                          launch=self.launched.append, folder=folder)


# 1. The link only names a version.

@pytest.mark.parametrize("variant", [
    LINK, "StudyLibrary://update?version=1.4.0", "studylibrary:update?version=1.4.0",
    "studylibrary://update/?version=v1.4.0", "  " + LINK + "\n",
])
def test_harmless_spellings_of_the_update_link_are_accepted(variant):
    assert update.parse_update_link(variant) == "1.4.0"


@pytest.mark.parametrize("bad", [
    "https://update?version=1.4.0", "studylibrary://connect?version=1.4.0", "studylibrary://update",
    "studylibrary://update?version=", "studylibrary://update?version=latest", "studylibrary://update?version=1.4",
    "studylibrary://update?version=1.4.0-beta", "studylibrary://update?version=../../x",
    LINK + "&version=1.5.0", LINK + "&url=https://evil.example/x.exe",
])
def test_anything_else_refuses_the_link(bad):
    with pytest.raises(update.UpdateError):
        update.parse_update_link(bad)


def test_update_links_are_told_apart_from_connect_links():
    assert update.is_update_link(LINK)
    assert not update.is_update_link("studylibrary://connect?v=1&PROCESSOR_KEY=x")


# 2. Downloading and starting the installer.

def test_the_latest_installer_is_downloaded_checked_and_started(tmp_path):
    fake = Fake()
    assert fake.run(LINK, tmp_path) == 0
    installer = tmp_path / "StudyLibrarySetup-1.4.0.exe"
    assert fake.asked == [update.LATEST_API] and fake.fetched == [URL]
    assert fake.launched == [installer] and installer.read_bytes() == BODY
    assert fake.said and fake.said[0][1] is False and "1.4.0" in fake.said[0][0]
    assert not list(tmp_path.glob("*.part"))


def test_a_link_for_any_other_release_downloads_nothing(tmp_path):
    fake = Fake()
    assert fake.run("studylibrary://update?version=1.3.0", tmp_path) == 2
    assert fake.fetched == [] and fake.launched == [] and fake.said[-1][1] is True


@pytest.mark.parametrize("fake", [
    Fake(raises=urllib.error.URLError("offline")),
    Fake(raises=urllib.error.HTTPError("u", 403, "rate limited", {}, io.BytesIO())),
    Fake(raises=json.JSONDecodeError("x", "<html>", 0)),
    Fake(answer=["v1.4.0"]),
    Fake(answer={"tag_name": "v1.4.0", "assets": [{"name": "Source.zip"}]}),
    Fake(answer=release(browser_download_url="https://evil.example/StudyLibrarySetup.exe")),
    Fake(answer=release(size=0)),
    Fake(answer=release(size="20")),
    Fake(answer=release(tag="nightly")),
])
def test_an_unusable_answer_from_github_downloads_nothing(fake, tmp_path):
    assert fake.run(LINK, tmp_path) == 2
    assert fake.fetched == [] and fake.launched == [] and fake.said[-1][1] is True


@pytest.mark.parametrize("body", [b"X" * len(BODY), BODY[:-1], BODY + b"!"])
def test_a_download_that_does_not_match_is_deleted_and_not_started(body, tmp_path):
    fake = Fake(body=body)
    assert fake.run(LINK, tmp_path) == 2
    assert fake.launched == [] and list(tmp_path.iterdir()) == []


def test_a_digest_in_an_unknown_form_is_refused(tmp_path):
    fake = Fake(answer=release(digest="md5:" + hashlib.md5(BODY).hexdigest()))
    assert fake.run(LINK, tmp_path) == 2 and fake.launched == []


def test_an_older_asset_without_a_digest_still_needs_the_right_size(tmp_path):
    assert Fake(answer=release(digest=None)).run(LINK, tmp_path) == 0


def test_a_failed_download_leaves_no_partial_file(tmp_path):
    fake = Fake()

    def broken(url, out, limit):
        out.write(b"MZ")
        raise urllib.error.URLError("connection reset")

    fake.stream = broken
    assert fake.run(LINK, tmp_path) == 2
    assert fake.launched == [] and list(tmp_path.iterdir()) == []


def test_redirects_stay_on_github():
    handler = update._GitHubOnly()
    request = urllib.request.Request(URL)
    assert handler.redirect_request(request, None, 302, "Found", {}, "https://release-assets.githubusercontent.com/a")
    for elsewhere in ("https://evil.example/a.exe", "http://release-assets.githubusercontent.com/a"):
        with pytest.raises(update.UpdateError):
            handler.redirect_request(request, None, 302, "Found", {}, elsewhere)


# 3. Routing from desktop.main, as the protocol handler runs it.

@pytest.mark.parametrize("argv", [[], ["--app-only"], ["--connect", "studylibrary://connect?v=1&PROCESSOR_KEY=x"]])
def test_route_leaves_everything_else_alone(argv):
    assert update.route(argv, lambda *a, **k: None) is None


@pytest.mark.parametrize("flag", ["--connect", "--update"])
def test_desktop_main_sends_update_links_to_the_updater(flag, tmp_path, monkeypatch):
    monkeypatch.setenv("STUDY_HOME", str(tmp_path))
    ran = []
    monkeypatch.setattr(update, "run", lambda link, notify: ran.append(link) or 0)
    assert desktop.main([flag, LINK]) == 0
    assert ran == [LINK]
