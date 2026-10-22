import hashlib
import subprocess

import pytest

from study.api import stamp
from study.processor.__main__ import Processor
from study.processor.speech import FakeTranscriber


def _tone(path, seconds=4, video=False):
    args = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}"]
    if video:
        args += ["-f", "lavfi", "-i", f"color=c=blue:s=160x120:d={seconds}", "-shortest", "-c:v", "libx264", "-c:a", "aac"]
    else:
        args += ["-c:a", "libopus"]
    subprocess.run(args + [str(path)], check=True)


def _recording(api, recording_id, status, file_id=None, source="live"):
    assert api.push([{"table": "recordings", "row": {
        "id": recording_id, "session_id": "s1l", "source": source, "file_id": file_id,
        "duration_seconds": None, "status": status,
        "modified_at": stamp(), "deleted": False}}]) == []


def _processor(api):
    return Processor(api, transcriber=FakeTranscriber())


def test_live_chunks_become_a_transcribed_recording(api, module, tmp_path):
    audio = tmp_path / "live.webm"
    _tone(audio)
    data = audio.read_bytes()
    middle = len(data) // 2
    _recording(api, "r1", "recording")
    for index, part in enumerate((data[:middle], data[middle:])):
        api._json("PUT", f"/api/recordings/r1/chunks/{index}", data=part, headers={"Content-Type": "audio/webm"})
    assert api.claim() is None

    row = api.pull_all()["recordings"]["r1"]
    api.push([{"table": "recordings", "row": {**row, "status": "uploaded", "modified_at": stamp()}}])
    # Prepare the audio, then transcribe it. There is no summary step.
    assert _processor(api).drain() == 2

    state = api.pull_all()
    recording = state["recordings"]["r1"]
    assert recording["status"] == "done"
    assert 3.5 < recording["duration_seconds"] < 4.5
    # Summaries and slide marks are gone from the schema.
    assert "summary" not in recording and "slide_marks" not in recording
    audio_file = state["files"][recording["file_id"]]
    assert audio_file["mime"] == "audio/ogg"

    # The transcript is plain text, kept on the recording.
    assert recording["turns"][0]["text"].startswith("Today we look at the Concordat of 1801.")
    assert api.recording("r1")["chunks"] == []

    found = api._json("GET", "/api/search", params={"q": "napoleon chur"})
    assert [t["recording_id"] for t in found["transcripts"]] == ["r1"]
    assert "\u0001" in found["transcripts"][0]["snippet"]


def test_audio_supports_range_requests(api, tmp_path):
    audio = tmp_path / "a.webm"
    _tone(audio)
    _recording(api, "r1", "recording")
    api._json("PUT", "/api/recordings/r1/chunks/0", data=audio.read_bytes(), headers={"Content-Type": "audio/webm"})
    row = api.pull_all()["recordings"]["r1"]
    api.push([{"table": "recordings", "row": {**row, "status": "uploaded", "modified_at": stamp()}}])
    _processor(api).drain()
    key = api.pull_all()["files"]["r1:audio"]["r2_key"]
    response = api.session.get(f"{api.base}/api/objects/{key}", headers={"Range": "bytes=10-19"})
    assert response.status_code == 206
    assert len(response.content) == 10
    assert response.headers["content-range"].startswith("bytes 10-19/")


def test_uploaded_video_goes_through_multipart(api, tmp_path):
    video = tmp_path / "lecture.mp4"
    _tone(video, seconds=3, video=True)
    sha = hashlib.sha256(video.read_bytes()).hexdigest()
    started = api._json("POST", "/api/uploads", json={"sha256": sha, "mime": "video/mp4"})
    assert started["existed"] is False
    part = api._json("PUT", f"/api/uploads/{started['upload_id']}/1", params={"key": started["key"]},
                     data=video.read_bytes())
    api._json("POST", f"/api/uploads/{started['upload_id']}/complete",
              json={"key": started["key"], "parts": [part]})
    assert api._json("POST", "/api/uploads", json={"sha256": sha, "mime": "video/mp4"})["existed"] is True

    api.push([{"table": "files", "row": {
        "id": "v1", "sha256": sha, "r2_key": started["key"], "mime": "video/mp4", "bytes": video.stat().st_size,
        "original_name": "lecture.mp4", "page_count": None, "text_status": "ready",
        "modified_at": stamp(), "deleted": False}}])
    assert api.claim() is None
    _recording(api, "r2", "uploaded", file_id="v1", source="upload")
    assert _processor(api).drain() == 2

    state = api.pull_all()
    assert state["recordings"]["r2"]["status"] == "done"
    assert state["files"]["v1"]["deleted"] is True
    with pytest.raises(Exception):
        api.download(started["key"], str(tmp_path / "gone.mp4"))


