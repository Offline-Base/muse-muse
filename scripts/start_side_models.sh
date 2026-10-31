#!/usr/bin/env bash
# Starts a Glimmer file and LFM3-VL-2B on side ports for measuring, without touching the running app.
#
#   scripts/start_side_models.sh /path/to/glimmer.gguf [HOME_DIR]
#
#   SIDE_GLIMMER_PORT  default 8181
#   SIDE_CHECKER_PORT  default 8183
#   SIDE_THREADS       CPU threads per server, default 4 (the models are on the GPU)
#   SIDE_CTX           default 16384
#   SIDE_REASONING     off (default) or on; off serves Glimmer with --reasoning-budget 0
#   SIDE_TEMPLATE      a chat template file for Glimmer (--chat-template-file)
#
# HOME_DIR holds a throwaway key file and the logs. It is refused if it is the real ~/.base. Binds
# 127.0.0.1 only and runs at low priority, in the foreground; Ctrl-C stops both. It prints the
# environment that scripts.model_matrix, scripts.bench_device and scripts.simulate_nights need, with
# the key as a file path, never its value.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
die() { printf 'start_side_models.sh: %s\n' "$*" >&2; exit 1; }

[ $# -ge 1 ] || die "give the path to the Glimmer .gguf"
GGUF="$1"
[ -f "$GGUF" ] || die "no such file: $GGUF"
HOME_DIR="${2:-$(mktemp -d "${TMPDIR:-/tmp}/muse-side.XXXXXX")}"
mkdir -p "$HOME_DIR"
HOME_DIR="$(cd "$HOME_DIR" && pwd)"
[ "$HOME_DIR" != "$HOME/.base" ] || die "use a throwaway folder, not the app's ~/.base"

BIN="${CHECKER_SERVER_BIN:-${LLAMA_SERVER_BIN:-$(command -v llama-server || true)}}"
[ -n "$BIN" ] && [ -x "$BIN" ] || die "no llama-server: set CHECKER_SERVER_BIN"
LFM="${CHECKER_GGUF:-$ROOT/models/LFM3-VL-2B-Q4_K_M.gguf}"
[ -f "$LFM" ] || die "no LFM file at $LFM: set CHECKER_GGUF"
G_PORT="${SIDE_GLIMMER_PORT:-8181}"
C_PORT="${SIDE_CHECKER_PORT:-8183}"
THREADS="${SIDE_THREADS:-4}"
CTX="${SIDE_CTX:-16384}"

KEY="$HOME_DIR/llama_api_key"
[ -s "$KEY" ] || (umask 077 && python3 -c 'import secrets; print(secrets.token_urlsafe(32))' >"$KEY")
chmod 600 "$KEY"

COMMON=(--host 127.0.0.1 -np 1 -ngl 99 -t "$THREADS" -c "$CTX" --jinja --cache-ram 0 --ctx-checkpoints 0 --no-slots --api-key-file "$KEY")
G_FLAGS=()
if [ "${SIDE_REASONING:-off}" = off ]; then G_FLAGS+=(--reasoning-budget 0); fi
if [ -n "${SIDE_TEMPLATE:-}" ]; then
  [ -f "$SIDE_TEMPLATE" ] || die "no such template: $SIDE_TEMPLATE"
  G_FLAGS+=(--chat-template-file "$SIDE_TEMPLATE")
fi
PIDS=""
trap 'kill $PIDS 2>/dev/null || true' EXIT INT TERM

nice -n 15 "$BIN" --model "$GGUF" --alias glimmer --port "$G_PORT" "${COMMON[@]}" ${G_FLAGS[@]+"${G_FLAGS[@]}"} >"$HOME_DIR/glimmer.log" 2>&1 &
PIDS="$PIDS $!"
nice -n 15 "$BIN" --model "$LFM" --alias lfm3-vl-2b --port "$C_PORT" "${COMMON[@]}" --reasoning-budget 0 \
  --temp 0.1 --top-p 1.0 --top-k 50 --min-p 0.0 --repeat-penalty 1.1 >"$HOME_DIR/checker.log" 2>&1 &
PIDS="$PIDS $!"

cat <<EOF
Side models starting. Logs and key file: $HOME_DIR

  export BASE_HOME="$HOME_DIR"
  export DEVICE_ONLY=1 PRIMARY_MODEL=glimmer GLIMMER_BACKEND=llama_server CHECKER_BACKEND=lfm
  export GLIMMER_REASONING=${SIDE_REASONING:-off}
  export ANSWER_URL=http://127.0.0.1:$G_PORT/v1 ROUTER_URL=http://127.0.0.1:$G_PORT/v1 CHECKER_URL=http://127.0.0.1:$C_PORT/v1
  uv run python -m scripts.glimmer_probe --url http://127.0.0.1:$G_PORT/v1 --key-file "$KEY"
EOF
wait
