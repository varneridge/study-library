import sys
from pathlib import Path

PACKAGING = Path(__file__).resolve().parents[2] / "packaging" / "windows"
sys.path.insert(0, str(PACKAGING))
