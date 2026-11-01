#!/usr/bin/env bash
# Starts the local checker model, Liquid's LFM3-VL-2B, on 127.0.0.1:8083 (CHECKER_BACKEND=lfm).
#
# It runs the name check, the request-topic check, the passage picking for search_documents and
# the reading of scanned images, all on this device. Needs llama.cpp b11960 or newer (v0.8.0+):
#
#   CHECKER_SERVER_BIN  path to llama-server (default: LLAMA_SERVER_BIN, then llama-server on PATH)
#   CHECKER_GGUF        default models/LFM3-VL-2B-Q4_K_M.gguf
#   CHECKER_MMPROJ      default models/mmproj-LFM3-VL-2B-Q8_0.gguf (the vision projector)
#   CHECKER_CTX         default 16384
#   CHECKER_THREADS     CPU threads (default: llama-server's own choice)
#
# Runs in the foreground; Ctrl-C stops it. Binds 127.0.0.1 only and reads the same key file as
# Glimmer's servers (BASE_HOME/llama_api_key), so other local processes cannot use it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/.venv/bin/python"

die() { printf 'start_checker.sh: %s\n' "$*" >&2; exit 1; }

[ -x "$PY" ] || die "no virtualenv at $ROOT/.venv. Run: uv sync"
SETTINGS="$(cd "$ROOT" && "$PY" - <<'PY'
import os
import shlex
from urllib.parse import urlsplit

from base.config import REPO_ROOT, load_settings, read_dotenv

s = load_settings()
env = read_dotenv(REPO_ROOT / ".env")
env.update(os.environ)
values = {
    "HOME_DIR": str(s.home),
    "PORT": str(urlsplit(s.checker_url).port or 8083),
    "ALIAS": s.checker_model,
    "BIN": env.get("CHECKER_SERVER_BIN") or env.get("LLAMA_SERVER_BIN", ""),
    "GGUF": env.get("CHECKER_GGUF", str(REPO_ROOT / "models" / "LFM3-VL-2B-Q4_K_M.gguf")),
    "MMPROJ": env.get("CHECKER_MMPROJ", str(REPO_ROOT / "models" / "mmproj-LFM3-VL-2B-Q8_0.gguf")),
    "CTX": env.get("CHECKER_CTX", "16384"),
}
for key, value in values.items():
    print(f"{key}={shlex.quote(value)}")
PY
)" || die "could not read settings (see the error above)"
eval "$SETTINGS"

[ -n "$BIN" ] || BIN="$(command -v llama-server || true)"
[ -n "$BIN" ] || die "set CHECKER_SERVER_BIN to a llama-server from llama.cpp b11960 or newer"
[ -x "$BIN" ] || die "CHECKER_SERVER_BIN is not an executable file: $BIN"
[ -f "$GGUF" ] || die "no checker model at $GGUF (download LiquidAI/LFM3-VL-2B-GGUF, see README)"
[ -f "$MMPROJ" ] || die "no vision projector at $MMPROJ (download it from LiquidAI/LFM3-VL-2B-GGUF)"
if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/"; then
  die "something already answers on 127.0.0.1:$PORT; stop it first"
fi

mkdir -p "$HOME_DIR" && chmod 700 "$HOME_DIR"
KEY_FILE="$HOME_DIR/llama_api_key"
if [ ! -s "$KEY_FILE" ]; then
  (umask 077 && python3 -c 'import secrets; print(secrets.token_urlsafe(32))' >"$KEY_FILE")
fi
chmod 600 "$KEY_FILE"

echo "Starting the checker (LFM3-VL-2B) on 127.0.0.1:$PORT"
# Liquid's recommended sampling; thinking off here, not per request (see LocalLLM._checker_body).
exec "$BIN" --model "$GGUF" --mmproj "$MMPROJ" --alias "$ALIAS" --host 127.0.0.1 --port "$PORT" \
  -c "$CTX" -np 1 -ngl 99 ${CHECKER_THREADS:+-t "$CHECKER_THREADS"} --jinja --reasoning-budget 0 \
  --temp 0.1 --top-p 1.0 --top-k 50 --min-p 0.0 --repeat-penalty 1.1 \
  --cache-ram 0 --ctx-checkpoints 0 --no-slots --api-key-file "$KEY_FILE"
