#!/usr/bin/env bash
# Browser tests in one command. From app/:
#   npm run e2e                      every test, in the order they depend on
#   npm run e2e -- jobs ux           just these (test_jobs.py, test_ux.py)
#   npm run e2e -- audit_layout      any script in tests/e2e by its name
# Copies the project to ~/study-library in WSL, builds it there, starts a local
# Worker, runs the tests, stops the Worker and copies screenshots back. Prints
# PASS or FAIL for each test, with the end of the log for a failure, and exits
# non-zero if any failed. It waits for everything to finish: nothing to poll.
set -u
src="$(cd "$(dirname "$0")/../.." && pwd)"
dest="$HOME/study-library"
py="$HOME/.venvs/study/bin/python"
port=8790

rsync -a --delete --exclude node_modules --exclude .wrangler --exclude .git --exclude dist --exclude .venv \
  --exclude app/tests/e2e/shots --exclude app/tests/e2e/files "$src/" "$dest/"
cd "$dest/app" || exit 1

echo "Building..."
npm install --silent >/tmp/e2e-install.log 2>&1 || { tail -20 /tmp/e2e-install.log; exit 1; }
npm run build >/tmp/e2e-build.log 2>&1 || { tail -30 /tmp/e2e-build.log; exit 1; }
[ -f .dev.vars ] || cp .dev.vars.example .dev.vars
echo y | npx wrangler d1 migrations apply DB --local >/tmp/e2e-migrate.log 2>&1 || { tail -20 /tmp/e2e-migrate.log; exit 1; }
[ -d tests/e2e/files ] || "$py" tests/e2e/make_pdfs.py >/dev/null

# The Worker runs in its own process group, so stopping it stops everything it started.
setsid npx wrangler dev --port "$port" --ip 127.0.0.1 >/tmp/e2e-worker.log 2>&1 &
worker=$!
trap 'kill -- -"$worker" 2>/dev/null' EXIT
for _ in $(seq 1 90); do curl -s -m 2 "http://127.0.0.1:$port/api/ping" >/dev/null && break; sleep 1; done
curl -s -m 2 "http://127.0.0.1:$port/api/ping" >/dev/null || { echo "The local Worker did not start:"; tail -20 /tmp/e2e-worker.log; exit 1; }

order="library sessions features usability themes editing dragging transcripts citations textview reading_notes recording_bar reading_place paragraphs notes_access slides_and_modules jobs ux answers mobile photos consistency dissertation back"
names="${*:-$order}"
failed=0
for name in $names; do
  name="${name%.py}"
  file="tests/e2e/$name.py"
  [ -f "$file" ] || file="tests/e2e/test_${name#test_}.py"
  [ -f "$file" ] || { echo "FAIL $name (no such test)"; failed=1; continue; }
  log="/tmp/e2e-$(basename "$file" .py).log"
  start=$(date +%s)
  if timeout 900 "$py" "$file" "http://127.0.0.1:$port" >"$log" 2>&1; then
    echo "PASS $name ($(( $(date +%s) - start ))s)"
  else
    echo "FAIL $name ($(( $(date +%s) - start ))s), log in $log:"
    tail -15 "$log"
    failed=1
  fi
done

mkdir -p "$src/app/tests/e2e/shots"
cp -r tests/e2e/shots/. "$src/app/tests/e2e/shots/" 2>/dev/null
exit $failed
