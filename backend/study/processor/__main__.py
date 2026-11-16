"""Run the processor: python -m study.processor

Pass --once to work through the queue and exit, which suits a scheduled task.
On Windows, where a process started without a console cannot be sent a
signal, it stops after the current job once the file named by
PROCESSOR_STOP_FILE appears.
"""

from __future__ import annotations

import argparse
import logging
import os
import signal
import threading
import time

import requests
import ctypes

from ..api import Api, ApiError, LeaseLost, api_from_env
from .jobs import FILE_JOBS, HANDLERS, RECORDING_JOBS, Context
from .speech import transcriber_from_env

log = logging.getLogger("study.processor")
IDLE_SECONDS = float(os.environ.get("PROCESSOR_IDLE_SECONDS", "10"))
# A running job tells the Worker it is alive this often. The Worker puts a
# job back in the queue after an hour without word.
HEARTBEAT_SECONDS = float(os.environ.get("PROCESSOR_HEARTBEAT_SECONDS", "300"))


def set_background_priority() -> None:
    """Sets the process priority to below-normal on Windows, so background OCR
    and audio tasks automatically yield CPU to interactive apps."""
    if os.name == "nt":
        try:
            # BELOW_NORMAL_PRIORITY_CLASS = 0x00004000
            ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x00004000)
        except Exception:
            pass


class _PowerStatus(ctypes.Structure):
    _fields_ = [
        ("ACLineStatus", ctypes.c_byte),
        ("BatteryFlag", ctypes.c_byte),
        ("BatteryLifePercent", ctypes.c_byte),
        ("Reserved1", ctypes.c_byte),
        ("BatteryLifeTime", ctypes.c_ulong),
        ("BatteryFullLifeTime", ctypes.c_ulong),
    ]


class _MemoryStatus(ctypes.Structure):
    _fields_ = [
        ("dwLength", ctypes.c_ulong),
        ("dwMemoryLoad", ctypes.c_ulong),
        ("ullTotalPhys", ctypes.c_ulonglong),
        ("ullAvailPhys", ctypes.c_ulonglong),
        ("ullTotalPageFile", ctypes.c_ulonglong),
        ("ullAvailPageFile", ctypes.c_ulonglong),
        ("ullTotalVirtual", ctypes.c_ulonglong),
        ("ullAvailVirtual", ctypes.c_ulonglong),
        ("sullAvailExtendedVirtual", ctypes.c_ulonglong),
    ]


def adaptive_ocr_jobs() -> int:
    """Scales OCR worker threads to machine specs and power state.
    On a big desktop (e.g. 8-16 cores on AC), uses up to 6 jobs.
    On an older laptop (<=4 cores, low RAM, or battery), uses 1-2 jobs."""
    if "OCR_JOBS" in os.environ:
        try:
            return max(1, int(os.environ["OCR_JOBS"]))
        except ValueError:
            pass

    cores = os.cpu_count() or 2
    on_battery = False
    ram_gb = 8.0

    if os.name == "nt":
        try:
            ps = _PowerStatus()
            if ctypes.windll.kernel32.GetSystemPowerStatus(ctypes.byref(ps)):
                on_battery = ps.ACLineStatus == 0
        except Exception:
            pass

        try:
            ms = _MemoryStatus()
            ms.dwLength = ctypes.sizeof(_MemoryStatus)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(ms)):
                ram_gb = ms.ullTotalPhys / (1024 ** 3)
        except Exception:
            pass

    if on_battery or ram_gb < 4.5 or cores <= 2:
        return 1
    if cores <= 4 or ram_gb < 8.0:
        return 2
    if cores <= 8:
        return 3
    # Powerful workstation / high-core PC: scale up while leaving 2+ cores free
    return min(6, max(2, cores - 2))


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
        set_background_priority()
        self.ctx = Context(
            api=api,
            keep_original_scans=os.environ.get("KEEP_ORIGINAL_SCANS", "false").lower() == "true",
            keep_original_video=os.environ.get("KEEP_ORIGINAL_VIDEO", "false").lower() == "true",
            ocr_jobs=adaptive_ocr_jobs(),
            transcriber=transcriber,
            make_transcriber=transcriber_from_env,
            online=os.environ.get("IDENTIFY_OFFLINE", "false").lower() != "true",
        )
        self.stopping = False
        self.stop_file = os.environ.get("PROCESSOR_STOP_FILE") or None
        # Set by stop(), so an idle wait ends at once instead of sleeping on.
        self._wake = threading.Event()

    def stop(self, *_args) -> None:
        log.info("stopping after the current job")
        self.stopping = True
        self._wake.set()

    def _asked_to_stop(self) -> bool:
        if self.stop_file and os.path.exists(self.stop_file):
            try:
                os.remove(self.stop_file)
            except OSError:
                pass
            self.stop()
        return self.stopping

    def run_once(self) -> bool:
        """Run one job if one is waiting. Returns True if a job ran."""
        job = self.ctx.api.claim()
        if job is None:
            return False
        try:
            self._run_job(job)
        except LeaseLost:
            # Another machine took the job over while this one slept or lost
            # its connection. Its results are refused, so nothing is reported.
            log.warning("job %s (%s) now belongs to another machine; nothing more is saved for it",
                        job["id"], job["type"])
        finally:
            self.ctx.api.end_lease()
        return True

    def _run_job(self, job: dict) -> None:
        handler = HANDLERS.get(job["type"])
        started = time.monotonic()
        try:
            if handler is None:
                raise RuntimeError(f"no handler for job type {job['type']}")
            with Heartbeat(self.ctx.api, job["id"]):
                handler(self.ctx, job)
        except LeaseLost:
            raise
        except Exception as error:  # noqa: BLE001
            log.exception("job %s (%s) failed", job["id"], job["type"])
            final = self.ctx.api.fail(job["id"], f"{type(error).__name__}: {error}")
            # The job has stopped running, so its lease no longer admits writes:
            # marking the file or recording failed goes without it.
            self.ctx.api.end_lease()
            if final and job["type"] in FILE_JOBS and job["payload"].get("file_id"):
                self.ctx.api.file_failed(job["payload"]["file_id"])
            if final and job["type"] in RECORDING_JOBS and job["payload"].get("recording_id"):
                self.ctx.api.recording_status(job["payload"]["recording_id"], "failed")
        else:
            self.ctx.api.complete(job["id"])
            log.info("job %s (%s) done in %.1fs", job["id"], job["type"], time.monotonic() - started)

    def drain(self) -> int:
        count = 0
        while not self._asked_to_stop() and self.run_once():
            count += 1
        return count

    def run(self) -> None:
        # Signals can only be set from the main thread, and SIGBREAK is the one
        # Windows delivers for Ctrl+Break to a console process.
        if threading.current_thread() is threading.main_thread():
            for name in ("SIGTERM", "SIGINT", "SIGBREAK"):
                if hasattr(signal, name):
                    signal.signal(getattr(signal, name), self.stop)
        log.info("processor started")
        while not self._asked_to_stop():
            try:
                if not self.run_once():
                    self._wake.wait(IDLE_SECONDS)
            except (ApiError, requests.RequestException):
                log.exception("cannot reach the Worker, retrying in 30 seconds")
                self._wake.wait(30)
        log.info("processor stopped")


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
