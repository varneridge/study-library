"""Transcription.

Transcription uses OpenAI's speech-to-text API by default, or faster-whisper
on this machine. The fake backend exists for tests.
"""

from __future__ import annotations

import os
from typing import Protocol

import requests


class Transcriber(Protocol):
    def transcribe(self, path: str, prompt: str = "", keywords: list[str] | None = None) -> str:
        """Return the text spoken in the file."""


class OpenAITranscriber:
    """OpenAI's recommended model for recorded speech, gpt-transcribe. It is
    the most accurate OpenAI offers, and takes a description of the
    recording and a list of words to expect."""

    URL = "https://api.openai.com/v1/audio/transcriptions"

    def __init__(self, api_key: str, model: str = "gpt-transcribe"):
        self.api_key = api_key
        self.model = model

    def transcribe(self, path: str, prompt: str = "", keywords: list[str] | None = None) -> str:
        data: list[tuple[str, str]] = [("model", self.model)]
        if self.model == "gpt-transcribe":
            data.append(("languages[]", "en"))
            for word in keywords or []:
                data.append(("keywords[]", word))
        else:
            data.append(("language", "en"))
        if prompt:
            data.append(("prompt", prompt))
        with open(path, "rb") as handle:
            response = requests.post(
                self.URL,
                headers={"Authorization": f"Bearer {self.api_key}"},
                files={"file": (os.path.basename(path), handle, "audio/mpeg")},
                data=data,
                timeout=900,
            )
        if response.status_code >= 400:
            raise RuntimeError(f"transcription returned {response.status_code}: {response.text[:300]}")
        return (response.json().get("text") or "").strip()


class LocalTranscriber:
    def __init__(self, model: str = "small.en"):
        from faster_whisper import WhisperModel

        self.model = WhisperModel(model, compute_type="int8")

    def transcribe(self, path: str, prompt: str = "", keywords: list[str] | None = None) -> str:
        segments, _info = self.model.transcribe(path, vad_filter=True, initial_prompt=prompt or None)
        return " ".join(s.text.strip() for s in segments).strip()


class FakeTranscriber:
    def transcribe(self, path: str, prompt: str = "", keywords: list[str] | None = None) -> str:
        return "Today we look at the Concordat of 1801. Napoleon used the Church to steady the regime."


def transcriber_from_env() -> Transcriber:
    backend = os.environ.get("TRANSCRIBE_BACKEND", "openai")
    if backend == "fake":
        return FakeTranscriber()
    if backend == "local":
        return LocalTranscriber(os.environ.get("LOCAL_WHISPER_MODEL", "small.en"))
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        raise RuntimeError("Set OPENAI_API_KEY, or TRANSCRIBE_BACKEND=local to transcribe on this machine.")
    return OpenAITranscriber(key, os.environ.get("TRANSCRIBE_MODEL", "gpt-transcribe"))
