"""Prepares Listen audio ahead of time, on whichever machine runs it.

Readers ask the Worker for their paragraphs to be prepared (worker/listen.ts).
This loop claims a few at a time, has the local Kokoro server (server.py) read
each one, which applies the pronunciation rules in pronounce.py, compresses the
audio to MP3 with ffmpeg and uploads it. Phones then play the finished file
rather than running Kokoro in the browser.

It runs beside the speech server: on the laptop from run-processor.sh, and on
the desktop with the RTX 2060 from run-speech.sh, where CUDA makes it many
times faster. Both can run at once, since each claim is handed to one machine.

Run:  python -m backend.tts.prepare        (from the repository root)
Env:  STUDY_URL, PROCESSOR_KEY, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET (as the processor)
      LISTEN_URL     the speech server (default http://127.0.0.1:8765)
      LISTEN_TOKEN   its bearer token, when it has one

The uploaded file is "KTM1", a little-endian uint32 header length, a JSON
header {sampleRate, samples, voice, modelVersion, tokens}, then MP3.
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
CLAIM = 8

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
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "s16le", "-ar", str(sample_rate), "-ac", "1",
         "-i", "pipe:0", "-c:a", "libmp3lame", "-b:a", MP3_BITRATE, "-f", "mp3", "pipe:1"],
        input=pcm, capture_output=True, check=False,
    )
    if result.returncode != 0 or not result.stdout:
        raise RuntimeError(f"ffmpeg could not encode the audio: {result.stderr.decode(errors='replace')[:300]}")
    return result.stdout


def prepare_one(item: dict, speak: Speak, encode: Encode) -> tuple[bytes, float]:
    header, pcm = speak(item["text"], item["voice"])
    seconds = header["samples"] / header["sampleRate"]
    out = {
        "sampleRate": header["sampleRate"],
        "samples": header["samples"],
        "voice": header.get("voice", item["voice"]),
        "modelVersion": header.get("modelVersion", ""),
        "tokens": header.get("tokens", []),
    }
    return pack(out, encode(pcm, header["sampleRate"])), seconds


def work_once(api, speak: Speak, encode: Encode = ffmpeg_mp3, limit: int = CLAIM) -> int:
    """Claim, prepare and upload one batch. Returns how many paragraphs were claimed."""
    items = api.listen_claim(limit)
    for item in items:
        try:
            data, seconds = prepare_one(item, speak, encode)
            api.listen_put(item["key"], data, seconds)
        except Exception as exc:  # one paragraph failing must not stop the rest
            log.warning("could not prepare %s: %s", item["key"], exc)
            api.listen_fail(item["key"], str(exc)[:1000])
    return len(items)


def server_ready(url: str) -> bool:
    try:
        return requests.get(f"{url.rstrip('/')}/tts/v1/health", timeout=5).ok
    except requests.RequestException:
        return False


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s", stream=sys.stdout)
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    from study.api import api_from_env  # the processor's own client and settings

    api = api_from_env()
    url = os.environ.get("LISTEN_URL", "http://127.0.0.1:8765")
    speak = server_speaker(url, os.environ.get("LISTEN_TOKEN") or None)
    idle = 5.0
    while True:
        if not server_ready(url):
            # Nothing is claimed while the speech server is down, so no paragraph waits on a lease.
            time.sleep(30)
            continue
        try:
            claimed = work_once(api, speak)
        except Exception as exc:  # the Worker or the network; try again shortly
            log.warning("could not reach the Worker: %s", exc)
            claimed = 0
        if claimed:
            idle = 5.0
        else:
            time.sleep(idle)
            idle = min(idle * 2, 60.0)


if __name__ == "__main__":
    main()
