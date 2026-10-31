#!/bin/sh
# Runs one spike script with COMPOSIO_API_KEY in its environment, read by name from .env.local.
# The key is never printed, and no other variable from that file is loaded.
#
#   sh docs/spikes/composio-2026-10-31/run.sh <script.mjs> [args...]
#
# COMPOSIO_ENV_FILE overrides the env file path. COMPOSIO_SDK_DIR points at a folder holding
# node_modules/@composio/core, for scripts that use the SDK.
set -eu
ENV_FILE="${COMPOSIO_ENV_FILE:-.env.local}"
value=$(sed -n 's/^COMPOSIO_API_KEY=//p' "$ENV_FILE" | head -n 1 | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
if [ -z "$value" ]; then
  echo "COMPOSIO_API_KEY is not set in $ENV_FILE" >&2
  exit 1
fi
COMPOSIO_API_KEY="$value" exec node "$@"
