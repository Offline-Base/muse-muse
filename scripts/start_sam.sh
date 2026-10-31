#!/usr/bin/env bash
# Starts the SAM region finder (Meta's SAM 3.1 through mlx-vlm, sidecars/sam/) on 127.0.0.1:8085,
# only when SAM_ENABLED=1. It finds faces, signatures, ID cards and barcodes in a page image and
# returns a copy with them covered (docs/CONTRACTS.md, Regions sidecar). Off by default.
#
#   SAM_ENABLED     1 starts it; anything else prints one line and exits 0
#   SAM_URL         default http://127.0.0.1:8085 (this device only)
#   SAM_MODEL_DIR   default models/sam3.1-mlx (mlx-community/sam3.1-bf16)
#   SAM_MODEL_ID    default mlx-community/sam3.1-bf16; mlx-community/sam3-8bit is SAM 3, not 3.1
#
# Never downloads or installs anything: the weights and the sidecar's own environment
# (sidecars/sam/.venv) must already be there, and HF_HUB_OFFLINE=1 is set. Runs in the foreground;
# Ctrl-C stops it. Binds 127.0.0.1 only and reads the same key file as the other model servers
# (BASE_HOME/llama_api_key), so other local processes cannot use it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/.venv/bin/python"
SAM_DIR="$ROOT/sidecars/sam"

die() { printf 'start_sam.sh: %s\n' "$*" >&2; exit 1; }

[ -x "$PY" ] || die "no virtualenv at $ROOT/.venv. Run: uv sync"
SETTINGS="$(cd "$ROOT" && "$PY" - <<'PY'
import os
import shlex
from urllib.parse import urlsplit

from base.config import REPO_ROOT, load_settings, read_dotenv

s = load_settings()  # refuses a SAM_URL that is not this device
env = read_dotenv(REPO_ROOT / ".env")
env.update(os.environ)
url = urlsplit(s.sam_url)
if (url.hostname or "").lower() not in ("127.0.0.1", "localhost", "::1"):
    raise SystemExit("SAM_URL must be this device (127.0.0.1 or localhost): the region finder reads raw page images")
values = {
    "ENABLED": "1" if s.sam_enabled else "0",
    "HOME_DIR": str(s.home),
    "PORT": str(url.port or 8085),
    "MODEL_DIR": env.get("SAM_MODEL_DIR") or str(REPO_ROOT / "models" / "sam3.1-mlx"),
    "MODEL_ID": env.get("SAM_MODEL_ID") or "mlx-community/sam3.1-bf16",
}
for key, value in values.items():
    print(f"{key}={shlex.quote(value)}")
PY
)" || die "could not read settings (see the error above)"
eval "$SETTINGS"

if [ "$ENABLED" != "1" ]; then
  echo "start_sam.sh: SAM_ENABLED is not 1, so the region finder stays off."
  exit 0
fi
[ -f "$MODEL_DIR/config.json" ] || die "no SAM weights in $MODEL_DIR. Nothing was downloaded. With Ethan's yes and room on disk, from the repo folder: hf download mlx-community/sam3.1-bf16 --local-dir models/sam3.1-mlx"
[ -x "$SAM_DIR/.venv/bin/python" ] || die "the sidecar environment (sidecars/sam/.venv) is not set up. Nothing was installed. With Ethan's yes: cd sidecars/sam && uv lock && uv sync --frozen"
if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/"; then
  die "something already answers on 127.0.0.1:$PORT; stop it first"
fi

mkdir -p "$HOME_DIR" && chmod 700 "$HOME_DIR"
KEY_FILE="$HOME_DIR/llama_api_key"
if [ ! -s "$KEY_FILE" ]; then
  (umask 077 && python3 -c 'import secrets; print(secrets.token_urlsafe(32))' >"$KEY_FILE")
fi
chmod 600 "$KEY_FILE"

echo "Starting the region finder ($MODEL_ID) on 127.0.0.1:$PORT"
cd "$SAM_DIR"
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
exec .venv/bin/python -m sam_server --host 127.0.0.1 --port "$PORT" --model-dir "$MODEL_DIR" \
  --model "$MODEL_ID" --key-file "$KEY_FILE"
