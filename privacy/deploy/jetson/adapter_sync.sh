#!/usr/bin/env bash
# Puts a router LoRA adapter in place on this Jetson and applies it through llama-server.
#
# The adapter is trained in the cloud (scripts/cloud/train_lora_modal.py), lands on the laptop, and
# reaches this board by USB stick or a copy the laptop starts (this board never connects to the
# laptop). Then, on this board:
#
#   sudo deploy/jetson/adapter_sync.sh /path/to/router.gguf [--scale S]
#
# llama-server only loads LoRA files at start, so a new or changed adapter restarts
# muse-privacy-glimmer.service. The adapter's global scale stays 0 by default: the server finds
# its id at start (GET /lora-adapters) and the router names it on each of its own requests, so the
# answer model, the name pass and grading never use it. --scale S applies it to every request,
# which is only for testing.
set -euo pipefail

ADAPTERS_DIR="${MUSE_ADAPTERS_DIR:-/var/lib/muse-privacy/adapters}"
GLIMMER_URL="${GLIMMER_URL:-http://127.0.0.1:8081}"
SERVICE=muse-privacy-glimmer.service
SERVICE_USER=muse-privacy
KEY_FILE="${LLAMA_KEY_FILE:-/var/lib/muse-privacy/home/llama_api_key}"
SCALE=0
APPLY=1  # --lora-init-without-apply alone still applies the adapter at 1.0 (b11970), so set 0 here
SRC=""

usage() {
  echo "Usage: sudo $0 ADAPTER.gguf [--scale S] [--no-apply]"
  echo "  --scale S    apply the adapter to every request at scale S (testing only; the router"
  echo "               names it per request, so the default leaves the global scale at 0)"
  echo "  --no-apply   install and load the adapter, and leave its scale alone"
}
die() { printf 'adapter_sync.sh: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --scale) [ $# -ge 2 ] || die "--scale needs a value"; SCALE="$2"; APPLY=1; shift ;;
    --no-apply) APPLY=0 ;;
    # --no-apply leaves the scale as the server has it, which may be 1.0 after a restart
    -h|--help) usage; exit 0 ;;
    -*) usage >&2; die "unknown option: $1" ;;
    *) [ -z "$SRC" ] || die "give one adapter path"; SRC="$1" ;;
  esac
  shift
done

[ -n "$SRC" ] || { usage >&2; exit 1; }
[ -f "$SRC" ] || die "no such file: $SRC"
[ "$(head -c 4 "$SRC")" = GGUF ] || die "$SRC is not a GGUF file"
[[ "$SCALE" =~ ^[0-9]+([.][0-9]+)?$ ]] || die "scale must be a number like 1.0"

# llama-server runs with --api-key-file; every call but /health needs the key.
AUTH=()
if [ -r "$KEY_FILE" ]; then AUTH=(-H "Authorization: Bearer $(cat "$KEY_FILE")"); fi

DEST="$ADAPTERS_DIR/router.gguf"
NEW_SHA="$(sha256sum "$SRC" | cut -d' ' -f1)"
OLD_SHA=""
[ -f "$DEST" ] && OLD_SHA="$(sha256sum "$DEST" | cut -d' ' -f1)"

if [ "$NEW_SHA" != "$OLD_SHA" ]; then
  [ "$(id -u)" -eq 0 ] || die "run as root to install a new adapter (it restarts $SERVICE)"
  install -m 0640 -o "$SERVICE_USER" -g "$SERVICE_USER" "$SRC" "$DEST.new"
  mv -f "$DEST.new" "$DEST"
  echo "Installed adapter $NEW_SHA; restarting $SERVICE so llama-server loads it."
  systemctl restart "$SERVICE"
else
  echo "Adapter unchanged ($NEW_SHA)."
fi

echo "Waiting for llama-server at $GLIMMER_URL"
for _ in $(seq 1 300); do
  if curl -fs -o /dev/null --max-time 2 "$GLIMMER_URL/health"; then break; fi
  sleep 1
done
curl -fs -o /dev/null --max-time 2 "$GLIMMER_URL/health" || die "llama-server did not come up; see: journalctl -u $SERVICE"

ADAPTER_ID="$(curl -fsS --max-time 5 "${AUTH[@]}" "$GLIMMER_URL/lora-adapters" | python3 -c '
import json, sys
dest = sys.argv[1]
for entry in json.load(sys.stdin):
    if entry.get("path", "").endswith(dest.rsplit("/", 1)[-1]):
        print(entry["id"])
        break
' "$DEST")" || die "could not list llama-server's LoRA adapters"
[ -n "$ADAPTER_ID" ] || die "llama-server did not load $DEST; check glimmer.env and: journalctl -u $SERVICE"

if [ "$APPLY" -eq 1 ]; then
  curl -fsS --max-time 10 -X POST -H 'Content-Type: application/json' "${AUTH[@]}" \
    -d "[{\"id\": $ADAPTER_ID, \"scale\": $SCALE}]" "$GLIMMER_URL/lora-adapters" >/dev/null \
    || die "llama-server refused the new adapter scale"
  echo "Adapter $ADAPTER_ID applied at scale $SCALE."
else
  echo "Adapter $ADAPTER_ID loaded; its scale is left as the server has it, which may be 1.0."
fi
echo "Restart muse-privacy.service so the server finds the adapter id and sets its scale to 0."
