#!/usr/bin/env bash
# Starts the processor and TTS server in WSL. Task Scheduler runs this at sign-in.
cd "$(dirname "$0")" || exit 1
. "$HOME/.venvs/study/bin/activate"
set -a; . ./.env; set +a
export PYTHONPATH="..:$PYTHONPATH"

# Local Kokoro speech server for Study Library Listen (runs on port 8765)
if ! pgrep -f "backend.tts.server:app" > /dev/null; then
  if [ -f tts.log ] && [ "$(stat -c %s tts.log)" -gt 5000000 ]; then
    mv -f tts.log tts.log.1
  fi
  python -m uvicorn backend.tts.server:app --host 127.0.0.1 --port 8765 >> tts.log 2>&1 &
fi

# The log is set aside at each start once it passes 5 MB, keeping one old copy.
if [ -f processor.log ] && [ "$(stat -c %s processor.log)" -gt 5000000 ]; then
  mv -f processor.log processor.log.1
fi
exec python -m study.processor >> processor.log 2>&1
