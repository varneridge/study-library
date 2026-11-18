"""Prepared Listen audio, end to end against the local Worker: a reader queues
paragraphs, the preparation worker claims, prepares and uploads them, and the
reader fetches the finished file."""

from __future__ import annotations

import json
import struct

from tts.prepare import pack, prepare_one, read_frame, work_once

VOICE = "bf_emma"


def fake_speak(text: str, voice: str) -> tuple[dict, bytes]:
    samples = 2400 * len(text.split())
    header = {"sampleRate": 24000, "samples": samples, "voice": voice, "modelVersion": "test",
              "tokens": [{"text": w, "start": 0.1 * i, "end": 0.1 * i + 0.1} for i, w in enumerate(text.split())]}
    return header, b"\x00\x00" * samples


def fake_mp3(pcm: bytes, rate: int) -> bytes:
    return b"ID3fake" + struct.pack("<I", len(pcm))


def prepare(api, texts, item="i1", voice=VOICE):
    return api._json("POST", "/api/listen/prepare", json={"itemId": item, "voice": voice, "utterances": texts})["items"]


def test_paragraphs_are_queued_prepared_and_served(api):
    items = prepare(api, ["First paragraph here.", "Second one."])
    assert [i["ready"] for i in items] == [False, False]
    assert work_once(api, fake_speak, fake_mp3) == 2
    assert work_once(api, fake_speak, fake_mp3) == 0, "nothing is handed out twice"
    body = api._request("GET", f"/api/listen/audio/{items[0]['key']}").content
    assert body[:4] == b"KTM1"
    (n,) = struct.unpack("<I", body[4:8])
    header = json.loads(body[8 : 8 + n])
    assert header["samples"] == 2400 * 3 and [t["text"] for t in header["tokens"]] == ["First", "paragraph", "here."]
    assert body[8 + n :].startswith(b"ID3fake")
    assert [i["ready"] for i in prepare(api, ["First paragraph here.", "Second one."])] == [True, True]


def test_keys_depend_on_voice_and_text_only(api):
    a = prepare(api, ["Same words."], item="i1")[0]["key"]
    b = prepare(api, ["Same words."], item="i2")[0]["key"]
    c = prepare(api, ["Same words."], voice="bm_george")[0]["key"]
    assert a == b and a != c and len(a) == 40


def test_the_reading_asked_for_last_is_prepared_first_in_reading_order(api):
    prepare(api, ["Old one.", "Old two."], item="old")
    import time
    time.sleep(0.01)
    prepare(api, ["New one.", "New two.", "New three."], item="new")
    claimed = api.listen_claim(3)
    assert [c["text"] for c in claimed] == ["New one.", "New two.", "New three."]


def test_failures_are_retried_then_given_up_and_asked_for_again(api):
    key = prepare(api, ["Broken."])[0]["key"]

    def broken(text, voice):
        raise RuntimeError("no voice")

    for _ in range(3):
        work_once(api, broken, fake_mp3)
    assert api.listen_claim(8) == [], "a paragraph that failed three times waits"
    prepare(api, ["Broken."])
    assert [c["key"] for c in api.listen_claim(8)] == [key], "asking again tries it again"


def test_only_prepared_audio_is_accepted_and_served(api):
    key = prepare(api, ["Real."])[0]["key"]
    for bad in (b"", b"not audio at all"):
        try:
            api.listen_put(key, bad, 1.0)
        except Exception as exc:
            assert "400" in str(exc)
        else:
            raise AssertionError("bad audio was accepted")
    try:
        api._request("GET", "/api/listen/audio/not-a-key")
    except Exception as exc:
        assert "400" in str(exc)
    try:
        api._request("GET", f"/api/listen/audio/{'0' * 40}")
    except Exception as exc:
        assert "404" in str(exc)


def test_frames_round_trip():
    header, pcm = fake_speak("one two", VOICE)
    frame = b"KTT1" + struct.pack("<I", len(json.dumps(header))) + json.dumps(header).encode() + pcm
    assert read_frame(frame) == (header, pcm)
    data, seconds = prepare_one({"key": "k", "text": "one two", "voice": VOICE}, fake_speak, fake_mp3)
    assert data[:4] == b"KTM1" and seconds == 0.2
    assert pack({"a": 1}, b"x")[8:] == b'{"a":1}x'
