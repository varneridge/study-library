"""Prepares Listen audio ahead of time, on whichever machines run it.

Readers ask the Worker for their paragraphs to be prepared (app/worker/listen.ts).
This loop claims a few at a time, has the local speech server (server.py) read
each one, which applies the pronunciation rules in pronounce.py, compresses the
audio to MP3 with ffmpeg and uploads it. Phones then play the finished file
rather than running Kokoro in the browser.

The desktop app (study/desktop.py) runs it beside the processor and the speech
server on every Windows computer where Study Library is installed. Each one
says what kind of machine it is, from the speech server's /tts/v1/health:

  gpu    an engine on a graphics card (the high-quality speech pack): claims
         new paragraphs at once and remakes audio the others made
  cpu    the full-precision model on the processor: claims a paragraph only
         after it has waited a few minutes, unless no gpu machine is about
  basic  the compressed model: prepares nothing, since its audio would be kept

It runs at below-normal priority and only on mains power: on battery it claims
nothing and stops a batch between paragraphs, so a laptop never spends its
battery on audio. Listening itself is unaffected.

Run:  python -m tts.prepare      (from backend/, as the desktop app does)
Env:  STUDY_URL, PROCESSOR_KEY, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET (as the processor)
      LISTEN_URL     the speech server (default http://127.0.0.1:8765)
      LISTEN_TOKEN   its bearer token, when it has one
      FFMPEG_BINARY  ffmpeg, when it is not on PATH (the packaged build sets it)
      PREPARE_STOP_FILE  a file whose appearance asks this loop to stop

The uploaded file is "KTM1", a little-endian uint32 header length, a JSON
header {sampleRate, samples, voice, modelVersion, tier, tokens}, then MP3.
"""

from __future__ import annotations

import json
import logging
import os
import struct
import subprocess
import sys
import time
from typing import Callable

import requests

log = logging.getLogger("listen.prepare")

MAGIC_IN = b"KTT1"
MAGIC_OUT = b"KTM1"
MP3_BITRATE = "48k"
CLAIM = {"gpu": 16, "cpu": 4}
EVICT_EVERY_SECONDS = 3600
WINDOWS = sys.platform == "win32"

Speak = Callable[[str, str], tuple[dict, bytes]]
Encode = Callable[[bytes, int], bytes]


def read_frame(body: bytes) -> tuple[dict, bytes]:
    """The header and 16-bit PCM of a KTT1 frame from the speech server."""
    if body[:4] != MAGIC_IN:
        raise ValueError("the speech server did not return a KTT1 frame")
    (n,) = struct.unpack("<I", body[4:8])
    header = json.loads(body[8 : 8 + n].decode("utf-8"))
    pcm = body[8 + n :]
    if len(pcm) != 2 * header["samples"]:
        raise ValueError("the speech server's frame is shorter than its header says")
    return header, pcm


def pack(header: dict, mp3: bytes) -> bytes:
    data = json.dumps(header, separators=(",", ":")).encode("utf-8")
    return MAGIC_OUT + struct.pack("<I", len(data)) + data + mp3


def server_speaker(url: str, token: str | None, timeout: float = 300) -> Speak:
    session = requests.Session()
    if token:
        session.headers["Authorization"] = f"Bearer {token}"

    def speak(text: str, voice: str) -> tuple[dict, bytes]:
        response = session.post(f"{url.rstrip('/')}/tts/v1/synthesise", json={"text": text, "voice": voice}, timeout=timeout)
        if response.status_code >= 400:
            raise RuntimeError(f"speech server returned {response.status_code}: {response.text[:300]}")
        return read_frame(response.content)

    return speak


def ffmpeg_mp3(pcm: bytes, sample_rate: int) -> bytes:
    """Mono 16-bit PCM as constant-bitrate MP3, which every phone browser decodes."""
    ffmpeg = os.environ.get("FFMPEG_BINARY") or "ffmpeg"
    result = subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "s16le", "-ar", str(sample_rate), "-ac", "1",
         "-i", "pipe:0", "-c:a", "libmp3lame", "-b:a", MP3_BITRATE, "-f", "mp3", "pipe:1"],
        input=pcm, capture_output=True, check=False,
        creationflags=0x08000000 if WINDOWS else 0,  # CREATE_NO_WINDOW
    )
    if result.returncode != 0 or not result.stdout:
        raise RuntimeError(f"ffmpeg could not encode the audio: {result.stderr.decode(errors='replace')[:300]}")
    return result.stdout


