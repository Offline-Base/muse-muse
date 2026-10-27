#!/usr/bin/env bash
# Starts Muse Privacy on the laptop (BASE_DEVICE=laptop).
#
#   GLIMMER_BACKEND=llama_server: starts two llama-servers from LLAMA_SERVER_BIN with the GGUF in
#     GLIMMER_GGUF, answer on 127.0.0.1:8081 and router on 127.0.0.1:8082 (the router loads
#     BASE_HOME/adapters/router.gguf as a LoRA when it exists), then the server.
#   GLIMMER_BACKEND=openrouter: no local models (development mode, invented data only).
#
# Then runs `python -m base` and waits for /health on the approval port. Everything binds
# 127.0.0.1. Ctrl-C stops everything this script started. Settings come from .env and the
# environment, read through base.config so this script and the server always agree.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/.venv/bin/python"
PIDS=""

die() { printf 'start.sh: %s\n' "$*" >&2; exit 1; }

cleanup() {
  for pid in $PIDS; do kill "$pid" 2>/dev/null || true; done
  for pid in $PIDS; do wait "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT
trap 'exit 130' INT TERM

read_settings() {
  "$PY" - <<'PY'
import os
import shlex

from base.config import REPO_ROOT, load_settings, read_dotenv

s = load_settings()
env = read_dotenv(REPO_ROOT / ".env")
env.update(os.environ)
values = {
    "DEVICE": s.device,
    "BACKEND": s.glimmer_backend,
    "APPROVAL_HOST": s.approval_host,
    "APPROVAL_PORT": str(s.approval_port),
    "HOME_DIR": str(s.home),
    "LLAMA_SERVER_BIN": env.get("LLAMA_SERVER_BIN", ""),
    "GLIMMER_GGUF": env.get("GLIMMER_GGUF", ""),
    "ANSWER_CTX": env.get("ANSWER_CTX", "16384"),
    "ROUTER_CTX": env.get("ROUTER_CTX", "8192"),
}
for key, value in values.items():
    print(f"{key}={shlex.quote(value)}")
PY
}

# Answers when something already serves HTTP on 127.0.0.1:<port>.
port_busy() { curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$1/" ; }

# wait_for URL SECONDS NAME PID LOG
wait_for() {
  local url="$1" seconds="$2" name="$3" pid="$4" logfile="$5" i=0
  while [ "$i" -lt "$seconds" ]; do
    if curl -fs -o /dev/null --max-time 2 "$url"; then return 0; fi
    kill -0 "$pid" 2>/dev/null || die "$name stopped while starting. See $logfile"
    sleep 1
    i=$((i + 1))
  done
  die "$name did not answer at $url within ${seconds}s. See $logfile"
}

[ -x "$PY" ] || die "no virtualenv at $ROOT/.venv. Run: uv sync"
SETTINGS="$(cd "$ROOT" && read_settings)" || die "could not read settings (see the error above)"
eval "$SETTINGS"

[ "$DEVICE" = laptop ] || die "start.sh is for BASE_DEVICE=laptop. On a Jetson use the systemd units in deploy/jetson/."
case "$APPROVAL_HOST" in
  127.0.0.1|localhost) ;;
  *) die "on the laptop the approval page binds 127.0.0.1 only; unset APPROVAL_HOST" ;;
esac
command -v curl >/dev/null 2>&1 || die "curl is needed to check that things started"

LOG_DIR="$HOME_DIR/logs"

