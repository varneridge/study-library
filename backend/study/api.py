"""Client for the Study Library Worker API.

Used by the processor, the Zotero importer and the local sync commands in
sync/. Requests pass Cloudflare Access with a service token, and processor
endpoints also need the processor key.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterator
from datetime import datetime, timedelta, timezone

from urllib.parse import quote

import requests

PUSH_BATCH = 200


class ApiError(Exception):
    """A request the Worker refused or redirected. status is the HTTP code,
    or None for a redirect, so callers can tell a retryable 503 from a 403."""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class LeaseLost(ApiError):
    """The Worker has given this job to another machine, so nothing more may be
    saved for it. Raised for a 409 whose body names lease_lost; other 409s, such
    as a recording that is still live, stay a plain ApiError."""


def _is_lease_lost(text: str) -> bool:
    try:
        return json.loads(text).get("error") == "lease_lost"
    except (ValueError, AttributeError):
        return False


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
        # The lease of the job this processor is working on. Every request
        # carries it, so the Worker can refuse writes from a machine whose job
        # has since been handed to another.
        self.current_lease_id: str | None = None
        if processor_key:
            self.session.headers["X-Processor-Key"] = processor_key
        if access_client_id and access_client_secret:
            self.session.headers["CF-Access-Client-Id"] = access_client_id
            self.session.headers["CF-Access-Client-Secret"] = access_client_secret

    def _lease_header(self) -> dict[str, str]:
        return {"X-Lease-Id": self.current_lease_id} if self.current_lease_id else {}

    def _request(self, method: str, path: str, **kwargs) -> requests.Response:
        headers = {**self._lease_header(), **(kwargs.pop("headers", None) or {})}
        response = self.session.request(method, self.base + path, timeout=self.timeout,
                                        allow_redirects=False, headers=headers, **kwargs)
        if response.is_redirect:
            raise ApiError(f"{method} {path} was redirected. Check the Access service token.")
        if response.status_code >= 400:
            status = response.status_code
            text = response.text[:500]
            response.close()
            if status == 409 and _is_lease_lost(text):
                raise LeaseLost(f"{method} {path}: this job now belongs to another machine", status)
            raise ApiError(f"{method} {path} returned {status}: {text}", status)
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
            # A page that claims more but does not move the cursor would repeat
            # for ever, so it is treated as a fault rather than retried.
            if result["more"] and result["cursor"] == since:
                raise ApiError(f"sync pull did not advance past cursor {since}")
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

    def object_chunks(self, key: str, chunk_size: int = 1024 * 1024) -> Iterator[bytes]:
        """The bytes of a stored object, through the same route the reader
        uses, so no processor key is needed. The key is quoted, and the
        connection is closed even if the caller stops reading part way."""
        with self._request("GET", f"/api/objects/{quote(key, safe='/')}", stream=True) as response:
            yield from response.iter_content(chunk_size)

    # Processor

    def claim(self) -> dict | None:
        """The next job, whose lease every later request carries until end_lease."""
        self.end_lease()
        job = self._json("POST", "/api/processor/claim")["job"]
        if job:
            self.current_lease_id = job.get("lease_id")
        return job

    def end_lease(self) -> None:
        self.current_lease_id = None

    def complete(self, job_id: int) -> None:
        self._json("POST", f"/api/processor/jobs/{job_id}/complete")

    def fail(self, job_id: int, error: str) -> bool:
        return self._json("POST", f"/api/processor/jobs/{job_id}/fail", json={"error": error})["final"]

    def file(self, file_id: str) -> dict | None:
        try:
            return self._json("GET", f"/api/processor/files/{file_id}")["file"]
        except ApiError as error:
            if error.status == 404:
                return None
            raise

    def download(self, key: str, path: str) -> None:
        """Writes to a .part file beside the target and renames it into place
        only once every byte has arrived, so an interrupted download never
        leaves a truncated file that a later run would take as complete."""
        partial = path + ".part"
        response = self._request("GET", f"/api/processor/objects/{key}", stream=True)
        try:
            with open(partial, "wb") as handle:
                for chunk in response.iter_content(1024 * 1024):
                    handle.write(chunk)
            os.replace(partial, path)
        except BaseException:
            if os.path.exists(partial):
                os.remove(partial)
            raise
        finally:
            response.close()

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
        try:
            return self._request("GET", f"/api/processor/objects/{key}").content.decode("utf-8")
        except ApiError as error:
            if error.status == 404:
                return None
            raise

    def put_text(self, key: str, text: str) -> None:
        self._json("PUT", f"/api/processor/objects/{key}", data=text.encode("utf-8"),
                   headers={"Content-Type": "text/plain; charset=utf-8"})

    def heartbeat(self, job_id: int) -> bool:
        """Tells the Worker a long job is still running. Uses its own
        connection, because it is called from a second thread. False when the
        job is no longer this machine's."""
        response = requests.post(f"{self.base}/api/processor/jobs/{job_id}/heartbeat",
                                 headers={**self.session.headers, **self._lease_header()},
                                 timeout=30, allow_redirects=False)
        return response.ok and bool(response.json().get("running"))

    def file_text(self, file_id: str, page_count: int, pages: list[dict],
                  thumb_key: str | None = None) -> None:
        payload: dict = {"page_count": page_count, "pages": pages}
        if thumb_key is not None:
            payload["thumb_key"] = thumb_key
        self._json("POST", f"/api/processor/files/{file_id}/text", json=payload)

    def file_thumb(self, file_id: str, thumb_key: str) -> None:
        self._json("POST", f"/api/processor/files/{file_id}/thumb", json={"thumb_key": thumb_key})

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



    # Prepared Listen audio, used by tts/prepare.py

    def listen_claim(self, limit: int = 8) -> list[dict]:
        return self._json("POST", "/api/processor/listen/claim", json={"limit": limit})["items"]

    def listen_put(self, key: str, data: bytes, seconds: float) -> None:
        self._request("PUT", f"/api/processor/listen/audio/{key}", data=data,
                      headers={"Content-Type": "application/x-kokoro-prepared", "X-Listen-Seconds": f"{seconds:.3f}"}).close()

    def listen_fail(self, key: str, error: str) -> bool:
        return self._json("POST", f"/api/processor/listen/audio/{key}/fail", json={"error": error})["final"]


def api_from_env() -> Api:
    return Api(
        base_url=os.environ["STUDY_URL"],
        processor_key=os.environ.get("PROCESSOR_KEY"),
        access_client_id=os.environ.get("CF_ACCESS_CLIENT_ID"),
        access_client_secret=os.environ.get("CF_ACCESS_CLIENT_SECRET"),
    )
