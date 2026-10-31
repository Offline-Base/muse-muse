#!/bin/bash
# Runs the spike with Vercel credentials from a pull that never touches .env.local. Prints no values.
#   docs/spikes/xr-2026-10-31/run.sh <out dir> A [B] [T] [D]     (from the repo root; XR_VCPUS and XR_SKIP_MATRIX pass through)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
LINKED=${MUSE_MAIN_CHECKOUT:-$ROOT} # The checkout that holds .vercel and .env.local.
F=$(mktemp)
trap 'rm -f "$F"' EXIT
(cd "$LINKED" && vercel env pull --environment=development --yes "$F" >/dev/null 2>&1)
TOKEN=$(grep '^VERCEL_OIDC_TOKEN=' "$F" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')
SNAP=$(grep '^BUILDER_SNAPSHOT_ID=' "$LINKED/.env.local" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')
rm -f "$F"
cd "$ROOT"
exec env -i PATH="$PATH" HOME="$HOME" XR_VCPUS="${XR_VCPUS:-}" XR_SKIP_MATRIX="${XR_SKIP_MATRIX:-}" VERCEL_OIDC_TOKEN="$TOKEN" BUILDER_SNAPSHOT_ID="$SNAP" npx tsx docs/spikes/xr-2026-10-31/run-spike.ts "$@"
