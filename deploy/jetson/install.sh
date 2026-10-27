#!/usr/bin/env bash
# Installs Muse Privacy on a Jetson Orin Nano. Run from a checkout of this repo, as root.
# It creates the service user and directories, copies the app, downloads Glimmer i1-IQ1_S with
# resume and a SHA-256 check, and installs the systemd units. It leaves the board's settings alone
# and never restarts the machine. Not yet run on a real board; see README.md.
set -euo pipefail

PREFIX=/opt/muse-privacy
STATE=/var/lib/muse-privacy
CONF=/etc/muse-privacy
UNIT_DIR=/etc/systemd/system
SERVICE_USER=muse-privacy

MODEL_REPO=mradermacher/Muse-Glimmer-30B-i1-GGUF
MODEL_NAME=Muse-Glimmer-30B.i1-IQ1_S.gguf
MODEL_URL="https://huggingface.co/$MODEL_REPO/resolve/main/$MODEL_NAME"
MODEL_API="https://huggingface.co/api/models/$MODEL_REPO/tree/main"
LLAMA_REPO=https://github.com/ggml-org/llama.cpp
LLAMA_REF="${LLAMA_REF:-b10353}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_SRC="$(cd "$HERE/../.." && pwd)"

BUILD_LLAMA=0
START=0
SKIP_MODEL=0

usage() {
  cat <<'EOF'
Usage: sudo deploy/jetson/install.sh [--build-llama] [--skip-model] [--start]

  --build-llama  clone llama.cpp (tag b10353 or LLAMA_REF) into /opt/muse-privacy/llama.cpp
                 and build llama-server with CUDA if it is not there yet (takes a while)
  --skip-model   do not download the Glimmer GGUF
  --start        start the services at the end (otherwise they are only enabled)

Environment:
  MODEL_SHA256   expected SHA-256 of the GGUF, if you do not want it read from the Hugging Face API
  LLAMA_REF      llama.cpp tag to build (default b10353; needs b10353 or newer)
  CUDACXX        the CUDA compiler (default /usr/local/cuda/bin/nvcc)
  BUILD_JOBS     parallel compile jobs for --build-llama (default 2; more can run out of memory)
EOF
}

say() { printf '\n== %s\n' "$*"; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --build-llama) BUILD_LLAMA=1 ;;
    --skip-model) SKIP_MODEL=1 ;;
    --start) START=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
  shift
done

[ "$(uname -s)" = Linux ] || die "run this on the Jetson itself (Linux)"
[ "$(id -u)" -eq 0 ] || die "run as root: sudo $0"
for cmd in curl python3 sha256sum systemctl install tar useradd; do
  command -v "$cmd" >/dev/null 2>&1 || die "missing command: $cmd"
done

say "Service user"
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --user-group --home-dir "$STATE" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi
# video: the GPU device nodes; dialout: the USB status light. Skipped if a group does not exist.
for group in video render dialout; do
  if getent group "$group" >/dev/null; then usermod -aG "$group" "$SERVICE_USER"; fi
done

say "Directories"
install -d -m 0755 "$PREFIX" "$PREFIX/bin" "$PREFIX/models" "$PREFIX/app"
install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$STATE" "$STATE/home" "$STATE/adapters"
install -d -m 0750 -o root -g "$SERVICE_USER" "$CONF"
if [ ! -f "$CONF/env" ]; then
  cat >"$CONF/env" <<'EOF'
# Site settings for Muse Privacy on this board. Read by the systemd units.
# The approval page address the laptop worker dials (this board's address on your own network).
# APPROVAL_HOST=
# The connector relay (Cloudflare Worker) this board dials out to.
# RELAY_URL=
# The status light, if one is plugged in.
# LIGHT_SERIAL=/dev/ttyACM0
# Where your documents live on this board.
# WORKSPACE_ROOT=/var/lib/muse-privacy/workspace
# TLS for the approval port (install.sh made these). Copy cert.pem to the laptop for --ca-cert.
APPROVAL_TLS_CERT=/var/lib/muse-privacy/home/tls/cert.pem
APPROVAL_TLS_KEY=/var/lib/muse-privacy/home/tls/key.pem
EOF
  chown root:"$SERVICE_USER" "$CONF/env"
  chmod 0640 "$CONF/env"
fi

