#!/bin/bash
# Runs one spike script with a fresh OIDC token, the way docs/spikes/xr-2026-10-31/run.sh gets one. Prints no values.
#   docs/spikes/musecode-2026-10-31/creds.sh <script.ts> [args...]     (from the worktree root)
# The pull goes only to a mode 600 temp file in the session scratchpad, only the OIDC token is read from it, and it is deleted at
# once. .env.local is never written. The Meta key and snapshot id come from --env-file, and the SDK ignores VERCEL_TOKEN.
set -euo pipefail
LINKED=/Users/ethancastro/muse-muse-builds
SCRATCH=/private/tmp/claude-501/-Users-ethancastro/fe5f77e3-8ea1-43b7-b033-a8419e6a5382/scratchpad
umask 077
F=$(mktemp "$SCRATCH/pull.XXXXXXXX")
chmod 600 "$F"
trap 'rm -f "$F"' EXIT
if ! (cd "$LINKED" && vercel env pull --environment=development --yes "$F" >/dev/null 2>&1); then
  echo "vercel env pull failed" >&2
  exit 3
fi
TOKEN=$(grep '^VERCEL_OIDC_TOKEN=' "$F" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')
rm -f "$F"
if [ -z "$TOKEN" ]; then
  echo "the pull had no OIDC token" >&2
  exit 3
fi
export VERCEL_OIDC_TOKEN="$TOKEN"
unset TOKEN
script=$1
shift
exec npx tsx --env-file="$LINKED/.env.local" "$script" "$@"
