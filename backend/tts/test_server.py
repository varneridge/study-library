"""Tests for backend/tts/server.py. No model is loaded: the pipeline is faked."""

from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pytest
from fastapi.testclient import TestClient

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
