"""The high-quality speech pack (study/speech_pack.py) and how the desktop app
starts its speech server from it (study/desktop.py)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from study import desktop, speech_pack


def test_links_are_recognised_and_routed(tmp_path):
    notes = []
    assert speech_pack.route(["--connect", "studylibrary://update?x=1"], tmp_path, notes.append) is None
    assert speech_pack.route(["studylibrary://speech-pack?action=wave"], tmp_path, lambda *a, **k: notes.append(a)) == 2
    assert speech_pack.route(["--connect", "studylibrary://speech-pack?action=remove"], tmp_path, lambda *a, **k: None) == 0


def test_install_runs_each_step_and_marks_the_pack_installed_last(tmp_path, monkeypatch):
    monkeypatch.setenv("UV_BINARY", "uv.exe")
    ran = []

    def run(command, env):
        ran.append(command)
        assert not (speech_pack.folder(tmp_path) / "installed.json").exists(), "the marker is written last"
        assert env["HF_HOME"].endswith("hf") and env["TTS_ENGINE"] == "torch"
        python = speech_pack.python_of(tmp_path)
        python.parent.mkdir(parents=True, exist_ok=True)
        python.write_text("")

    notes = []
    speech_pack.install(tmp_path, lambda text, **_: notes.append(text), run=run, card="NVIDIA GeForce RTX 2060")
    assert [c[1] for c in ran[:3]] == ["venv", "pip", "pip"]
    assert "--index-url" in ran[1] and speech_pack.TORCH_INDEX in ran[1]
    assert any("en_core_web_sm" in part for part in ran[2])
    info = speech_pack.installed(tmp_path)
    assert info["card"] == "NVIDIA GeForce RTX 2060"
    src = speech_pack.folder(tmp_path) / "src"
    assert (src / "backend" / "tts" / "server.py").is_file() and (src / "shared" / "pinyin-lists.json").is_file()
    assert not any(p.name.startswith("test_") for p in (src / "backend" / "tts").iterdir())
    assert len(notes) == len(speech_pack.install_steps(tmp_path, "uv.exe"))


def test_a_failed_install_leaves_no_pack(tmp_path, monkeypatch):
    monkeypatch.setenv("UV_BINARY", "uv.exe")

    def run(command, env):
        raise RuntimeError("no network")

    with pytest.raises(RuntimeError):
        speech_pack.install(tmp_path, lambda *a, **k: None, run=run, card="RTX")
    assert speech_pack.installed(tmp_path) is None


def test_no_nvidia_card_means_no_install(tmp_path, monkeypatch):
    monkeypatch.setattr(speech_pack, "nvidia_card", lambda: None)
    with pytest.raises(RuntimeError, match="NVIDIA"):
        speech_pack.install(tmp_path, lambda *a, **k: None, run=lambda c, e: None)


def _install_marker(home: Path) -> None:
    python = speech_pack.python_of(home)
    python.parent.mkdir(parents=True, exist_ok=True)
    python.write_text("")
    (speech_pack.folder(home) / "installed.json").write_text(json.dumps({"card": "RTX"}))


def test_the_supervisor_starts_speech_from_the_pack_and_everything_else_as_before(tmp_path, monkeypatch):
    monkeypatch.setattr(desktop, "_pack_failed", False)
    command, cwd, env = desktop._command(tmp_path, {"A": "1"}, "tts")
    assert command[0] != str(speech_pack.python_of(tmp_path)), "no pack: the install's own speech server"
    _install_marker(tmp_path)
    command, cwd, env = desktop._command(tmp_path, {"A": "1", "PYTHONPATH": "x"}, "tts")
    assert command[0] == str(speech_pack.python_of(tmp_path))
    assert cwd == speech_pack.folder(tmp_path) / "src" / "backend"
    assert env["TTS_ENGINE"] == "torch" and env["SPEECH_PACK"] == "1" and "PYTHONPATH" not in env and env["A"] == "1"
    command, _, _ = desktop._command(tmp_path, {}, "prepare")
    assert command[-2:] == ["-m", "tts.prepare"]
    monkeypatch.setattr(desktop, "_pack_failed", True)
    command, _, _ = desktop._command(tmp_path, {}, "tts")
    assert command[0] != str(speech_pack.python_of(tmp_path)), "after a failed start, the install's own"


def test_installing_the_pack_changes_the_settings_stamp(tmp_path):
    before = desktop.settings_stamp(tmp_path)
    _install_marker(tmp_path)
    assert desktop.settings_stamp(tmp_path) != before


def test_the_preparation_worker_is_a_supervised_child_with_its_own_stop_file(tmp_path):
    assert "prepare" in desktop.COMMANDS and "tts.prepare" in desktop.CHILD_MODULES
    env = desktop._child_environment(tmp_path) if hasattr(desktop, "_child_environment") else {}
    assert env.get("PREPARE_STOP_FILE", "").endswith("prepare.stop")
