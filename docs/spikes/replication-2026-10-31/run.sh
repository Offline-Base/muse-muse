#!/bin/bash
# Runs run-spike.ts (or list.ts) with a fresh OIDC token, the way docs/spikes/xr-2026-10-31/run.sh gets one. Prints no values.
#   docs/spikes/replication-2026-10-31/run.sh <out dir> setup closed run [muse]     (from the worktree root)
#   docs/spikes/replication-2026-10-31/run.sh --list [--stop]
# The pull goes only to a mode 600 temp file in the session scratchpad; only VERCEL_OIDC_TOKEN is read from it, and it is deleted
# at once. From the linked checkout's .env.local, two names are read and nothing else: BUILDER_SNAPSHOT_ID, as the xr runner reads
# it, and MODEL_API_KEY only when the muse phase is asked for. The child gets a clean environment with only those.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
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
[ -n "$TOKEN" ] || { echo "the pull had no OIDC token" >&2; exit 3; }
value() { grep "^$1=" "$LINKED/.env.local" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }
SNAP=$(value BUILDER_SNAPSHOT_ID)
KEY=""
case " $* " in *" muse "*) KEY=$(value MODEL_API_KEY) ;; esac
cd "$ROOT"
if [ "${1:-}" = "--list" ]; then
  shift
  exec env -i PATH="$PATH" HOME="$HOME" VERCEL_OIDC_TOKEN="$TOKEN" npx tsx docs/spikes/replication-2026-10-31/list.ts "$@"
fi
exec env -i PATH="$PATH" HOME="$HOME" REP_VCPUS="${REP_VCPUS:-}" VERCEL_OIDC_TOKEN="$TOKEN" BUILDER_SNAPSHOT_ID="$SNAP" MODEL_API_KEY="$KEY" \
  npx tsx docs/spikes/replication-2026-10-31/run-spike.ts "$@"
