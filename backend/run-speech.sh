#!/usr/bin/env bash
# Starts only the Kokoro speech server and the Listen audio preparation worker,
# for a machine that prepares audio but does not run the processor, such as the
# desktop with the RTX 2060. It needs backend/.env with STUDY_URL, PROCESSOR_KEY,
# CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET, copied from the laptop.
cd "$(dirname "$0")" || exit 1
. "$HOME/.venvs/study/bin/activate"
set -a; . ./.env; set +a
export PYTHONPATH="..:$PYTHONPATH"

for name in tts prepare; do
  if [ -f "$name.log" ] && [ "$(stat -c %s "$name.log")" -gt 5000000 ]; then
    mv -f "$name.log" "$name.log.1"
  fi
done

if ! pgrep -f "backend.tts.server:app" > /dev/null; then
  python -m uvicorn backend.tts.server:app --host 127.0.0.1 --port 8765 >> tts.log 2>&1 &
fi
exec python -m backend.tts.prepare >> prepare.log 2>&1
