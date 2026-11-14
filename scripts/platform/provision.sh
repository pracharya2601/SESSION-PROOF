#!/usr/bin/env bash
# Provision the real Cloudflare resources for vexo-field-assistant (env.production).
# NOT run automatically. Requires `npx wrangler login` (or CLOUDFLARE_API_TOKEN
# + CLOUDFLARE_ACCOUNT_ID in the environment). Safe to re-run: "already exists"
# errors are reported and skipped. Never prints secret values.
#
#   bash scripts/platform/provision.sh            # dry run: print the commands, create nothing
#   bash scripts/platform/provision.sh --apply    # create the D1 database + queue
#
# It does NOT set secrets, apply migrations, deploy, or touch Access. Those are
# separate, deliberate steps in docs/deploy.md. Run `node scripts/platform/preflight.mjs`
# afterwards to see what is still TODO.
set -euo pipefail
cd "$(dirname "$0")/../.."

DB_NAME="vexo-field-assistant"
QUEUE_NAME="vexo-session-processing"
ENV_NAME="production"
WRANGLER="npx wrangler"
APPLY=0
# A login that sees several accounts makes wrangler prompt (and fail non-interactively).
# Use CLOUDFLARE_ACCOUNT_ID if set, else env.production.account_id from wrangler.jsonc.
if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  CLOUDFLARE_ACCOUNT_ID="$(node -e 'import("./scripts/platform/preflight.mjs").then(m=>{const c=m.parseJsonc(require("fs").readFileSync("wrangler.jsonc","utf8"));process.stdout.write(c.env?.production?.account_id??c.account_id??"")})' 2>/dev/null || true)"
fi
if [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then export CLOUDFLARE_ACCOUNT_ID; echo "== account: $CLOUDFLARE_ACCOUNT_ID"; fi
case "${1:-}" in
  --apply) APPLY=1 ;;
  ""|--dry-run) APPLY=0 ;;
  *) echo "usage: $0 [--apply]" >&2; exit 2 ;;
esac

run() {
  echo "+ $*"
  if [ "$APPLY" = 1 ]; then "$@" || echo "  (command failed or resource already exists; continuing)"; fi
}

echo "== 0. Auth check (read-only)"
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
echo "   No create step: 'vexo-session-workflow' is registered by 'wrangler deploy --env $ENV_NAME'."

echo
echo "== Next steps (run by hand; see docs/deploy.md)"
echo "  a. Paste the database_id into wrangler.jsonc -> env.production.d1_databases[0].database_id"
echo "  b. Set env.production APP_ORIGIN / PUBLIC_APP_ORIGIN (https://<host>) / PUBLIC_STREAM_ORIGIN (wss://<host>)"
echo "     and choose ingress: a custom-domain route, or workers_dev: true."
echo "  c. Schema:   npm run db:migrate:remote"
echo "  d. Secrets (prompted, never echoed; note --env $ENV_NAME):"
for S in SESSION_SECRET TOKEN_ENCRYPTION_KEY DEEPGRAM_API_KEY; do
  echo "       $WRANGLER secret put $S --env $ENV_NAME"
done
echo "       $WRANGLER secret put AI_API_KEY --env $ENV_NAME      # only if EXTRACTION_MODE=live"
echo "     Generate: openssl rand -base64 48 | tr -d '\\n' | $WRANGLER secret put SESSION_SECRET --env $ENV_NAME"
echo "               openssl rand -base64 32 | tr -d '\\n' | $WRANGLER secret put TOKEN_ENCRYPTION_KEY --env $ENV_NAME"
echo "  e. node scripts/platform/preflight.mjs --secrets --full"
echo
echo "================================================================"
echo "env.production.d1_databases[0]:"
echo "  \"database_id\": \"${DB_ID:-<not found; run: npx wrangler d1 info $DB_NAME>}\""
echo "================================================================"
[ "$APPLY" = 1 ] || echo "(dry run: nothing was created; re-run with --apply)"