def test_retry_resumes_where_processing_stopped(api, tmp_path):
    audio = tmp_path / "a.webm"
    _tone(audio)
    _recording(api, "r1", "recording")
    api._json("PUT", "/api/recordings/r1/chunks/0", data=audio.read_bytes(), headers={"Content-Type": "audio/webm"})
    row = api.pull_all()["recordings"]["r1"]
    api.push([{"table": "recordings", "row": {**row, "status": "uploaded", "modified_at": stamp()}}])
    processor = _processor(api)
    assert processor.run_once()
    assert api._json("POST", "/api/recordings/r1/retry")["ok"] is True
    job = api.claim()
    assert job["type"] == "transcribe"


def test_page_text_search(api, tmp_path):
    import pymupdf

    pdf = tmp_path / "a.pdf"
    doc = pymupdf.open()
    doc.new_page()
    doc.new_page().insert_text((72, 72), "The Lost Chance thesis was argued by Cohen and others in this period.")
    doc.save(pdf)
    sha = hashlib.sha256(pdf.read_bytes()).hexdigest()
    key = api.upload(str(pdf), sha, "application/pdf")
    api.push([{"table": "files", "row": {
        "id": "f1", "sha256": sha, "r2_key": key, "mime": "application/pdf", "bytes": pdf.stat().st_size,
        "original_name": "a.pdf", "page_count": None, "text_status": "pending",
        "modified_at": stamp(), "deleted": False}}])
    _processor(api).drain()
    found = api._json("GET", "/api/search", params={"q": "lost chanc"})
    assert [(p["file_id"], p["page"]) for p in found["pages"]] == [("f1", 1)]
    assert api._json("GET", "/api/search", params={"q": '"); drop table files; --'})["pages"] == []


class FlakyTranscriber:
    """Fails once on the second piece, as a dropped connection would."""

    def __init__(self):
        self.calls = 0
        self.failed = False

    def transcribe(self, path, prompt="", keywords=None):
        self.calls += 1
        if self.calls == 2 and not self.failed:
            self.failed = True
            raise RuntimeError("connection reset")
        return f"Piece {self.calls}.\nA new paragraph."


def test_a_failed_transcription_resumes_where_it_stopped(api, module, tmp_path, monkeypatch):
    from study.processor import jobs

    # Three pieces of three seconds each.
    monkeypatch.setattr(jobs, "_cut_points", lambda path, length, target=0: [3.0, 6.0])
    audio = tmp_path / "live.webm"
    _tone(audio, seconds=9)
    _recording(api, "r1", "recording")
    api._json("PUT", "/api/recordings/r1/chunks/0", data=audio.read_bytes(), headers={"Content-Type": "audio/webm"})
    row = api.pull_all()["recordings"]["r1"]
    api.push([{"table": "recordings", "row": {**row, "status": "uploaded", "modified_at": stamp()}}])

    flaky = FlakyTranscriber()
    processor = Processor(api, transcriber=flaky)
    assert processor.run_once()  # prepare_audio
    assert processor.run_once()  # transcribe, which fails on piece two
    assert flaky.calls == 2
    # The retry waits two minutes; bring it forward for the test.
    api._json("POST", "/api/recordings/r1/retry")
    assert processor.run_once()
    # Piece one was kept, so only pieces two and three were sent again.
    assert flaky.calls == 4
    turns = api.pull_all()["recordings"]["r1"]["turns"]
    text = turns[0]["text"]
    assert text.startswith("Piece 1.\nA new paragraph. Piece 3.")
    # The kept pieces are tidied away afterwards.
    assert api.read_text(jobs._piece_key("r1", 0.0, 3.0)) is None