say "llama-server key"
# One random key, read by llama-server (--api-key-file) and by the server (BASE_HOME/llama_api_key),
# so no other local process can use the model or change the router adapter's scale.
KEY_FILE="$STATE/home/llama_api_key"
if [ ! -s "$KEY_FILE" ]; then
  (umask 077 && python3 -c 'import secrets; print(secrets.token_urlsafe(32))' >"$KEY_FILE")
fi
chown "$SERVICE_USER:$SERVICE_USER" "$KEY_FILE"
chmod 0600 "$KEY_FILE"

say "TLS certificate"
# A self-signed certificate for the approval port, so the session cookie, the worker token and the
# essays in heavy steps never cross the home network in the clear. The laptop worker pins it.
TLS_DIR="$STATE/home/tls"
if [ ! -s "$TLS_DIR/cert.pem" ]; then
  if command -v openssl >/dev/null 2>&1; then
    install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$TLS_DIR"
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
      -subj "/CN=muse-privacy" -addext "subjectAltName=DNS:muse-privacy" \
      -keyout "$TLS_DIR/key.pem" -out "$TLS_DIR/cert.pem" 2>/dev/null
    chown "$SERVICE_USER:$SERVICE_USER" "$TLS_DIR/key.pem" "$TLS_DIR/cert.pem"
    chmod 0600 "$TLS_DIR/key.pem"
    chmod 0644 "$TLS_DIR/cert.pem"
  else
    echo "openssl is not installed, so no certificate was made; the approval page will be plain http."
  fi
fi

say "App"
# Copy only what git tracks: never .env (secrets stay on the laptop), a virtualenv, node_modules
# or local state from anywhere in the tree. Without git, fall back to tar with unanchored excludes.
if command -v git >/dev/null 2>&1 && git -C "$APP_SRC" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "$APP_SRC" archive --format=tar HEAD | tar -C "$PREFIX/app" -xf -
else
  tar -C "$APP_SRC" --exclude=.env --exclude=.venv --exclude=.git --exclude=node_modules \
    --exclude=.wrangler --exclude=__pycache__ -cf - . | tar -C "$PREFIX/app" -xf -
fi
chown -R root:root "$PREFIX/app"
if command -v uv >/dev/null 2>&1; then
  # Keep the Python uv installs under /opt so the service user can reach it (ProtectHome hides /root).
  (cd "$PREFIX/app" && UV_PYTHON_INSTALL_DIR="$PREFIX/python" uv sync --frozen --no-dev)
else
  echo "uv is not installed, so the app's virtualenv was not built."
  echo "Install uv, then run: cd $PREFIX/app && UV_PYTHON_INSTALL_DIR=$PREFIX/python uv sync --frozen --no-dev"
fi

say "llama.cpp"
LLAMA_BIN="$PREFIX/llama.cpp/build/bin/llama-server"
if [ -x "$LLAMA_BIN" ]; then
  echo "llama-server found."
elif [ "$BUILD_LLAMA" -eq 1 ]; then
  command -v git >/dev/null 2>&1 || die "missing command: git"
  command -v cmake >/dev/null 2>&1 || die "missing command: cmake"
  # JetPack puts nvcc in /usr/local/cuda/bin, which sudo's secure_path leaves off PATH.
  NVCC="${CUDACXX:-/usr/local/cuda/bin/nvcc}"
  [ -x "$NVCC" ] || die "no CUDA compiler at $NVCC (install the JetPack CUDA toolkit, or set CUDACXX)"
  export CUDACXX="$NVCC" PATH="$(dirname "$NVCC"):$PATH"
  [ -d "$PREFIX/llama.cpp" ] || git clone --depth 1 --branch "$LLAMA_REF" "$LLAMA_REPO" "$PREFIX/llama.cpp"
  # The CUDA kernels need well over 1 GB each to compile, so build two at a time on the 8 GB
  # board, with the model service stopped.
  systemctl stop muse-privacy-glimmer.service 2>/dev/null || true
  # Orin is CUDA compute capability 8.7.
  cmake -S "$PREFIX/llama.cpp" -B "$PREFIX/llama.cpp/build" -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=87 \
    -DCMAKE_BUILD_TYPE=Release -DLLAMA_BUILD_TESTS=OFF
  cmake --build "$PREFIX/llama.cpp/build" --config Release -j "${BUILD_JOBS:-2}" --target llama-server
else
  echo "llama-server is not at $LLAMA_BIN. Run again with --build-llama, or build llama.cpp $LLAMA_REF"
  echo "or newer with CUDA there yourself. The Glimmer service will not start until it exists."
