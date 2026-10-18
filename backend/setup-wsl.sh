#!/usr/bin/env bash
# One-time setup for running the processor in WSL without Docker.
# Run it from this folder with: bash setup-wsl.sh
set -euo pipefail

sudo apt update
sudo apt install -y python3-full python3-venv tesseract-ocr tesseract-ocr-eng tesseract-ocr-fra tesseract-ocr-deu unpaper ghostscript pngquant \
  libreoffice-impress libreoffice-writer ffmpeg

# The environment lives on the Linux disk. Building it on the Windows drive fails.
python3 -m venv "$HOME/.venvs/study"
. "$HOME/.venvs/study/bin/activate"
pip install -r requirements.txt "ocrmypdf==16.*"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env. Fill it in with: nano .env"
fi
# Windows editors add hidden line endings that break the keys.
sed -i 's/\r$//' .env
echo "Done. Start the processor with: bash run-processor.sh"
