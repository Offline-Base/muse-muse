#!/usr/bin/env bash
# Starts a Glimmer file on a side port for measuring, without touching the running app.
# Since the organizers' Nov 2, 2026 ruling (Meta models only) it no longer starts LFM3-VL-2B beside it:
# Glimmer is the checker too (CHECKER_BACKEND=glimmer).
#
#   scripts/start_side_models.sh /path/to/glimmer.gguf [HOME_DIR]
#
#   SIDE_GLIMMER_PORT  default 8181
#   SIDE_THREADS       CPU threads, default 4 (the model is on the GPU)
#   SIDE_CTX           default 16384
#   SIDE_REASONING     off (default) or on; off serves Glimmer with --reasoning-format none
#   SIDE_TEMPLATE      a chat template file for Glimmer (--chat-template-file)
#
# Refused on a Mac: Glimmer overheated the owner's laptop, so measuring runs elsewhere (docs/GPU_RUN.md).
# HOME_DIR holds a throwaway key file and the logs. It is refused if it is the real ~/.base. Binds
# 127.0.0.1 only and runs at low priority, in the foreground; Ctrl-C stops it. It prints the
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
[ "$(uname -s)" != Darwin ] || die "this loads Glimmer, and it does not run on the owner's laptop: see docs/GPU_RUN.md"

BIN="${LLAMA_SERVER_BIN:-$(command -v llama-server || true)}"
[ -n "$BIN" ] && [ -x "$BIN" ] || die "no llama-server: set LLAMA_SERVER_BIN"
G_PORT="${SIDE_GLIMMER_PORT:-8181}"
THREADS="${SIDE_THREADS:-4}"
CTX="${SIDE_CTX:-16384}"

KEY="$HOME_DIR/llama_api_key"
[ -s "$KEY" ] || (umask 077 && python3 -c 'import secrets; print(secrets.token_urlsafe(32))' >"$KEY")
chmod 600 "$KEY"

COMMON=(--host 127.0.0.1 -np 1 -ngl 99 -t "$THREADS" -c "$CTX" --jinja --cache-ram 0 --ctx-checkpoints 0 --no-slots --api-key-file "$KEY")
G_FLAGS=()
if [ "${SIDE_REASONING:-off}" = off ]; then G_FLAGS+=(--reasoning-format none); fi
if [ -n "${SIDE_TEMPLATE:-}" ]; then
  [ -f "$SIDE_TEMPLATE" ] || die "no such template: $SIDE_TEMPLATE"
  G_FLAGS+=(--chat-template-file "$SIDE_TEMPLATE")
fi
PIDS=""
trap 'kill $PIDS 2>/dev/null || true' EXIT INT TERM

nice -n 15 "$BIN" --model "$GGUF" --alias glimmer --port "$G_PORT" "${COMMON[@]}" ${G_FLAGS[@]+"${G_FLAGS[@]}"} >"$HOME_DIR/glimmer.log" 2>&1 &
PIDS="$PIDS $!"

cat <<EOF
Side model starting. Logs and key file: $HOME_DIR

  export BASE_HOME="$HOME_DIR"
  export DEVICE_ONLY=1 PRIMARY_MODEL=glimmer GLIMMER_BACKEND=llama_server CHECKER_BACKEND=glimmer
  export GLIMMER_REASONING=${SIDE_REASONING:-off}
  export ANSWER_URL=http://127.0.0.1:$G_PORT/v1 ROUTER_URL=http://127.0.0.1:$G_PORT/v1
  uv run python -m scripts.glimmer_probe --url http://127.0.0.1:$G_PORT/v1 --key-file "$KEY"
EOF
wait
