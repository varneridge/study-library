# filename: backend/tests/test_api_flaws.py
"""Falsifiable reproductions of api.py behaviours that a local sync must not inherit.

Each test asserts the SAFE behaviour, so on the current api.py they fail, and
they pass once the recommended fixes are made. Run: pytest backend/tests/test_api_flaws.py
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest import mock

import pytest
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from study.api import Api, ApiError  # noqa: E402


def _response(status: int, *, body: bytes = b"", headers: dict | None = None,
              chunks: list | None = None) -> requests.Response:
    response = requests.Response()
    response.status_code = status
    response._content = body
    response.headers.update(headers or {})
    response.url = "https://example.test/x"
    if chunks is not None:
        def iter_content(_size):
            for chunk in chunks:
                if isinstance(chunk, Exception):
                    raise chunk
                yield chunk
        response.iter_content = iter_content  # type: ignore[assignment]
    return response


def test_interrupted_download_leaves_no_file_at_final_path(tmp_path):
    """api.py:108-112 streams straight into the destination, so a dropped
    connection leaves a truncated file where a later run will treat it as done."""
    api = Api("https://example.test")
    broken = _response(200, chunks=[b"%PDF-1.7 first half", requests.exceptions.ChunkedEncodingError("reset")])
    target = tmp_path / "CV.pdf"
    with mock.patch.object(api.session, "request", return_value=broken):
        with pytest.raises(Exception):
            api.download("abc", str(target))
    assert not target.exists(), "a truncated file was left at the final path"


def test_access_redirect_on_file_lookup_raises_api_error():
    """api.py:99-106 checks 404 and >=400 but not redirects, so a Cloudflare
    Access login redirect surfaces as a JSON decode error, not ApiError."""
    api = Api("https://example.test")
    redirect = _response(302, headers={"Location": "https://team.cloudflareaccess.com/login"})
    with mock.patch.object(api.session, "get", return_value=redirect):
        with pytest.raises(ApiError):
            api.file("some-file-id")


def test_pull_all_stops_when_cursor_does_not_advance():
    """api.py:62-73 loops while `more` is true and never checks that the cursor
    moved, so a server bug or proxy cache that repeats a page spins forever."""
    api = Api("https://example.test")
    page = {"rows": {"applications": []}, "cursor": 5, "more": True}
    calls = {"n": 0}

    def fake_json(*_args, **_kwargs):
        calls["n"] += 1
        if calls["n"] > 50:
            raise RuntimeError("pull_all did not stop on a stuck cursor")
        return page

    with mock.patch.object(api, "_json", side_effect=fake_json):
        with pytest.raises(ApiError):
            api.pull_all()
