"""Tests for backend/tts/server.py. No model is loaded: the pipeline is faked."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi.testclient import TestClient

try:
    from tts.server import SAMPLE_RATE, KokoroEngine, create_app, decode_frame, encode_frame, lang_code
except ImportError:
    from backend.tts.server import SAMPLE_RATE, KokoroEngine, create_app, decode_frame, encode_frame, lang_code


def fake_pipeline_factory(calls: list):
    def factory(code: str):
        calls.append(("pipeline", code))

        def run(text, voice, speed, split_pattern):
            calls.append(("run", text, voice, speed))
            # Two chunks of 0.5 s each, as KPipeline yields for long text.
            for words in (["Hello", ","], ["world", "."]):
                toks = [SimpleNamespace(text=w, start_ts=0.1 * i, end_ts=0.1 * i + 0.1) for i, w in enumerate(words)]
                toks.append(SimpleNamespace(text="x", start_ts=None, end_ts=None))  # Kokoro leaves some untimed
                yield SimpleNamespace(audio=np.full(SAMPLE_RATE // 2, 0.25, dtype=np.float32), tokens=toks)

        return run

    return factory


def test_lang_code_follows_voice_prefix():
    assert lang_code("bf_emma") == "b"
    assert lang_code("bm_george") == "b"
    assert lang_code("af_heart") == "a"


def test_engine_offsets_tokens_across_chunks_and_drops_untimed():
    calls: list = []
    engine = KokoroEngine(pipeline_factory=fake_pipeline_factory(calls))
    pcm, tokens = engine.synthesise("Hello, world.", "bf_emma")
    assert pcm.shape == (SAMPLE_RATE,)
    assert [t["text"] for t in tokens] == ["Hello", ",", "world", "."]
    assert tokens[2]["start"] == pytest.approx(0.5)
    assert ("pipeline", "b") in calls
    assert all(c[3] == 1.0 for c in calls if c[0] == "run"), "synthesis always runs at speed 1.0"


def test_frame_round_trip():
    pcm = np.linspace(-1, 1, 480, dtype=np.float32)
    header, s16 = decode_frame(encode_frame(pcm, [{"text": "a", "start": 0, "end": 0.01}], "bf_emma"))
    assert header["sampleRate"] == 24000 and header["samples"] == 480
    assert s16[0] == -32767 and s16[-1] == 32767


@pytest.fixture
def client():
    engine = KokoroEngine(pipeline_factory=fake_pipeline_factory([]))
    return TestClient(create_app(engine=engine, token="secret", origins=["https://study.example"]))


def auth():
    return {"Authorization": "Bearer secret"}


def test_health_is_open(client):
    assert client.get("/tts/v1/health").json()["ok"] is True


def test_token_is_required(client):
    assert client.get("/tts/v1/voices").status_code == 401
    r = client.post("/tts/v1/synthesise", json={"text": "Hi", "voice": "bf_emma"})
    assert r.status_code == 401 and r.json()["error"]["code"] == "unauthorised"


def test_voices_are_british_first(client):
    voices = client.get("/tts/v1/voices", headers=auth()).json()
    assert voices[0]["id"] == "bf_emma" and voices[0]["lang"] == "en-GB"


def test_synthesise_returns_frame(client):
    r = client.post("/tts/v1/synthesise", json={"text": "Hello, world.", "voice": "bf_emma"}, headers=auth())
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/x-kokoro-utterance"
    header, pcm = decode_frame(r.content)
    assert pcm.size == SAMPLE_RATE and len(header["tokens"]) == 4


def test_unknown_voice_and_long_text_are_refused(client):
    assert client.post("/tts/v1/synthesise", json={"text": "Hi", "voice": "zz_nobody"}, headers=auth()).json()["error"]["code"] == "unknown_voice"
    assert client.post("/tts/v1/synthesise", json={"text": "a" * 1001, "voice": "bf_emma"}, headers=auth()).status_code == 422


def test_private_network_preflight(client):
    r = client.options(
        "/tts/v1/synthesise",
        headers={
            "Origin": "https://study.example",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type",
            "Access-Control-Request-Private-Network": "true",
        },
    )
    assert r.status_code == 200
    assert r.headers.get("access-control-allow-private-network") == "true"
    assert r.headers.get("access-control-allow-origin") == "https://study.example"


def test_engine_sends_misaki_the_spoken_form_with_names_as_sounds():
    calls: list = []
    engine = KokoroEngine(pipeline_factory=fake_pipeline_factory(calls))
    engine.synthesise("Deng Xiaoping, c. 1975.", "bf_emma")
    sent = [c[1] for c in calls if c[0] == "run"]
    assert sent == ["[Deng](/d\u02c8\u028c\u014b/) [Xiaoping](/\u0283jWp\u02c8\u026a\u014b/), circa 1975."]


def _server():
    import importlib

    return importlib.import_module(KokoroEngine.__module__)


class _Timing:
    def __init__(self, phoneme, start, end):
        self.phoneme, self.start, self.end = phoneme, start, end


class _FakeTokenizer:
    def phonemize(self, text, lang):
        return text.strip().lower()


class _FakeOnnx:
    """kokoro-onnx 0.6's shape: a tokenizer, and create_timed taking phonemes."""

    def __init__(self, timed=True):
        self.tokenizer = _FakeTokenizer()
        self.calls = []
        self.timed = timed

    def create_timed(self, phonemes, voice, speed, lang, is_phonemes):
        self.calls.append((phonemes, is_phonemes))
        timings = []
        if self.timed:
            at = 0.0
            for ch in phonemes:
                timings.append(_Timing(ch, at, at + 0.01))
                at += 0.01
        return np.zeros(2400, dtype=np.float32), 24000, timings


