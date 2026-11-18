"""Local Kokoro speech for Study Library's Listen feature.

Two engines give the same answer. On Windows, `kokoro-onnx` runs the Kokoro
v1.0 model on ONNX Runtime's CPU, with no PyTorch; it gives no word timings,
so each word's time is estimated from its share of its sentence's speech.
Elsewhere hexgrad's `kokoro` KPipeline (the same engine Kokoro-TTS-Local
wraps) runs on CUDA when available and gives word timestamps itself (misaki
MToken.start_ts / end_ts, English only).

Run from backend/:  uvicorn tts.server:app --host 127.0.0.1 --port 8765
      (the name study.desktop and the packaged build use; "backend" is not a
      package, so backend.tts.server works only from the repository root)
Env:  LISTEN_TOKEN       bearer token required when set (always set it behind a tunnel)
      LISTEN_ORIGINS     comma-separated origins allowed by CORS
      LISTEN_DEVICE      "cuda" or "cpu" (default: cuda when available)
      TTS_ENGINE         "onnx" or "torch"; by default onnx when kokoro-onnx and
                         its model files are present, torch otherwise
      STUDY_MODELS_DIR   folder holding kokoro/kokoro-v1.0(.int8).onnx and
                         kokoro/voices-v1.0.bin (default: backend/tts/models)
      STUDY_APP_VERSION  the installed desktop app's version, which study.desktop
                         sets and /tts/v1/health reports as appVersion

Wire format of POST /tts/v1/synthesise (application/x-kokoro-utterance):
  bytes 0..3   b"KTT1"
  bytes 4..7   little-endian uint32 N, the length of the JSON header
  bytes 8..8+N UTF-8 JSON {sampleRate, samples, voice, modelVersion,
               tokens: [{text, start, end}]}  (seconds from the utterance start)
  rest         mono PCM, signed 16-bit little-endian, `samples` samples
"""

from __future__ import annotations

import hmac
import importlib.util
import inspect
import json
import os
import re
import shutil
import struct
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable, Protocol

import numpy as np
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from .pronounce import espeak_parts, join_sounds, prepare_for_misaki, sentences

MAGIC = b"KTT1"
SAMPLE_RATE = 24_000
MAX_TEXT_CHARS = 1_000
MODEL_VERSION = "kokoro-82m-v1.0+kpipeline"
ONNX_MODEL_VERSION = "kokoro-82m-v1.0+onnx"

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

    def describe(self) -> dict:
        """Which engine this is, for /tts/v1/health and the preparation worker."""
        if self._pipelines:
            device = self._device
        else:  # not loaded yet: the device it will choose
            device = os.environ.get("LISTEN_DEVICE") or ("cuda" if _torch_on_cuda() else "cpu")
        return {"engine": "torch", "device": device, "precision": "fp32", "tier": "gpu" if device == "cuda" else "cpu"}

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
            # Dates, abbreviations and pinyin names are written out first (pronounce.py),
            # with names as fixed sounds in misaki's own link syntax.
            spoken = prepare_for_misaki(text, british=lang_code(voice) == "b")
            for result in pipeline(spoken, voice=voice, speed=1.0, split_pattern=None):
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


_SENTENCE_END = re.compile(r"(?<=[.!?\u2026])\s+")
_WORD = re.compile(r"[^\W_](?:[\w\u2019'-]*[^\W_])?")
# How much speaking time a word gets per letter, and the pause after a mark,
# in the same units. Rough, but it keeps the highlight on the right word.
_LETTER_WEIGHT = 1.0
_WORD_WEIGHT = 1.5
_PAUSE_WEIGHT = {",": 2.0, ";": 3.0, ":": 3.0, "\u2014": 3.0, "(": 1.5, ")": 1.5}


def estimate_tokens(text: str, audio: np.ndarray, offset: float) -> list[dict]:
    """Word times for one sentence's audio, which kokoro-onnx does not give.

    The voiced part of the audio (silence trimmed at each end) is shared out
    among the words by length, with a pause after commas and the like."""
    words = list(_WORD.finditer(text))
    if not words or audio.size == 0:
        return []
    level = np.abs(audio)
    voiced = np.flatnonzero(level > max(1e-4, 0.02 * float(level.max())))
    begin = voiced[0] / SAMPLE_RATE if voiced.size else 0.0
    end = (voiced[-1] + 1) / SAMPLE_RATE if voiced.size else audio.size / SAMPLE_RATE
    spans: list[tuple[float, float]] = []  # (speaking weight, pause weight after)
    for index, word in enumerate(words):
        gap = text[word.end():words[index + 1].start()] if index + 1 < len(words) else ""
        pause = max((_PAUSE_WEIGHT.get(ch, 0.0) for ch in gap), default=0.0)
        spans.append((_WORD_WEIGHT + _LETTER_WEIGHT * len(word.group()), pause))
    scale = (end - begin) / sum(speak + pause for speak, pause in spans)
    tokens, at = [], begin
    for word, (speak, pause) in zip(words, spans):
        tokens.append({"text": word.group(), "start": round(offset + at, 3), "end": round(offset + at + speak * scale, 3)})
        at += (speak + pause) * scale
    return tokens


