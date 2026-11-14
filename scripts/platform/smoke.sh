#!/usr/bin/env bash
# Local toolchain smoke test (Agent 03). Starts scripts/platform/smoke-worker.ts
# under `wrangler dev` with the same binding names as wrangler.jsonc, exercises
# D1 / Queue / Workflow / assets routing, then stops it. All state lives in a
# temp dir that is removed at exit; the project .wrangler/ is not touched.
#
#   bash scripts/platform/smoke.sh [port]   (default 8799)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${1:-8799}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/vexo-smoke.XXXXXX")"
PID=""
cleanup() { [ -n "$PID" ] && kill "$PID" 2>/dev/null || true; wait 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

mkdir -p "$TMP/assets" "$TMP/migrations" "$TMP/state"
echo '<!doctype html><title>smoke</title><p>spa-shell</p>' > "$TMP/assets/index.html"
cat > "$TMP/migrations/0001_smoke.sql" <<'SQL'
CREATE TABLE smoke_log (kind TEXT NOT NULL, ref TEXT NOT NULL);
SQL
cat > "$TMP/wrangler.jsonc" <<JSON
{
  "name": "vexo-smoke",
  "main": "$ROOT/scripts/platform/smoke-worker.ts",
  "compatibility_date": "2025-10-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": "$TMP/assets", "binding": "ASSETS",
              "not_found_handling": "single-page-application",
              "run_worker_first": ["/api/*", "/auth/*"] },
  "d1_databases": [{ "binding": "DB", "database_name": "vexo-smoke",
                     "database_id": "00000000-0000-0000-0000-000000000000",
                     "migrations_dir": "$TMP/migrations" }],
  "queues": { "producers": [{ "binding": "SESSION_QUEUE", "queue": "vexo-smoke-q" }],
              "consumers": [{ "queue": "vexo-smoke-q", "max_batch_size": 10, "max_batch_timeout": 1, "max_retries": 5 }] },
  "workflows": [{ "binding": "SESSION_WORKFLOW", "name": "vexo-smoke-wf", "class_name": "SessionWorkflow" }]
}
JSON

cd "$TMP"
echo "== d1 migrations apply --local"
npx --prefix "$ROOT" wrangler d1 migrations apply vexo-smoke --local --config "$TMP/wrangler.jsonc" --persist-to "$TMP/state" 2>&1 | tail -n 8

echo "== wrangler dev :$PORT"
npx --prefix "$ROOT" wrangler dev --config "$TMP/wrangler.jsonc" --port "$PORT" --persist-to "$TMP/state" >"$TMP/dev.log" 2>&1 &
PID=$!
for _ in $(seq 1 60); do curl -fs "http://127.0.0.1:$PORT/api/bindings" >/dev/null 2>&1 && break; sleep 1; done

B="http://127.0.0.1:$PORT"
fail=0
check() { # name, expected-substring, actual
  if printf '%s' "$3" | grep -q -- "$2"; then echo "PASS $1: $3"; else echo "FAIL $1: $3"; fail=1; fi
}
check bindings '"SESSION_WORKFLOW":"function"' "$(curl -s "$B/api/bindings")"
check spa-root 'spa-shell' "$(curl -s "$B/")"
check spa-fallback 'spa-shell' "$(curl -s "$B/sessions/abc")"
check api-not-swallowed '"error":"not found"' "$(curl -s "$B/api/does-not-exist")"
check auth-to-worker '"worker":true' "$(curl -s -X POST "$B/auth/dev-login")"
check queue-send '"sent":"q1"' "$(curl -s "$B/api/queue?id=q1")"
WF="$(curl -s "$B/api/workflow?id=w1")"; check workflow-create '"instance"' "$WF"
IID="$(printf '%s' "$WF" | sed -E 's/.*"instance":"([^"]+)".*/\1/')"
for _ in $(seq 1 20); do
  D1="$(curl -s "$B/api/d1")"
  printf '%s' "$D1" | grep -q '"queue"' && printf '%s' "$D1" | grep -q '"workflow"' && break
  sleep 1
done
check workflow-status '"status":"complete"' "$(curl -s "$B/api/workflow/$IID")"
check queue-consumed '"kind":"queue","ref":"q1"' "$D1"
check workflow-wrote-d1 '"kind":"workflow","ref":"w1"' "$D1"

echo "== wrangler dev warnings"
grep -iE 'warn|error|not supported|experimental' "$TMP/dev.log" | sed 's/\x1b\[[0-9;]*m//g' | sort -u | head -n 20 || true
if [ -n "${SMOKE_SHOW_LOG:-}" ]; then echo "== full dev log"; sed 's/\x1b\[[0-9;]*m//g' "$TMP/dev.log"; fi
if [ "$fail" = 0 ]; then echo "== result: ALL PASS"; else echo "== result: FAILURES"; fi
exit $fail
