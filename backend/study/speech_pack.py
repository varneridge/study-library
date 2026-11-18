"""The high-quality speech pack, for Windows computers with an NVIDIA card.

The installer's speech server runs Kokoro with kokoro-onnx on the processor.
Kokoro was trained on sounds from misaki, which reads ordinary English words
from a pronouncing dictionary, and hexgrad's PyTorch pipeline uses it, gives
real word timings, and runs many times faster on an NVIDIA card. PyTorch with
CUDA is about 3 GB, too large for the installer, so this pack installs it on
request, into its own Python under the Study Library home:

  speech-pack\\venv\\           Python 3.12 with torch (CUDA), kokoro, misaki
  speech-pack\\src\\backend\\tts  the speech server's source, as in the repository
  speech-pack\\src\\shared\\      the pronunciation word lists
  speech-pack\\hf\\             Kokoro's weights, from Hugging Face
  speech-pack\\installed.json  written last, so a half-finished install is ignored

Settings offers it when the speech server reports an NVIDIA card, through the
link studylibrary://speech-pack?action=install (or action=remove). The
supervisor (desktop.py) then starts the speech server from the pack, and falls
back to the installer's own speech server if the pack's will not start.

uv creates the Python and installs the packages: the packaged build carries it
as a bundled tool (UV_BINARY, packaging/windows/manifest.json), and a source
install uses the uv on PATH.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable, Optional, Sequence
from urllib.parse import parse_qs, urlsplit

log = logging.getLogger("speech_pack")

Notify = Callable[..., None]
Run = Callable[[Sequence[str], dict], None]

SCHEME_HOST = "speech-pack"
PYTHON = "3.12"
TORCH_INDEX = "https://download.pytorch.org/whl/cu126"
# misaki loads spaCy's small English model and would otherwise try to install
# it with pip, which a uv environment does not have. It must match spaCy 3.8.
SPACY_MODEL = (
    "en_core_web_sm @ https://github.com/explosion/spacy-models/releases/download/"
    "en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl"
)
PACKAGES = ["kokoro>=0.9.4", "misaki[en]>=0.9.4", "fastapi>=0.115", "uvicorn[standard]>=0.30", "numpy>=1.26", "requests>=2", SPACY_MODEL]
CREATE_NO_WINDOW = 0x08000000


def folder(home: Path) -> Path:
    return Path(home) / "speech-pack"


def python_of(home: Path) -> Path:
    venv = folder(home) / "venv"
    return venv / "Scripts" / "python.exe" if sys.platform == "win32" else venv / "bin" / "python"


def installed(home: Path) -> Optional[dict]:
    """What installed.json says, or None when the pack is not (fully) installed."""
    marker = folder(home) / "installed.json"
    try:
        info = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return info if python_of(home).is_file() else None


def nvidia_card() -> Optional[str]:
    """The name of the first NVIDIA card, from nvidia-smi, or None."""
    smi = shutil.which("nvidia-smi") or str(Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "nvidia-smi.exe")
    if not Path(smi).is_file() and not shutil.which("nvidia-smi"):
        return None
    try:
        out = subprocess.run([smi, "--query-gpu=name", "--format=csv,noheader"], capture_output=True, text=True,
                             timeout=10, creationflags=CREATE_NO_WINDOW if sys.platform == "win32" else 0)
    except (OSError, subprocess.SubprocessError):
        return None
    name = out.stdout.strip().splitlines()[0].strip() if out.returncode == 0 and out.stdout.strip() else ""
    return name or None


def uv_binary() -> Optional[str]:
    return os.environ.get("UV_BINARY") or shutil.which("uv")


def speech_source(home: Path) -> tuple[Path, Path]:
    """Where to copy the speech server's source and word lists from: the packaged
    build's bundled copy, else the source checkout under the home folder, else
    this file's own repository."""
    bundle = getattr(sys, "_MEIPASS", None)
    if bundle and (Path(bundle) / "speech-src" / "backend" / "tts").is_dir():
        root = Path(bundle) / "speech-src"
        return root / "backend" / "tts", root / "shared"
    for repo in (Path(home) / "repo", Path(__file__).resolve().parents[2]):
        if (repo / "backend" / "tts" / "server.py").is_file():
            return repo / "backend" / "tts", repo / "shared"
    raise FileNotFoundError("the speech server's source is not in this install")


def pack_environment(home: Path, base: dict) -> dict:
    """The environment the pack's speech server runs in."""
    env = dict(base)
    env["TTS_ENGINE"] = "torch"
    env["HF_HOME"] = str(folder(home) / "hf")
    env["SPEECH_PACK"] = "1"
    env["STUDY_SHARED_DIR"] = str(folder(home) / "src" / "shared")
    env.pop("PYTHONHOME", None)
    env.pop("PYTHONPATH", None)
    return env


