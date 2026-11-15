#!/usr/bin/env bash
set -euo pipefail
src="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[ -f "$src/app/package.json" ] && [ -d "$src/backend" ] || { echo "test-backend.sh: cannot locate repository root at $src" >&2; exit 1; }
rsync -a --delete --exclude node_modules --exclude .wrangler --exclude .git --exclude dist --exclude .venv --exclude .oracle \
  --exclude backend/audit --exclude app/tests/e2e/shots --exclude app/tests/e2e/files "$src/" ~/study-library/
cd ~/study-library/app
npm install --silent
cd ../backend
. ~/.venvs/study/bin/activate
export PYTHONPATH="..:${PYTHONPATH:-}"
exec python -m pytest -q "$@"
