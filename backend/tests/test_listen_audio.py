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


def test_a_processor_only_machine_waits_while_a_graphics_card_machine_is_about(api):
    prepare(api, ["Fresh."], item="tiers")
    assert api.listen_claim(8, "gpu") != [], "a gpu machine claims at once, and is now known to be about"
    prepare(api, ["Another fresh one."], item="tiers2")
    assert api.listen_claim(8, "cpu") == [], "a cpu machine leaves it for the gpu machine for a few minutes"
    assert [c["text"] for c in api.listen_claim(8, "gpu")] == ["Another fresh one."]


def test_a_graphics_card_machine_remakes_audio_a_processor_made(api):
    key = prepare(api, ["Made on the processor."], item="up")[0]["key"]
    assert work_once(api, fake_speak, fake_mp3, tier="cpu") == 1
    item = prepare(api, ["Made on the processor."], item="up")[0]
    assert item["ready"] and item["tier"] == "cpu"
    claimed = api.listen_claim(8, "gpu")
    assert [c["key"] for c in claimed] == [key], "nothing new is waiting, so the gpu machine remakes it"
    assert prepare(api, ["Made on the processor."], item="up")[0]["ready"], "the old audio stays playable meanwhile"
    data, seconds = prepare_one(claimed[0], fake_speak, fake_mp3, "gpu")
    api.listen_put(key, data, seconds, "gpu")
    assert prepare(api, ["Made on the processor."], item="up")[0]["tier"] == "gpu"
    assert api.listen_claim(8, "gpu") == [], "audio from a gpu machine is not remade"


def test_audio_is_only_prepared_on_mains_power(api):
    from tts.prepare import plugged_in

    assert not plugged_in(0) and plugged_in(1) and plugged_in(255), "255, unknown, is a desktop with no battery"
    prepare(api, ["One.", "Two.", "Three."], item="power")
    asked = []

    def unplugged_after_one():
        asked.append(1)
        return len(asked) == 1

    assert work_once(api, fake_speak, fake_mp3, keep_going=unplugged_after_one) == 3
    ready = [i["ready"] for i in prepare(api, ["One.", "Two.", "Three."], item="power")]
    # Which paragraph went first is the claim order's business, which the
    # reading-order test covers; this test is only about stopping the batch.
    assert ready.count(True) == 1, "the batch stopped once the computer was unplugged"


# Rows D1 counts for each paragraph written, as ROW_COST in app/src/lib/listen/limits.ts.
ROW_COST = 3


def usage(api):
    return api._json("GET", "/api/listen/usage")


def test_reopening_a_reading_within_the_hour_writes_nothing(api):
    texts = [f"Paragraph {i}." for i in range(5)]
    prepare(api, texts, item="again")
    first = usage(api)["writesToday"]
    assert first == 5 * ROW_COST, "each new paragraph costs its own row and one for each index"
    prepare(api, texts, item="again")
    assert usage(api)["writesToday"] == first


def test_the_daily_write_budget_holds_new_paragraphs_back(api):
    body = {"itemId": "budget", "voice": VOICE, "utterances": [f"Budget {i}." for i in range(10)], "testBudget": 4 * ROW_COST}
    reply = api._json("POST", "/api/listen/prepare", json=body)
    assert reply["held"] == "budget"
    assert len(api.listen_claim(16)) == 4, "four paragraphs' worth of budget queues four paragraphs"
    assert usage(api)["writeBudget"] == 30_000, "the real budget is unchanged by a test's"


def test_audio_storage_is_counted_capped_and_cleared_out(api):
    keys = [i["key"] for i in prepare(api, ["Stored one.", "Stored two."], item="store")]
    work_once(api, fake_speak, fake_mp3)
    stored = usage(api)["audioBytes"]
    assert stored > 0
    body = {"itemId": "store", "voice": VOICE, "utterances": ["Something new."], "testCap": 1}
    assert api._json("POST", "/api/listen/prepare", json=body)["held"] == "storage"
    assert api.listen_claim(8) == [], "nothing new is queued at the cap"
    cleared = api._json("POST", "/api/processor/listen/evict", json={"limit": 50, "testCap": 1, "testDays": 0})
    assert cleared["evicted"] == 2 and cleared["bytes"] == 0
    assert usage(api)["audioBytes"] == 0
    for key in keys:
        try:
            api._request("GET", f"/api/listen/audio/{key}")
        except Exception as exc:
            assert "404" in str(exc)
        else:
            raise AssertionError("cleared audio is still served")
    assert [i["ready"] for i in prepare(api, ["Stored one."], item="store")] == [False], "asked for again, it is queued again"


def test_nothing_is_cleared_out_below_the_cap(api):
    prepare(api, ["Small."], item="small")
    work_once(api, fake_speak, fake_mp3)
    assert api._json("POST", "/api/processor/listen/evict", json={"limit": 50, "testDays": 0})["evicted"] == 0


def test_usage_reports_the_database_size_and_limits(api):
    report = usage(api)
    assert report["audioCap"] == 5 * 1024**3 and report["databaseLimit"] == 500 * 1024**2
    assert report["databaseBytes"] is None or report["databaseBytes"] > 0
