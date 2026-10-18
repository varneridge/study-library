"""Run the processor: python -m study.processor

Pass --once to work through the queue and exit, which suits a scheduled task.
"""

from __future__ import annotations

import argparse
import logging
import os
import signal
import threading
import time

import requests

from ..api import Api, ApiError, api_from_env
from .jobs import FILE_JOBS, HANDLERS, RECORDING_JOBS, Context
from .speech import transcriber_from_env

log = logging.getLogger("study.processor")
IDLE_SECONDS = float(os.environ.get("PROCESSOR_IDLE_SECONDS", "10"))
# A running job tells the Worker it is alive this often. The Worker puts a
# job back in the queue after an hour without word.
HEARTBEAT_SECONDS = float(os.environ.get("PROCESSOR_HEARTBEAT_SECONDS", "300"))


class Heartbeat:
    """Reports a job as alive from a second thread until it finishes."""

    def __init__(self, api: Api, job_id: int):
        self.api, self.job_id = api, job_id
        self.done = threading.Event()
        self.thread = threading.Thread(target=self._beat, daemon=True)

    def _beat(self) -> None:
        while not self.done.wait(HEARTBEAT_SECONDS):
            try:
                self.api.heartbeat(self.job_id)
            except Exception:  # noqa: BLE001
                log.warning("heartbeat for job %s did not reach the Worker", self.job_id)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_exc):
        self.done.set()


class Processor:
    def __init__(self, api: Api, transcriber=None):
        self.ctx = Context(
            api=api,
            keep_original_scans=os.environ.get("KEEP_ORIGINAL_SCANS", "false").lower() == "true",
            keep_original_video=os.environ.get("KEEP_ORIGINAL_VIDEO", "false").lower() == "true",
            ocr_jobs=int(os.environ.get("OCR_JOBS", "2")),
            transcriber=transcriber,
            make_transcriber=transcriber_from_env,
            online=os.environ.get("IDENTIFY_OFFLINE", "false").lower() != "true",
        )
        self.stopping = False

    def stop(self, *_args) -> None:
        log.info("stopping after the current job")
        self.stopping = True

    def run_once(self) -> bool:
        """Run one job if one is waiting. Returns True if a job ran."""
        job = self.ctx.api.claim()
        if job is None:
            return False
        handler = HANDLERS.get(job["type"])
        started = time.monotonic()
        try:
            if handler is None:
                raise RuntimeError(f"no handler for job type {job['type']}")
            with Heartbeat(self.ctx.api, job["id"]):
                handler(self.ctx, job)
        except Exception as error:  # noqa: BLE001
            log.exception("job %s (%s) failed", job["id"], job["type"])
            final = self.ctx.api.fail(job["id"], f"{type(error).__name__}: {error}")
            if final and job["type"] in FILE_JOBS and job["payload"].get("file_id"):
                self.ctx.api.file_failed(job["payload"]["file_id"])
            if final and job["type"] in RECORDING_JOBS and job["payload"].get("recording_id"):
                self.ctx.api.recording_status(job["payload"]["recording_id"], "failed")
        else:
            self.ctx.api.complete(job["id"])
            log.info("job %s (%s) done in %.1fs", job["id"], job["type"], time.monotonic() - started)
        return True

    def drain(self) -> int:
        count = 0
        while not self.stopping and self.run_once():
            count += 1
        return count

    def run(self) -> None:
        signal.signal(signal.SIGTERM, self.stop)
        signal.signal(signal.SIGINT, self.stop)
        log.info("processor started")
        while not self.stopping:
            try:
                if not self.run_once():
                    time.sleep(IDLE_SECONDS)
            except (ApiError, requests.RequestException):
                log.exception("cannot reach the Worker, retrying in 30 seconds")
                time.sleep(30)


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m study.processor")
    parser.add_argument("--once", action="store_true", help="Work through the queue, then exit")
    parser.add_argument("--rescan", action="store_true",
                        help="Queue every PDF reading to be read again with the current OCR, then exit")
    args = parser.parse_args()
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    processor = Processor(api_from_env())
    if args.rescan:
        queued = processor.ctx.api.rescan()
        print(f"{queued} readings queued to be read again. The processor works through them behind any new work.")
        return
    if args.once:
        log.info("processed %s jobs", processor.drain())
    else:
        processor.run()


if __name__ == "__main__":
    main()
