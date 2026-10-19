#!/usr/bin/env bash
# Starts the processor in WSL. Task Scheduler runs this at sign-in.
cd "$(dirname "$0")" || exit 1
. "$HOME/.venvs/study/bin/activate"
set -a; . ./.env; set +a
# The log is set aside at each start once it passes 5 MB, keeping one old copy.
if [ -f processor.log ] && [ "$(stat -c %s processor.log)" -gt 5000000 ]; then
  mv -f processor.log processor.log.1
fi
exec python -m study.processor >> processor.log 2>&1
