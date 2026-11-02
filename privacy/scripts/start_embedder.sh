#!/usr/bin/env bash
# Starts the search embedder, Google's EmbeddingGemma 2 (text only), on 127.0.0.1:8084
# (SEARCH_EMBEDDINGS=1). search_documents fuses its ranking with BM25. Same llama.cpp as the checker:
#
#   CHECKER_SERVER_BIN  path to llama-server (default: LLAMA_SERVER_BIN, then llama-server on PATH)
#   EMBED_GGUF          default models/embeddinggemma-2-Q8_0.gguf (ggml-org/embeddinggemma-2-GGUF)
#
# Runs in the foreground; Ctrl-C stops it. Binds 127.0.0.1 only and reads the same key file as
# Glimmer's servers (BASE_HOME/llama_api_key), so other local processes cannot use it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/.venv/bin/python"

die() { printf 'start_embedder.sh: %s\n' "$*" >&2; exit 1; }

# Off since the organizers' ruling on Nov 2, 2026: Muse Privacy may call only Meta models, with no
# non-Meta helper. The rest of this script stays until the owner decides whether to delete it.
die "Google's EmbeddingGemma 2 is not a Meta model, and the hackathon organizers ruled on Nov 2, 2026 that Muse Privacy may call only Meta models. Search uses keywords only now (SEARCH_EMBEDDINGS=0), so there is nothing to start."

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
    "PORT": str(urlsplit(s.embed_url).port or 8084),
    "ALIAS": s.embed_model,
    "BIN": env.get("CHECKER_SERVER_BIN") or env.get("LLAMA_SERVER_BIN", ""),
    "GGUF": env.get("EMBED_GGUF", str(REPO_ROOT / "models" / "embeddinggemma-2-Q8_0.gguf")),
}
for key, value in values.items():
    print(f"{key}={shlex.quote(value)}")
PY
)" || die "could not read settings (see the error above)"
eval "$SETTINGS"

[ -n "$BIN" ] || BIN="$(command -v llama-server || true)"
[ -n "$BIN" ] || die "set CHECKER_SERVER_BIN to a llama-server from llama.cpp b11960 or newer"
[ -x "$BIN" ] || die "CHECKER_SERVER_BIN is not an executable file: $BIN"
[ -f "$GGUF" ] || die "no embedding model at $GGUF (download embeddinggemma-2-Q8_0.gguf from ggml-org/embeddinggemma-2-GGUF)"
if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/"; then
  die "something already answers on 127.0.0.1:$PORT; stop it first"
fi

mkdir -p "$HOME_DIR" && chmod 700 "$HOME_DIR"
KEY_FILE="$HOME_DIR/llama_api_key"
if [ ! -s "$KEY_FILE" ]; then
  (umask 077 && python3 -c 'import secrets; print(secrets.token_urlsafe(32))' >"$KEY_FILE")
fi
chmod 600 "$KEY_FILE"

echo "Starting the embedder (EmbeddingGemma 2) on 127.0.0.1:$PORT"
# One sequence per request; a batch as large as the context so a whole piece is embedded at once.
exec "$BIN" --model "$GGUF" --alias "$ALIAS" --host 127.0.0.1 --port "$PORT" \
  --embedding -c 8192 -b 8192 -ub 8192 -np 4 -ngl 99 --no-slots --api-key-file "$KEY_FILE"