fi

say "Glimmer model"
if [ "$SKIP_MODEL" -eq 1 ]; then
  echo "Skipped (--skip-model)."
else
  DEST="$PREFIX/models/$MODEL_NAME"
  if [ -n "${MODEL_SHA256:-}" ]; then
    EXPECTED_SHA="$MODEL_SHA256"
    EXPECTED_SIZE=0
  else
    # The Hugging Face tree API lists each LFS file's SHA-256 and size.
    INFO="$(curl -fsSL --retry 3 "$MODEL_API" | python3 -c '
import json, sys
name = sys.argv[1]
for entry in json.load(sys.stdin):
    lfs = entry.get("lfs") or {}
    if entry.get("path") == name and lfs.get("oid"):
        print(lfs["oid"], lfs.get("size") or entry.get("size") or 0)
        break
' "$MODEL_NAME")" || die "could not read the model's SHA-256 from the Hugging Face API"
    [ -n "$INFO" ] || die "the Hugging Face API did not list $MODEL_NAME"
    EXPECTED_SHA="${INFO%% *}"
    EXPECTED_SIZE="${INFO##* }"
  fi
  [[ "$EXPECTED_SHA" =~ ^[0-9a-f]{64}$ ]] || die "expected SHA-256 does not look like one"

  if [ -f "$DEST" ] && [ "$(sha256sum "$DEST" | cut -d' ' -f1)" = "$EXPECTED_SHA" ]; then
    echo "Model already in place and verified."
  else
    FREE_KB="$(df -Pk "$PREFIX/models" | awk 'NR == 2 {print $4}')"
    HAVE=0
    [ -f "$DEST.part" ] && HAVE="$(stat -c %s "$DEST.part")"
    if [ "$EXPECTED_SIZE" -gt 0 ] && [ $(( (EXPECTED_SIZE - HAVE) / 1024 + 1048576 )) -gt "$FREE_KB" ]; then
      die "not enough free disk for the model (needs about $((EXPECTED_SIZE / 1073741824 + 1)) GB)"
    fi
    if [ "$EXPECTED_SIZE" -gt 0 ] && [ "$HAVE" -eq "$EXPECTED_SIZE" ]; then
      echo "Download already complete, verifying."
    else
      echo "Downloading $MODEL_NAME (resumes if interrupted)."
      curl -fL --retry 10 --retry-delay 5 --continue-at - -o "$DEST.part" "$MODEL_URL"
    fi
    ACTUAL_SHA="$(sha256sum "$DEST.part" | cut -d' ' -f1)"
    [ "$ACTUAL_SHA" = "$EXPECTED_SHA" ] || die "SHA-256 mismatch for $DEST.part. Delete it and run again."
    mv -f "$DEST.part" "$DEST"
    chmod 0644 "$DEST"
    echo "Model verified."
  fi
fi

say "systemd units"
install -m 0755 "$HERE/glimmer-env.sh" "$PREFIX/bin/glimmer-env.sh"
install -m 0755 "$HERE/adapter_sync.sh" "$PREFIX/bin/adapter_sync.sh"
for unit in muse-privacy-glimmer.service muse-privacy.service muse-privacy-relay.service; do
  install -m 0644 "$HERE/$unit" "$UNIT_DIR/$unit"
done
systemctl daemon-reload
systemctl enable muse-privacy-glimmer.service muse-privacy.service
if [ "$START" -eq 1 ]; then
  systemctl restart muse-privacy-glimmer.service muse-privacy.service
fi

say "Done"
cat <<EOF
Next steps:
  1. Edit $CONF/env (APPROVAL_HOST so the laptop worker can reach this board, RELAY_URL, LIGHT_SERIAL).
  2. Start:   systemctl start muse-privacy-glimmer muse-privacy
     Logs:    journalctl -u muse-privacy-glimmer -u muse-privacy -f
  3. Pair the laptop worker: sudo -u $SERVICE_USER env BASE_HOME=$STATE/home $PREFIX/app/.venv/bin/python -m base.heavy.routes
     and copy $STATE/home/tls/cert.pem to the laptop for the worker's --ca-cert.
  4. After pairing the relay: systemctl enable --now muse-privacy-relay
  The board should boot without the desktop (multi-user.target): the model needs about 6.5 to 7.3 GB.
EOF