def install_steps(home: Path, uv: str) -> list[tuple[str, list[str]]]:
    """Each step's description and command, in order, for install() and its tests."""
    pack = folder(home)
    python = str(python_of(home))
    return [
        ("Creating the speech pack's Python", [uv, "venv", "--python", PYTHON, str(pack / "venv")]),
        ("Downloading PyTorch for your graphics card (about 3 GB)",
         [uv, "pip", "install", "--python", python, "torch", "--index-url", TORCH_INDEX]),
        ("Installing Kokoro and misaki", [uv, "pip", "install", "--python", python, *PACKAGES]),
        ("Checking the graphics card", [python, "-c", "import torch, sys; sys.exit(0 if torch.cuda.is_available() else 3)"]),
        ("Downloading Kokoro's voice model",
         [python, "-c", "from kokoro import KModel; KModel(repo_id='hexgrad/Kokoro-82M')"]),
    ]


def _run(command: Sequence[str], env: dict) -> None:
    subprocess.run(list(command), env=env, check=True, capture_output=True, text=True,
                   creationflags=CREATE_NO_WINDOW if sys.platform == "win32" else 0)


def install(home: Path, notify: Notify, run: Run = _run, card: Optional[str] = None) -> None:
    """Installs the pack, telling the person how it is going. Raises on failure,
    leaving no installed.json, so a half-finished pack is never used."""
    card = card or nvidia_card()
    if not card:
        raise RuntimeError("This computer has no NVIDIA graphics card, so the high-quality speech pack would not help.")
    uv = uv_binary()
    if not uv:
        raise RuntimeError("uv, which installs the speech pack, is missing from this install.")
    pack = folder(home)
    (pack / "installed.json").unlink(missing_ok=True)
    pack.mkdir(parents=True, exist_ok=True)
    tts, shared = speech_source(home)
    target = pack / "src"
    shutil.rmtree(target, ignore_errors=True)
    shutil.copytree(tts, target / "backend" / "tts", ignore=shutil.ignore_patterns("test_*", "__pycache__", "models"))
    (target / "shared").mkdir(parents=True, exist_ok=True)
    shutil.copy2(shared / "pinyin-lists.json", target / "shared" / "pinyin-lists.json")
    env = pack_environment(home, dict(os.environ))
    env["UV_CACHE_DIR"] = str(pack / "uv-cache")
    for description, command in install_steps(home, uv):
        notify(f"High-quality speech: {description.lower()}.")
        log.info("speech pack: %s", description)
        run(command, env)
    shutil.rmtree(pack / "uv-cache", ignore_errors=True)
    info = {"card": card, "torchIndex": TORCH_INDEX, "installedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    (pack / "installed.json").write_text(json.dumps(info), encoding="utf-8")


def remove(home: Path) -> None:
    (folder(home) / "installed.json").unlink(missing_ok=True)
    shutil.rmtree(folder(home), ignore_errors=True)


def is_pack_link(link: str) -> bool:
    parts = urlsplit(link)
    return parts.scheme == "studylibrary" and parts.netloc == SCHEME_HOST


def run_link(link: str, home: Path, notify: Notify) -> int:
    action = (parse_qs(urlsplit(link).query).get("action") or [""])[0]
    try:
        if action == "install":
            install(home, notify)
            notify("High-quality speech is installed. Listen starts using it within a few seconds.")
        elif action == "remove":
            remove(home)
            notify("High-quality speech is removed. Listen uses the standard voice again.")
        else:
            notify("That speech pack link is not one Study Library knows.", error=True)
            return 2
    except subprocess.CalledProcessError as error:
        log.error("speech pack step failed: %s", (error.stderr or "")[-2000:])
        notify("High-quality speech could not be installed. Listen keeps using the standard voice.", error=True)
        return 1
    except (OSError, RuntimeError) as error:
        log.error("speech pack failed: %s", error)
        notify(f"High-quality speech could not be installed. {error}", error=True)
        return 1
    return 0


def route(argv: Optional[Sequence[str]], home: Path, notify: Notify) -> Optional[int]:
    """Called by desktop.main beside update.route: an exit code for a speech pack
    link, which Windows passes as --connect LINK or LINK, and None otherwise."""
    args = list(sys.argv[1:] if argv is None else argv)
    link = args[1] if len(args) == 2 and args[0] == "--connect" else (args[0] if len(args) == 1 else None)
    if link and is_pack_link(link):
        return run_link(link, home, notify)
    return None