def test_onnx_engine_reads_marked_words_from_their_sounds_with_real_timings():
    OnnxEngine = _server().OnnxEngine

    fake = _FakeOnnx()
    engine = OnnxEngine(kokoro_factory=lambda: fake)
    pcm, tokens = engine.synthesise("[Deng](/d\u02c8\u028c\u014b/) met Mao.", "bf_emma")
    phonemes, is_phonemes = fake.calls[0]
    assert is_phonemes and phonemes.startswith("d\u02c8\u028c\u014b met")
    assert "[" not in phonemes and "/" not in phonemes
    assert [t["text"] for t in tokens] == ["Deng", "met", "Mao"]
    assert tokens[0]["start"] == 0.0 and tokens[1]["start"] > tokens[0]["end"]


def test_onnx_engine_estimates_timings_when_words_do_not_line_up():
    OnnxEngine = _server().OnnxEngine

    fake = _FakeOnnx(timed=False)
    pcm, tokens = OnnxEngine(kokoro_factory=lambda: fake).synthesise("In 1975 they met.", "bf_emma")
    assert [t["text"] for t in tokens] == ["In", "1975", "they", "met"]


def test_engines_describe_themselves_for_health_and_preparation(monkeypatch):
    server = _server()

    monkeypatch.setattr(server, "_onnx_files", lambda: (Path("kokoro-v1.0.onnx"), Path("voices-v1.0.bin")))
    assert server.OnnxEngine(kokoro_factory=lambda: None).describe()["tier"] == "cpu"
    monkeypatch.setattr(server, "_onnx_files", lambda: (Path("kokoro-v1.0.int8.onnx"), Path("voices-v1.0.bin")))
    assert server.OnnxEngine(kokoro_factory=lambda: None).describe()["tier"] == "basic"
    monkeypatch.setattr(server, "_torch_on_cuda", lambda: True)
    assert server.KokoroEngine(pipeline_factory=lambda code: None).describe()["tier"] == "gpu"
    assert isinstance(server.default_engine(), server.KokoroEngine), "PyTorch on CUDA is preferred"
    monkeypatch.setattr(server, "_torch_on_cuda", lambda: False)
    monkeypatch.setenv("TTS_ENGINE", "onnx")
    assert isinstance(server.default_engine(), server.OnnxEngine)