if [ "$BACKEND" = llama_server ]; then
  [ -n "$LLAMA_SERVER_BIN" ] || LLAMA_SERVER_BIN="$(command -v llama-server || true)"
  [ -n "$LLAMA_SERVER_BIN" ] || die "GLIMMER_BACKEND=llama_server needs LLAMA_SERVER_BIN (path to llama-server)"
  [ -x "$LLAMA_SERVER_BIN" ] || die "LLAMA_SERVER_BIN is not an executable file: $LLAMA_SERVER_BIN"
  [ -n "$GLIMMER_GGUF" ] || die "GLIMMER_BACKEND=llama_server needs GLIMMER_GGUF (path to the Glimmer .gguf)"
  [ -f "$GLIMMER_GGUF" ] || die "GLIMMER_GGUF is not a file: $GLIMMER_GGUF"
  for port in 8081 8082; do
    if port_busy "$port"; then die "something already answers on 127.0.0.1:$port; stop it first"; fi
  done
  mkdir -p "$LOG_DIR" && chmod 700 "$LOG_DIR"
  # A key only this user can read, so other local processes cannot use the model or change the
  # router adapter's scale. The server reads the same file (BASE_HOME/llama_api_key).
  KEY_FILE="$HOME_DIR/llama_api_key"
  if [ ! -s "$KEY_FILE" ]; then
    (umask 077 && python3 -c 'import secrets; print(secrets.token_urlsafe(32))' >"$KEY_FILE")
  fi
  chmod 600 "$KEY_FILE"
  # No prompt cache or context checkpoints in RAM (8 GiB and 32 by default), no /slots endpoint.
  SERVER_FLAGS=(--cache-ram 0 --ctx-checkpoints 0 --no-slots --api-key-file "$KEY_FILE")

  echo "Starting Glimmer (answer) on 127.0.0.1:8081"
  "$LLAMA_SERVER_BIN" --model "$GLIMMER_GGUF" --alias glimmer --host 127.0.0.1 --port 8081 \
    -c "$ANSWER_CTX" -np 1 -ngl 99 --jinja "${SERVER_FLAGS[@]}" >"$LOG_DIR/answer.log" 2>&1 &
  ANSWER_PID=$!
  PIDS="$PIDS $ANSWER_PID"

  ADAPTER="$HOME_DIR/adapters/router.gguf"
  if [ -f "$ADAPTER" ]; then
    echo "Starting Glimmer (router) on 127.0.0.1:8082 with the router adapter loaded"
    "$LLAMA_SERVER_BIN" --model "$GLIMMER_GGUF" --alias glimmer --host 127.0.0.1 --port 8082 \
      -c "$ROUTER_CTX" -np 1 -ngl 99 --jinja "${SERVER_FLAGS[@]}" --lora "$ADAPTER" --lora-init-without-apply \
      >"$LOG_DIR/router.log" 2>&1 &
  else
    echo "Starting Glimmer (router) on 127.0.0.1:8082 (no router adapter yet)"
    "$LLAMA_SERVER_BIN" --model "$GLIMMER_GGUF" --alias glimmer --host 127.0.0.1 --port 8082 \
      -c "$ROUTER_CTX" -np 1 -ngl 99 --jinja "${SERVER_FLAGS[@]}" >"$LOG_DIR/router.log" 2>&1 &
  fi
  ROUTER_PID=$!
  PIDS="$PIDS $ROUTER_PID"

  wait_for "http://127.0.0.1:8081/health" 600 "Glimmer (answer)" "$ANSWER_PID" "$LOG_DIR/answer.log"
  wait_for "http://127.0.0.1:8082/health" 600 "Glimmer (router)" "$ROUTER_PID" "$LOG_DIR/router.log"
  echo "Glimmer is up."
else
  echo "GLIMMER_BACKEND=$BACKEND: no local models. Development mode, invented data only."
fi

if port_busy "$APPROVAL_PORT"; then die "something already answers on 127.0.0.1:$APPROVAL_PORT; stop it first"; fi
echo "Starting Muse Privacy"
(cd "$ROOT" && exec "$PY" -m base) &
APP_PID=$!
PIDS="$PIDS $APP_PID"
wait_for "http://127.0.0.1:$APPROVAL_PORT/health" 60 "Muse Privacy" "$APP_PID" "the output above"
echo "Muse Privacy is up: http://127.0.0.1:$APPROVAL_PORT (Ctrl-C stops it)"

while sleep 2; do
  for pid in $PIDS; do
    kill -0 "$pid" 2>/dev/null || die "a process this script started has stopped; shutting the rest down"
  done
done