def prepare_one(item: dict, speak: Speak, encode: Encode, tier: str = "cpu") -> tuple[bytes, float]:
    header, pcm = speak(item["text"], item["voice"])
    seconds = header["samples"] / header["sampleRate"]
    out = {
        "sampleRate": header["sampleRate"],
        "samples": header["samples"],
        "voice": header.get("voice", item["voice"]),
        "modelVersion": header.get("modelVersion", ""),
        "tier": tier,
        "tokens": header.get("tokens", []),
    }
    return pack(out, encode(pcm, header["sampleRate"])), seconds


def work_once(
    api, speak: Speak, encode: Encode = ffmpeg_mp3, tier: str = "cpu", limit: int | None = None,
    keep_going: Callable[[], bool] = lambda: True,
) -> int:
    """Claim, prepare and upload one batch. Returns how many paragraphs were claimed.
    `keep_going` is asked before each paragraph, so unplugging the computer stops
    the batch at once; the paragraphs left are handed out again when their lease ends."""
    items = api.listen_claim(limit or CLAIM.get(tier, 4), tier)
    for item in items:
        if not keep_going():
            log.info("stopping this batch: %d paragraphs are left for another time", len(items) - items.index(item))
            break
        try:
            data, seconds = prepare_one(item, speak, encode, tier)
            api.listen_put(item["key"], data, seconds, tier)
        except Exception as exc:  # one paragraph failing must not stop the rest
            log.warning("could not prepare %s: %s", item["key"], exc)
            api.listen_fail(item["key"], str(exc)[:1000])
    return len(items)


def server_tier(url: str) -> str | None:
    """The speech server's tier from /tts/v1/health, or None when it is not answering."""
    try:
        response = requests.get(f"{url.rstrip('/')}/tts/v1/health", timeout=5)
        if not response.ok:
            return None
        return str(response.json().get("tier") or "cpu")
    except (requests.RequestException, ValueError):
        return None


def plugged_in(ac_line_status: int) -> bool:
    """Whether Windows' ACLineStatus means mains power. 0 is the battery, 1 is
    mains power, and 255 means Windows cannot tell, which is how a desktop with
    no battery can report itself, so it counts as plugged in."""
    return ac_line_status != 0


def on_battery() -> bool:
    """Whether this Windows machine is running on its battery. Audio is only
    prepared on mains power, so a laptop never spends its battery on it."""
    if not WINDOWS:
        return False
    import ctypes

    class Power(ctypes.Structure):
        _fields_ = [("ac", ctypes.c_ubyte), ("flag", ctypes.c_ubyte), ("percent", ctypes.c_ubyte),
                    ("reserved", ctypes.c_byte), ("life", ctypes.c_ulong), ("full", ctypes.c_ulong)]

    status = Power()
    if not ctypes.windll.kernel32.GetSystemPowerStatus(ctypes.byref(status)):
        return False
    return not plugged_in(status.ac)


def set_background_priority() -> None:
    if WINDOWS:
        import ctypes

        ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x00004000)  # BELOW_NORMAL
    else:
        try:
            os.nice(10)
        except OSError:
            pass


def asked_to_stop() -> bool:
    stop = os.environ.get("PREPARE_STOP_FILE")
    return bool(stop) and os.path.exists(stop)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s", stream=sys.stdout)
    from study.api import api_from_env  # the processor's own client and settings

    set_background_priority()
    api = api_from_env()
    url = os.environ.get("LISTEN_URL", "http://127.0.0.1:8765")
    speak = server_speaker(url, os.environ.get("LISTEN_TOKEN") or None)
    idle = 5.0
    last_evict = 0.0
    while not asked_to_stop():
        if time.monotonic() - last_evict > EVICT_EVERY_SECONDS:
            # Keeps prepared audio under its cap in R2 (worker/listen.ts, /evict).
            last_evict = time.monotonic()
            try:
                for _ in range(10):  # at most 500 paragraphs an hour, a batch a request
                    if not api.listen_evict(50).get("evicted"):
                        break
            except Exception as exc:
                log.warning("could not clear out old audio: %s", exc)
        tier = server_tier(url)
        if tier is None or tier == "basic" or on_battery():
            # Nothing is claimed while the speech server is down, on the compressed
            # model, or on battery, so no paragraph waits on this machine's lease.
            time.sleep(30)
            continue
        try:
            claimed = work_once(api, speak, tier=tier, keep_going=lambda: not on_battery() and not asked_to_stop())
        except Exception as exc:  # the Worker or the network; try again shortly
            log.warning("could not reach the Worker: %s", exc)
            claimed = 0
        if claimed:
            idle = 5.0
        else:
            time.sleep(idle)
            idle = min(idle * 2, 60.0)
    log.info("stopping, as asked")


if __name__ == "__main__":
    main()
