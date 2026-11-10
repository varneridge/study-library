"""Local Kokoro speech for Study Library's Listen feature.

Runs hexgrad's `kokoro` KPipeline (the same engine Kokoro-TTS-Local wraps) on
the WSL machine, on CUDA when available, and returns each utterance's audio
together with word timestamps (misaki MToken.start_ts / end_ts, English only).

Run:  uvicorn backend.tts.server:app --host 127.0.0.1 --port 8765
Env:  LISTEN_TOKEN       bearer token required when set (always set it behind a tunnel)
      LISTEN_ORIGINS     comma-separated origins allowed by CORS
      LISTEN_DEVICE      "cuda" or "cpu" (default: cuda when available)

Wire format of POST /tts/v1/synthesise (application/x-kokoro-utterance):
  bytes 0..3   b"KTT1"
  bytes 4..7   little-endian uint32 N, the length of the JSON header
  bytes 8..8+N UTF-8 JSON {sampleRate, samples, voice, modelVersion,
               tokens: [{text, start, end}]}  (seconds from the utterance start)
  rest         mono PCM, signed 16-bit little-endian, `samples` samples
"""

from __future__ import annotations

import hmac
import inspect
import json
import os
import struct
import threading
from dataclasses import dataclass
from typing import Callable, Iterable, Protocol

import numpy as np
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

MAGIC = b"KTT1"
SAMPLE_RATE = 24_000
MAX_TEXT_CHARS = 1_000
MODEL_VERSION = "kokoro-82m-v1.0+kpipeline"

# Kokoro v1.0 English voices with their published grades. British first: the
# app's default is British English (bf_emma).
VOICES: list[dict] = [
    {"id": "bf_emma", "name": "Emma", "lang": "en-GB", "gender": "Female", "grade": "B-"},
    {"id": "bf_isabella", "name": "Isabella", "lang": "en-GB", "gender": "Female", "grade": "C"},
    {"id": "bm_george", "name": "George", "lang": "en-GB", "gender": "Male", "grade": "C"},
    {"id": "bm_fable", "name": "Fable", "lang": "en-GB", "gender": "Male", "grade": "C"},
    {"id": "bm_lewis", "name": "Lewis", "lang": "en-GB", "gender": "Male", "grade": "D+"},
    {"id": "bf_alice", "name": "Alice", "lang": "en-GB", "gender": "Female", "grade": "D"},
    {"id": "bf_lily", "name": "Lily", "lang": "en-GB", "gender": "Female", "grade": "D"},
    {"id": "bm_daniel", "name": "Daniel", "lang": "en-GB", "gender": "Male", "grade": "D"},
    {"id": "af_heart", "name": "Heart", "lang": "en-US", "gender": "Female", "grade": "A"},
    {"id": "af_bella", "name": "Bella", "lang": "en-US", "gender": "Female", "grade": "A-"},
    {"id": "af_nicole", "name": "Nicole", "lang": "en-US", "gender": "Female", "grade": "B-"},
    {"id": "af_aoede", "name": "Aoede", "lang": "en-US", "gender": "Female", "grade": "C+"},
    {"id": "af_kore", "name": "Kore", "lang": "en-US", "gender": "Female", "grade": "C+"},
    {"id": "af_sarah", "name": "Sarah", "lang": "en-US", "gender": "Female", "grade": "C+"},
    {"id": "am_fenrir", "name": "Fenrir", "lang": "en-US", "gender": "Male", "grade": "C+"},
    {"id": "am_michael", "name": "Michael", "lang": "en-US", "gender": "Male", "grade": "C+"},
    {"id": "am_puck", "name": "Puck", "lang": "en-US", "gender": "Male", "grade": "C+"},
]
VOICE_IDS = {v["id"] for v in VOICES}


class Engine(Protocol):
    def synthesise(self, text: str, voice: str) -> tuple[np.ndarray, list[dict]]: ...
    def device(self) -> str: ...


def lang_code(voice: str) -> str:
    """Kokoro's pipeline language: "b" (British) for bf_/bm_ voices, "a" (American) otherwise."""
    return "b" if voice.startswith(("bf_", "bm_")) else "a"


@dataclass
class KokoroEngine:
    """hexgrad KPipeline, one pipeline per language sharing one model, one call at a time."""

    pipeline_factory: Callable[[str], Callable[..., Iterable]] | None = None
    _device: str = "cpu"

    def __post_init__(self) -> None:
        self._pipelines: dict[str, Callable[..., Iterable]] = {}
        self._lock = threading.Lock()
        if self.pipeline_factory is None:
            self.pipeline_factory = self._default_factory

    def _default_factory(self, code: str):
        import torch  # imported lazily so tests never need it
        from kokoro import KModel, KPipeline

        want = os.environ.get("LISTEN_DEVICE") or ("cuda" if torch.cuda.is_available() else "cpu")
        self._device = want
        if not hasattr(self, "_model"):
            self._model = KModel(repo_id="hexgrad/Kokoro-82M").to(want).eval()
        return KPipeline(lang_code=code, repo_id="hexgrad/Kokoro-82M", model=self._model)

    def device(self) -> str:
        return self._device

    def _pipeline(self, code: str):
        if code not in self._pipelines:
            self._pipelines[code] = self.pipeline_factory(code)
        return self._pipelines[code]

    def synthesise(self, text: str, voice: str) -> tuple[np.ndarray, list[dict]]:
        with self._lock:
            pipeline = self._pipeline(lang_code(voice))
            chunks: list[np.ndarray] = []
            tokens: list[dict] = []
            offset = 0.0
            # Speed stays 1.0: playback speed is the media element's job, so a
            # speed change never needs new audio (as Kokoro-Clipboard-TTS does
            # with its Sonic DSP).
            for result in pipeline(text, voice=voice, speed=1.0, split_pattern=None):
                audio = result.audio
                if audio is None:
                    continue
                audio = audio.detach().cpu().numpy() if hasattr(audio, "detach") else np.asarray(audio)
                audio = np.asarray(audio, dtype=np.float32).reshape(-1)
                for tok in getattr(result, "tokens", None) or []:
                    start, end = getattr(tok, "start_ts", None), getattr(tok, "end_ts", None)
                    if start is None or end is None or not (tok.text or "").strip():
                        continue
                    tokens.append({"text": tok.text, "start": offset + float(start), "end": offset + float(end)})
                chunks.append(audio)
                offset += len(audio) / SAMPLE_RATE
            pcm = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
            return pcm, tokens