def test_a_heartbeat_keeps_a_long_job_alive(api, module):
    api.push([{"table": "files", "row": {
        "id": "f1", "sha256": "a" * 64, "r2_key": "files/x.pdf", "mime": "application/pdf", "bytes": 1,
        "original_name": None, "page_count": None, "text_status": "pending", "modified_at": stamp(), "deleted": False}}])
    job = api.claim()
    assert api.heartbeat(job["id"]) is True
    api.complete(job["id"])
    assert api.heartbeat(job["id"]) is False


def test_recording_is_not_processed_while_still_recording(api, module, tmp_path):
    """If prepare_audio is queued early while the recording is still live, it must not process or delete chunks."""
    audio = tmp_path / "live.webm"
    _tone(audio)
    _recording(api, "r1", "recording")
    api._json("PUT", "/api/recordings/r1/chunks/0", data=audio.read_bytes(), headers={"Content-Type": "audio/webm"})
    # A second device prematurely marks the recording uploaded, queueing prepare_audio,
    # while the recording device is still recording.
    row = api.pull_all()["recordings"]["r1"]
    api.push([{"table": "recordings", "row": {**row, "status": "uploaded", "modified_at": stamp()}}])
    api.push([{"table": "recordings", "row": {**row, "status": "recording", "modified_at": stamp()}}])

    _processor(api).drain()

    state = api.pull_all()
    assert state["recordings"]["r1"]["status"] == "recording"
    assert state["recordings"]["r1"]["file_id"] is None
    assert api.recording("r1")["chunks"] == ["recordings/r1/chunk-00000.webm"]


def test_chunks_not_starting_at_zero_are_rejected_without_deleting_chunks(api, module, tmp_path):
    """If chunk 0 was already deleted by an earlier run, later chunks must not be processed or wiped."""
    audio = tmp_path / "live.webm"
    _tone(audio)
    _recording(api, "r1", "recording")
    api._json("PUT", "/api/recordings/r1/chunks/1", data=audio.read_bytes(), headers={"Content-Type": "audio/webm"})
    row = api.pull_all()["recordings"]["r1"]
    api.push([{"table": "recordings", "row": {**row, "status": "uploaded", "modified_at": stamp()}}])

    _processor(api).drain()

    state = api.pull_all()
    assert state["recordings"]["r1"]["file_id"] is None
    assert api.recording("r1")["chunks"] == ["recordings/r1/chunk-00001.webm"]


def test_same_audio_is_not_transcribed_twice(api, module, tmp_path):
    """Re-running prepare_audio on the same audio must not call the transcriber a second time."""
    class CountingTranscriber(FakeTranscriber):
        def __init__(self):
            self.calls = 0

        def transcribe(self, path, prompt="", keywords=None):
            self.calls += 1
            return super().transcribe(path, prompt=prompt, keywords=keywords)

    audio = tmp_path / "live.webm"
    _tone(audio)
    _recording(api, "r1", "recording")
    api._json("PUT", "/api/recordings/r1/chunks/0", data=audio.read_bytes(), headers={"Content-Type": "audio/webm"})
    row = api.pull_all()["recordings"]["r1"]
    api.push([{"table": "recordings", "row": {**row, "status": "uploaded", "modified_at": stamp()}}])

    transcriber = CountingTranscriber()
    processor = Processor(api, transcriber=transcriber)
    assert processor.drain() == 2
    assert transcriber.calls == 1

    # If the recording is marked uploading -> uploaded again for the same audio,
    # it must not be paid for and transcribed a second time.
    row = api.pull_all()["recordings"]["r1"]
    api.push([{"table": "recordings", "row": {**row, "status": "uploading", "modified_at": stamp()}}])
    api.push([{"table": "recordings", "row": {**row, "status": "uploaded", "modified_at": stamp()}}])
    processor.drain()
    assert transcriber.calls == 1

