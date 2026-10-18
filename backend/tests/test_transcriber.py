"""The request sent to OpenAI's gpt-transcribe, and where long recordings split."""
import subprocess

from study.processor import jobs, speech


class Response:
    status_code = 200

    def json(self):
        return {"text": " Today we look at the Concordat. ", "languages": [{"code": "en"}]}


def test_gpt_transcribe_request(monkeypatch, tmp_path):
    sent = {}

    def post(url, headers, files, data, timeout):
        sent.update(url=url, data=data, mime=files["file"][2])
        return Response()

    monkeypatch.setattr(speech.requests, "post", post)
    audio = tmp_path / "piece.mp3"
    audio.write_bytes(b"x")
    text = speech.OpenAITranscriber("key").transcribe(str(audio), "A lecture for HY319.", ["Westad", "Concordat"])
    assert text == "Today we look at the Concordat."
    assert ("model", "gpt-transcribe") in sent["data"]
    assert ("languages[]", "en") in sent["data"] and not any(k == "language" for k, _ in sent["data"])
    assert ("keywords[]", "Westad") in sent["data"] and ("prompt", "A lecture for HY319.") in sent["data"]
    assert sent["mime"] == "audio/mpeg"


def test_long_recordings_split_in_a_pause(tmp_path):
    # Seventy seconds of tone with a second of silence at 40 seconds.
    path = tmp_path / "talk.ogg"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=300:duration=40",
                    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=1", "-f", "lavfi", "-i", "sine=frequency=300:duration=29",
                    "-filter_complex", "[0][1][2]concat=n=3:v=0:a=1", "-c:a", "libopus", str(path)], check=True)
    cuts = jobs._cut_points(str(path), 70.0, target=30)
    assert len(cuts) == 1 and 40 <= cuts[0] <= 41.5, cuts
