#!/usr/bin/env bash
# Provision the real Cloudflare resources for vexo-field-assistant (Agent 03).
# NOT run automatically. Requires `npx wrangler login` (or CLOUDFLARE_API_TOKEN
# + CLOUDFLARE_ACCOUNT_ID in the environment). Safe to re-run: "already exists"
# errors are reported and skipped. Never prints secret values.
#
#   bash scripts/platform/provision.sh            # dry run: print the commands
#   bash scripts/platform/provision.sh --apply    # actually create resources
set -euo pipefail
cd "$(dirname "$0")/../.."

DB_NAME="vexo-field-assistant"
QUEUE_NAME="vexo-session-processing"
WRANGLER="npx wrangler"
APPLY=0; [ "${1:-}" = "--apply" ] && APPLY=1

run() {
  echo "+ $*"
  if [ "$APPLY" = 1 ]; then "$@" || echo "  (command failed or resource already exists; continuing)"; fi
}

echo "== 0. Auth check"
run $WRANGLER whoami

echo "== 1. D1 database"
if [ "$APPLY" = 1 ]; then
  OUT="$($WRANGLER d1 create "$DB_NAME" 2>&1 || true)"
  echo "$OUT" | grep -v -i 'token' || true
  DB_ID="$(echo "$OUT" | grep -Eo '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -n1 || true)"
  if [ -z "$DB_ID" ]; then
    DB_ID="$($WRANGLER d1 info "$DB_NAME" --json 2>/dev/null | grep -Eo '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -n1 || true)"
  fi
else
  echo "+ $WRANGLER d1 create $DB_NAME"
  DB_ID="<uuid printed by d1 create>"
fi

echo "== 2. Queue (producer + consumer share it)"
run $WRANGLER queues create "$QUEUE_NAME"

echo "== 3. Workflow"
echo "   No create step: the 'vexo-session-workflow' Workflow is registered by 'wrangler deploy' from wrangler.jsonc."

echo "== 4. Remote schema"
echo "   After pasting the database_id below:  npm run db:migrate:remote"

echo "== 5. Secrets (you will be prompted; values are never echoed)"
for S in SESSION_SECRET TOKEN_ENCRYPTION_KEY; do
  echo "+ $WRANGLER secret put $S"
done
echo "+ $WRANGLER secret put AI_API_KEY      # only if EXTRACTION_MODE=live"
echo "   Generate values locally, e.g.: openssl rand -base64 32 | $WRANGLER secret put TOKEN_ENCRYPTION_KEY"

echo
echo "================================================================"
echo "Paste into wrangler.jsonc -> d1_databases[0].database_id:"
echo "  \"database_id\": \"${DB_ID:-<not found; run: npx wrangler d1 info $DB_NAME>}\""
echo "Also set vars.APP_ORIGIN and vars.RUNTIME_MODE=\"deployed\" for the deployed environment."
echo "================================================================"
[ "$APPLY" = 1 ] || echo "(dry run: nothing was created; re-run with --apply)"