def _models_dir() -> Path:
    return Path(os.environ.get("STUDY_MODELS_DIR") or Path(__file__).resolve().parent / "models") / "kokoro"


def _onnx_files() -> tuple[Path, Path] | None:
    folder = _models_dir()
    voices = folder / "voices-v1.0.bin"
    for name in ("kokoro-v1.0.onnx", "kokoro-v1.0.int8.onnx"):
        if (folder / name).is_file() and voices.is_file():
            return folder / name, voices
    return None


@dataclass
class OnnxEngine:
    """kokoro-onnx on ONNX Runtime's CPU, one call at a time. Each sentence is
    spoken on its own, so an estimated word time can only drift within it."""

    kokoro_factory: Callable[[], object] | None = None
    model_version: str = ONNX_MODEL_VERSION
    _kokoro: object | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        self._lock = threading.Lock()
        if self.kokoro_factory is None:
            self.kokoro_factory = self._default_factory

    @staticmethod
    def _default_factory():
        from kokoro_onnx import Kokoro  # imported lazily so tests never need it

        files = _onnx_files()
        if files is None:
            raise RuntimeError(f"Kokoro model files are missing from {_models_dir()}")
        import onnxruntime as rt

        # A graphics card when this ONNX Runtime has a provider for one (the
        # DirectML or CUDA build), the processor otherwise.
        available = rt.get_available_providers()
        wanted = [p for p in GPU_PROVIDERS if p in available and os.environ.get("LISTEN_DEVICE", "") != "cpu"]
        providers = [*wanted, "CPUExecutionProvider"]
        session = rt.InferenceSession(str(files[0]), providers=providers)
        OnnxEngine._provider = session.get_providers()[0]
        return Kokoro.from_session(session, str(files[1]))

    def device(self) -> str:
        return "cpu"

    def describe(self) -> dict:
        files = _onnx_files()
        precision = "int8" if files and files[0].name.endswith(".int8.onnx") else "fp32"
        provider = getattr(self, "_provider", "CPUExecutionProvider")
        device = "gpu" if provider in GPU_PROVIDERS else "cpu"
        tier = "gpu" if device == "gpu" else ("cpu" if precision == "fp32" else "basic")
        return {"engine": "onnx", "device": device, "provider": provider, "precision": precision, "tier": tier}

    def synthesise(self, text: str, voice: str) -> tuple[np.ndarray, list[dict]]:
        """Each sentence is phonemised here, so words the app marked with fixed
        sounds ("[Xiaoping](/\u0283ja\u028ap\u02c8\u026a\u014b/)") keep them: the plain stretches go through
        kokoro-onnx's own espeak-ng front end and the whole sentence is spoken
        from its sounds. kokoro-onnx 0.6 reports when each sound is spoken if
        the model file has a duration output, and word times come from that;
        otherwise they are estimated from each word's share of the sentence."""
        with self._lock:
            if self._kokoro is None:
                self._kokoro = self.kokoro_factory()
            kokoro = self._kokoro
            lang = "en-gb" if lang_code(voice) == "b" else "en-us"
            tokenizer = getattr(kokoro, "tokenizer", None)
            chunks: list[np.ndarray] = []
            tokens: list[dict] = []
            offset = 0.0
            for sentence in sentences(espeak_parts(text)):
                written = " ".join("".join(t for t, _ in sentence).split())
                if not written:
                    continue
                if tokenizer is not None:
                    phonemes = join_sounds(sentence, lambda t: tokenizer.phonemize(t, lang))
                    if hasattr(kokoro, "create_timed"):
                        audio, rate, timed = kokoro.create_timed(phonemes, voice=voice, speed=1.0, lang=lang, is_phonemes=True)
                    else:
                        (audio, rate), timed = kokoro.create(phonemes, voice=voice, speed=1.0, lang=lang, is_phonemes=True), []
                else:  # a test double, or a kokoro-onnx without a tokenizer: plain words only
                    (audio, rate), timed = kokoro.create(written, voice=voice, speed=1.0, lang=lang), []
                if int(rate) != SAMPLE_RATE:
                    raise RuntimeError(f"kokoro-onnx returned {rate} Hz audio, expected {SAMPLE_RATE}")
                audio = np.asarray(audio, dtype=np.float32).reshape(-1)
                words = tokens_from_timings(written, timed, offset) or estimate_tokens(written, audio, offset)
                tokens.extend(words)
                chunks.append(audio)
                offset += audio.size / SAMPLE_RATE
            pcm = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
            return pcm, tokens


