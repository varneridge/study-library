# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for Study Library. Run through build.ps1, which sets
# SL_ENV_TEMPLATE to the sanitised template and stages vendor tools afterwards.
#
# Onedir rather than onefile: onefile unpacks the whole runtime into %TEMP% on
# every launch, which is slow for onnxruntime-sized dependencies and is the
# pattern antivirus heuristics flag most often.
import importlib.util
import os
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_all

HERE = Path(SPECPATH).resolve()
ROOT = HERE.parents[1]
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(HERE))

TEMPLATE = Path(os.environ.get("SL_ENV_TEMPLATE", HERE / "env.template"))
# Packages whose data files or dynamic imports PyInstaller cannot see by static
# analysis. Missing ones are skipped, so the list can name optional extras.
PACKAGES_TO_COLLECT = [
    "study",
    "kokoro_onnx",
    "espeakng_loader",
    "language_tags",
    "phonemizer",
    "onnxruntime",
    "uvicorn",
    "numpy",
    "numpy._core",
]

# Modules that study.desktop starts by name in a child process, which static
# analysis cannot follow: uvicorn receives the speech server as the string
# "tts.server:app". These are required, so the build stops here rather than
# producing an executable whose speech server dies on its first import. They go
# in as hidden imports and not through collect_all, because collect_all would
# also copy any Kokoro model a developer keeps in backend/tts/models, whereas
# the packaged build fetches its models into the per-user home through slassets.
# backend/tests/test_windows_desktop.py checks that every study.desktop.CHILD_MODULES
# entry is covered either here or by PACKAGES_TO_COLLECT.
REQUIRED_MODULES = ["tts.server"]

datas = [(str(HERE / "manifest.json"), "."), (str(TEMPLATE), ".")]
binaries = []
hiddenimports = ["slruntime", "slassets", "numpy._core._exceptions"]
for module in REQUIRED_MODULES:
    try:
        found = importlib.util.find_spec(module) is not None
    except ImportError:
        found = False
    if not found:
        raise SystemExit(f"[studylibrary.spec] {module} cannot be imported from {BACKEND}, so the build would be broken")
    hiddenimports.append(module)
for package in PACKAGES_TO_COLLECT:
    if importlib.util.find_spec(package) is None:
        print(f"[studylibrary.spec] {package} not installed, skipping")
        continue
    d, b, h = collect_all(package)
    datas += d
    binaries += b
    hiddenimports += h

frontend = ROOT / "frontend" / "dist"
if frontend.is_dir():
    datas.append((str(frontend), "frontend/dist"))

a = Analysis(
    [str(HERE / "launcher.py")],
    pathex=[str(BACKEND), str(HERE)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["pytest"],
    noarchive=False,
)

# Defence in depth: never ship a developer .env that happens to sit inside a package.
a.datas = [entry for entry in a.datas if not Path(entry[0]).name.lower().startswith(".env")]

pyz = PYZ(a.pure)
icon = HERE / "studylibrary.ico"
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="StudyLibrary",
    debug=False,
    strip=False,
    upx=False,
    console=False,
    icon=str(icon) if icon.is_file() else None,
)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="StudyLibrary")