def encode_frame(pcm: np.ndarray, tokens: list[dict], voice: str) -> bytes:
    clipped = np.clip(pcm, -1.0, 1.0)
    s16 = (clipped * 32767.0).round().astype("<i2")
    header = json.dumps(
        {"sampleRate": SAMPLE_RATE, "samples": int(s16.size), "voice": voice, "modelVersion": MODEL_VERSION, "tokens": tokens},
        separators=(",", ":"),
    ).encode("utf-8")
    return MAGIC + struct.pack("<I", len(header)) + header + s16.tobytes()


def decode_frame(body: bytes) -> tuple[dict, np.ndarray]:
    """The inverse of encode_frame, for tests and tools."""
    if body[:4] != MAGIC:
        raise ValueError("not a KTT1 frame")
    (n,) = struct.unpack("<I", body[4:8])
    header = json.loads(body[8 : 8 + n].decode("utf-8"))
    pcm = np.frombuffer(body[8 + n :], dtype="<i2")
    if pcm.size != header["samples"]:
        raise ValueError("sample count does not match header")
    return header, pcm


class SynthesiseRequest(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_TEXT_CHARS)
    voice: str = "bf_emma"


DEFAULT_ORIGINS = [
    "https://study.samuelleigh.co.uk",
    "https://study-library.samuel-leigh147.workers.dev",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]


def create_app(engine: Engine | None = None, token: str | None = None, origins: list[str] | None = None) -> FastAPI:
    app = FastAPI(title="Study Library Listen", docs_url=None, redoc_url=None)
    engine = engine or KokoroEngine()
    token = token if token is not None else os.environ.get("LISTEN_TOKEN") or None
    if origins is None:
        env_origins = [o for o in os.environ.get("LISTEN_ORIGINS", "").split(",") if o]
        origins = env_origins if env_origins else list(DEFAULT_ORIGINS)

    # Chrome asks before a public page may call a private address (Private
    # Network Access); answering yes is safe because CORS and the token still
    # apply. Starlette 0.4x and later answer it themselves when asked to, and
    # refuse the preflight with a 400 when not, so a header added by a later
    # middleware never reaches the browser.
    native_pna = "allow_private_network" in inspect.signature(CORSMiddleware.__init__).parameters
    cors = {
        "allow_origins": origins,
        "allow_methods": ["GET", "POST"],
        "allow_headers": ["Authorization", "Content-Type"],
        "max_age": 600,
    }
    if native_pna:
        cors["allow_private_network"] = True
    app.add_middleware(CORSMiddleware, **cors)

    if not native_pna:

        @app.middleware("http")
        async def private_network_access(request: Request, call_next):
            response = await call_next(request)
            if request.method == "OPTIONS" and request.headers.get("access-control-request-private-network") == "true":
                response.headers["Access-Control-Allow-Private-Network"] = "true"
            return response

    def check(authorization: str | None) -> None:
        if token is None:
            return
        supplied = (authorization or "").removeprefix("Bearer ").strip()
        if not hmac.compare_digest(supplied.encode(), token.encode()):
            raise HTTPException(status_code=401, detail={"code": "unauthorised", "message": "A valid Listen token is required."})

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, exc: HTTPException):
        detail = exc.detail if isinstance(exc.detail, dict) else {"code": "error", "message": str(exc.detail)}
        return JSONResponse(status_code=exc.status_code, content={"error": detail})

    @app.get("/tts/v1/health")
    def health() -> dict:
        return {"ok": True, "modelVersion": MODEL_VERSION}

    @app.get("/tts/v1/voices")
    def voices(authorization: str | None = Header(default=None)) -> list[dict]:
        check(authorization)
        return VOICES

    @app.post("/tts/v1/synthesise")
    def synthesise(req: SynthesiseRequest, authorization: str | None = Header(default=None)) -> Response:
        check(authorization)
        if req.voice not in VOICE_IDS:
            raise HTTPException(status_code=400, detail={"code": "unknown_voice", "message": f"Unknown voice {req.voice}."})
        try:
            pcm, tokens = engine.synthesise(req.text, req.voice)
        except Exception as exc:  # the engine's own failure, reported rather than hidden
            raise HTTPException(status_code=500, detail={"code": "synthesis_failed", "message": str(exc)[:300]}) from exc
        return Response(content=encode_frame(pcm, tokens, req.voice), media_type="application/x-kokoro-utterance")

    return app


app = create_app()
