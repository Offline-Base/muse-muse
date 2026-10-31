#!/bin/bash
# Runs one spike script with a fresh OIDC token, pulled the way docs/spikes/xr-2026-10-31/run.sh pulls one. Prints no values.
#   docs/spikes/3d-2026-10-31/creds.sh <script.ts> [args...]     (from the worktree root)
# The pull goes only to a mode 600 temp file in the session scratchpad. Only VERCEL_OIDC_TOKEN, MODEL_API_KEY and
# BUILDER_SNAPSHOT_ID are read from it, and it is deleted at once. No .env.local is read or written.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
LINKED=/Users/ethancastro/muse-muse-builds # The checkout linked to the Vercel project (.vercel/project.json).
SCRATCH=/private/tmp/claude-501/-Users-ethancastro/fe5f77e3-8ea1-43b7-b033-a8419e6a5382/scratchpad
umask 077
mkdir -p "$SCRATCH"
F=$(mktemp "$SCRATCH/pull.XXXXXXXX")
chmod 600 "$F"
trap 'rm -f "$F"' EXIT
if ! (cd "$LINKED" && vercel env pull --environment=development --yes "$F" >/dev/null 2>&1); then
  echo "vercel env pull failed" >&2
  exit 3
fi
val() { grep "^$1=" "$F" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }
TOKEN=$(val VERCEL_OIDC_TOKEN)
KEY=$(val MODEL_API_KEY)
SNAP=$(val BUILDER_SNAPSHOT_ID)
rm -f "$F"
for n in TOKEN KEY SNAP; do
  if [ -z "${!n}" ]; then
    echo "the pull had no value for $n" >&2
    exit 3
  fi
done
script=$1
shift
cd "$ROOT"
exec env -i PATH="$PATH" HOME="$HOME" SPIKE_VCPUS="${SPIKE_VCPUS:-}" SPIKE_TIMEOUT_MIN="${SPIKE_TIMEOUT_MIN:-}" PROXY_BUDGET_USD="${PROXY_BUDGET_USD:-0}" \
  VERCEL_OIDC_TOKEN="$TOKEN" MODEL_API_KEY="$KEY" BUILDER_SNAPSHOT_ID="$SNAP" npx tsx "$script" "$@"