# ONNX Runtime providers that run on a graphics card, best first. DirectML runs
# on any DirectX 12 card on Windows; CUDA needs NVIDIA's libraries beside it.
GPU_PROVIDERS = ("CUDAExecutionProvider", "DmlExecutionProvider")


def tokens_from_timings(written: str, timed: list, offset: float) -> list[dict]:
    """Word times from kokoro-onnx's per-sound timings, when its spoken words
    line up one to one with the written ones; empty otherwise, so the caller
    estimates instead (numbers, for one, are several spoken words)."""
    if not timed:
        return []
    words = list(_WORD.finditer(written))
    spans: list[list[float]] = []
    current: list[float] | None = None
    for t in timed:
        ch = getattr(t, "phoneme", "")
        if ch.isspace() or ch in ".,;:!?\u2026\u00ab\u00bb\u201c\u201d\"()-":
            if current is not None:
                spans.append(current)
                current = None
            continue
        if current is None:
            current = [float(t.start), float(t.end)]
        else:
            current[1] = float(t.end)
    if current is not None:
        spans.append(current)
    if len(spans) != len(words):
        return []
    return [{"text": w.group(), "start": round(offset + a, 3), "end": round(offset + b, 3)} for w, (a, b) in zip(words, spans)]


def _torch_on_cuda() -> bool:
    """Whether the PyTorch pipeline is installed and can use an NVIDIA card,
    as with the high-quality speech pack (desktop.py)."""
    if importlib.util.find_spec("torch") is None or importlib.util.find_spec("kokoro") is None:
        return False
    try:
        import torch

        return bool(torch.cuda.is_available())
    except Exception:  # a broken CUDA install is no reason not to speak
        return False


def default_engine() -> Engine:
    """TTS_ENGINE decides when set. Otherwise the best engine this machine can
    run: PyTorch with misaki on an NVIDIA card, which pronounces ordinary words
    best and gives real word timings; then kokoro-onnx with its model files,
    on a graphics card when ONNX Runtime has one, else the processor; then
    PyTorch on the processor."""
    choice = (os.environ.get("TTS_ENGINE") or "").strip().lower()
    if choice == "onnx":
        return OnnxEngine()
    if choice == "torch":
        return KokoroEngine()
    if _torch_on_cuda():
        return KokoroEngine()
    if importlib.util.find_spec("kokoro_onnx") is not None and _onnx_files() is not None:
        return OnnxEngine()
    return KokoroEngine()


def encode_frame(pcm: np.ndarray, tokens: list[dict], voice: str, model_version: str = MODEL_VERSION) -> bytes:
    clipped = np.clip(pcm, -1.0, 1.0)
    s16 = (clipped * 32767.0).round().astype("<i2")
    header = json.dumps(
        {"sampleRate": SAMPLE_RATE, "samples": int(s16.size), "voice": voice, "modelVersion": model_version, "tokens": tokens},
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
    engine = engine or default_engine()
    # A test engine may not say which model it is; the PyTorch one never has.
    model_version = getattr(engine, "model_version", MODEL_VERSION)
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
        describe = getattr(engine, "describe", None)
        about = describe() if callable(describe) else {}
        # For Settings: whether the high-quality speech pack is running this
        # server, and whether this computer has an NVIDIA card it could use.
        smi = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "nvidia-smi.exe"
        nvidia = bool(shutil.which("nvidia-smi")) or smi.is_file()
        # The installed desktop app's version, null when it was not started by
        # study.desktop, so that Check for updates can compare the real install.
        app_version = os.environ.get("STUDY_APP_VERSION") or None
        return {"ok": True, "modelVersion": model_version, **about, "pack": os.environ.get("SPEECH_PACK") == "1", "nvidia": nvidia,
                "appVersion": app_version}

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
        return Response(content=encode_frame(pcm, tokens, req.voice, model_version), media_type="application/x-kokoro-utterance")

    return app


app = create_app()
