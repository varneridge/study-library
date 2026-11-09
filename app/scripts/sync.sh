# filename: review/app/scripts/sync.sh
#!/usr/bin/env bash
# Runs a local sync in WSL: bash scripts/sync.sh jobs|study [options].
# A script file rather than an inline bash -c string, so that options given
# as `npm run sync:jobs -- --dry-run` reach python instead of becoming $0.
set -euo pipefail
command="${1:-}"
case "$command" in
  jobs|study) shift ;;
  *) echo "usage: scripts/sync.sh jobs|study [options]" >&2; exit 2 ;;
esac
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
[ -n "$REPO_ROOT" ] && [ -d "$REPO_ROOT/backend/sync" ] || { echo "sync.sh: cannot locate repository root" >&2; exit 1; }
# --delete keeps the WSL mirror identical to the repository, so a file removed
# here (such as a retired module) cannot linger and still be imported there.
rsync -a --delete --exclude node_modules --exclude .wrangler --exclude .git --exclude dist --exclude .venv \
  --exclude backend/audit --exclude app/tests/e2e/shots --exclude app/tests/e2e/files "$REPO_ROOT/" ~/study-library/
cd ~/study-library/backend
. ~/.venvs/study/bin/activate
exec python -m "sync.$command" "$@"
