"""Client for the Study Library Worker API.

Used by the processor and the Zotero importer. Requests pass Cloudflare Access
with a service token, and processor endpoints also need the processor key.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import requests

PUSH_BATCH = 200


class ApiError(Exception):
    pass


def stamp(after: str | None = None) -> str:
    """An ISO timestamp for now, or just after an existing one if that is later."""
    now = datetime.now(timezone.utc)
    if after:
        previous = datetime.fromisoformat(after.replace("Z", "+00:00")) + timedelta(milliseconds=2)
        now = max(now, previous)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


class Api:
    def __init__(
        self,
        base_url: str,
        processor_key: str | None = None,
        access_client_id: str | None = None,
        access_client_secret: str | None = None,
        timeout: float = 300,
    ):
        self.base = base_url.rstrip("/")
        self.timeout = timeout
        self.session = requests.Session()
        if processor_key:
            self.session.headers["X-Processor-Key"] = processor_key
        if access_client_id and access_client_secret:
            self.session.headers["CF-Access-Client-Id"] = access_client_id
            self.session.headers["CF-Access-Client-Secret"] = access_client_secret

    def _request(self, method: str, path: str, **kwargs) -> requests.Response:
        response = self.session.request(method, self.base + path, timeout=self.timeout,
                                        allow_redirects=False, **kwargs)
        if response.is_redirect:
            raise ApiError(f"{method} {path} was redirected. Check the Access service token.")
        if response.status_code >= 400:
            raise ApiError(f"{method} {path} returned {response.status_code}: {response.text[:500]}")
        return response

    def _json(self, method: str, path: str, **kwargs):
        return self._request(method, path, **kwargs).json()

    # Sync, used by the importer

    def pull_all(self) -> dict[str, dict[str, dict]]:
        tables: dict[str, dict[str, dict]] = {}
        since = 0
        while True:
            result = self._json("GET", "/api/sync/pull", params={"since": since})
            for table, rows in result["rows"].items():
                bucket = tables.setdefault(table, {})
                for row in rows:
                    bucket[row["id"]] = row
            since = result["cursor"]
            if not result["more"]:
                return tables

    def push(self, changes: list[dict]) -> list[dict]:
        failures = []
        for start in range(0, len(changes), PUSH_BATCH):
            batch = changes[start:start + PUSH_BATCH]
            failures.extend(self._json("POST", "/api/sync/push", json={"changes": batch})["failures"])
        return failures

    def upload(self, path: str, sha256: str, mime: str) -> str:
        with open(path, "rb") as handle:
            result = self._json("PUT", f"/api/files/{sha256}", data=handle,
                                headers={"Content-Type": mime})
        return result["key"]

    # Processor

    def claim(self) -> dict | None:
        return self._json("POST", "/api/processor/claim")["job"]

    def complete(self, job_id: int) -> None:
        self._json("POST", f"/api/processor/jobs/{job_id}/complete")

    def fail(self, job_id: int, error: str) -> bool:
        return self._json("POST", f"/api/processor/jobs/{job_id}/fail", json={"error": error})["final"]

    def file(self, file_id: str) -> dict | None:
        response = self.session.get(f"{self.base}/api/processor/files/{file_id}", timeout=self.timeout,
                                    allow_redirects=False)
        if response.status_code == 404:
            return None
        if response.status_code >= 400:
            raise ApiError(f"GET file {file_id} returned {response.status_code}")
        return response.json()["file"]

    def download(self, key: str, path: str) -> None:
        response = self._request("GET", f"/api/processor/objects/{key}", stream=True)
        with open(path, "wb") as handle:
            for chunk in response.iter_content(1024 * 1024):
                handle.write(chunk)

    def put_object(self, path: str, key: str, content_type: str) -> None:
        with open(path, "rb") as handle:
            self._json("PUT", f"/api/processor/objects/{key}", data=handle,
                       headers={"Content-Type": content_type})

    def delete_unreferenced(self, key: str) -> None:
        self._json("DELETE", f"/api/processor/objects/{key}", params={"if_unreferenced": "1"})

    def delete_object(self, key: str) -> None:
        self._json("DELETE", f"/api/processor/objects/{key}")

    def read_text(self, key: str) -> str | None:
        """A small stored text, or None if there is nothing at that key."""
        response = self.session.get(f"{self.base}/api/processor/objects/{key}", timeout=self.timeout,
                                    allow_redirects=False)
        if response.status_code == 404:
            return None
        if response.status_code >= 400 or response.is_redirect:
            raise ApiError(f"GET {key} returned {response.status_code}")
        return response.content.decode("utf-8")

    def put_text(self, key: str, text: str) -> None:
        self._json("PUT", f"/api/processor/objects/{key}", data=text.encode("utf-8"),
                   headers={"Content-Type": "text/plain; charset=utf-8"})

    def heartbeat(self, job_id: int) -> bool:
        """Tells the Worker a long job is still running. Uses its own
        connection, because it is called from a second thread."""
        response = requests.post(f"{self.base}/api/processor/jobs/{job_id}/heartbeat",
                                 headers=dict(self.session.headers), timeout=30, allow_redirects=False)
        return response.ok and bool(response.json().get("running"))

    def file_text(self, file_id: str, page_count: int, pages: list[dict]) -> None:
        self._json("POST", f"/api/processor/files/{file_id}/text",
                   json={"page_count": page_count, "pages": pages})

    def identified(self, file_id: str, citation: dict, via: str | None) -> None:
        self._json("POST", f"/api/processor/files/{file_id}/identified", json={"citation": citation, "via": via})

    def needs_ocr(self, file_id: str, page_count: int, priority: int | None, redo: bool = False,
                  mode: str | None = None) -> None:
        """mode: "redo" reads the text again, pages untouched; "fresh" rebuilds
        the file from its page images; none reads only pages with no text."""
        self._json("POST", f"/api/processor/files/{file_id}/needs-ocr",
                   json={"page_count": page_count, "priority": priority, "redo": redo, "mode": mode})

    def rescan(self) -> int:
        """Queues every PDF reading to be checked against the current OCR."""
        return self._json("POST", "/api/processor/rescan")["queued"]

    def replaced(self, file_id: str, r2_key: str, size: int, priority: int | None) -> None:
        self._json("POST", f"/api/processor/files/{file_id}/replaced",
                   json={"r2_key": r2_key, "bytes": size, "priority": priority})

    def converted(self, file_id: str, sha256: str, r2_key: str, size: int, name: str) -> str:
        return self._json("POST", f"/api/processor/files/{file_id}/converted",
                          json={"sha256": sha256, "r2_key": r2_key, "bytes": size,
                                "original_name": name})["file_id"]

    def file_failed(self, file_id: str) -> None:
        self._json("POST", f"/api/processor/files/{file_id}/failed")

    # Recordings

    def recording(self, recording_id: str) -> dict:
        return self._json("GET", f"/api/processor/recordings/{recording_id}")

    def recording_status(self, recording_id: str, status: str) -> None:
        self._json("POST", f"/api/processor/recordings/{recording_id}/status", json={"status": status})

    def recording_audio(self, recording_id: str, r2_key: str, size: int, duration: float, mime: str,
                        delete_source: bool, sha256: str = "", chunks: list[str] | None = None) -> None:
        self._json("POST", f"/api/processor/recordings/{recording_id}/audio", json={
            "r2_key": r2_key, "bytes": size, "duration": duration, "mime": mime,
            "delete_source": delete_source, "sha256": sha256, "chunks": chunks})

    def save_transcript(self, recording_id: str, text: str) -> None:
        self._json("POST", f"/api/processor/recordings/{recording_id}/transcript", json={"text": text})



def api_from_env() -> Api:
    return Api(
        base_url=os.environ["STUDY_URL"],
        processor_key=os.environ.get("PROCESSOR_KEY"),
        access_client_id=os.environ.get("CF_ACCESS_CLIENT_ID"),
        access_client_secret=os.environ.get("CF_ACCESS_CLIENT_SECRET"),
    )
