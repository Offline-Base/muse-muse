#!/usr/bin/env bash
# Starts Muse Privacy on the laptop (BASE_DEVICE=laptop). One command for everything.
#
#   DEVICE_ONLY=1 with PRIMARY_MODEL=lfm: LFM3-VL-2B is the only model. Glimmer is not started.
#   GLIMMER_BACKEND=llama_server: starts two llama-servers from LLAMA_SERVER_BIN with the GGUF in
#     GLIMMER_GGUF, answer on 127.0.0.1:8081 and router on 127.0.0.1:8082 (the router loads
#     BASE_HOME/adapters/router.gguf as a LoRA when it exists), then the server. With DEVICE_ONLY=1
#     one server on 8081 does both. Knobs for Glimmer's servers only (scripts/plug_in_model.py sets them):
#       GLIMMER_DRAFT_GGUF        a DFlash drafter: -md FILE -ngld 99 --spec-type draft-dflash
#       GLIMMER_DRAFT_N           tokens drafted per step, --spec-draft-n-max (default 15)
#       GLIMMER_FA                flash attention, -fa on|off|auto (default auto)
#       GLIMMER_REASONING_BUDGET  --reasoning-budget: -1 unrestricted (default), 0 none, N tokens
#   GLIMMER_BACKEND=openrouter: no local models (development mode, invented data only).
#   CHECKER_BACKEND=lfm: also starts the local checker, LFM3-VL-2B on 127.0.0.1:8083
#     (scripts/start_checker.sh), for the checks, search passage picking and scans.
#   SEARCH_EMBEDDINGS=1: also starts the embedder on 127.0.0.1:8084 (scripts/start_embedder.sh).
#
# Then runs `python -m base`, waits for /health on the approval port, and connects to the relay
# when this device is registered. Keeps the Mac awake while running. Everything binds
# 127.0.0.1. Ctrl-C stops everything this script started. Settings come from .env and the
# environment, read through base.config so this script and the server always agree.
#
# Staying up (docs/UPTIME.md): the models the answers need and `python -m base` are required, so
# when one stops this script stops everything and exits 1, and launchd (scripts/install_login.sh)
# starts it again. The embedder and the relay client are optional: when one stops it is started
# again with a growing pause (scripts/supervise.sh), and the app keeps answering meanwhile.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/.venv/bin/python"
PIDS=""
# shellcheck source=scripts/supervise.sh
. "$ROOT/scripts/supervise.sh"

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
    "CHECKER": s.checker_backend,
    "LFM_ONLY": "1" if s.device_only and s.primary_model == "lfm" else "0",
    "ONE_SERVER": "1" if s.device_only else "0",
    "EMBEDDINGS": "1" if s.search_embeddings else "0",
    "RELAY": s.relay_url or "",
    "APPROVAL_HOST": s.approval_host,
    "APPROVAL_PORT": str(s.approval_port),
    "HOME_DIR": str(s.home),
    "LLAMA_SERVER_BIN": env.get("LLAMA_SERVER_BIN", ""),
    "GLIMMER_GGUF": env.get("GLIMMER_GGUF", ""),
    "GLIMMER_DRAFT_GGUF": env.get("GLIMMER_DRAFT_GGUF", ""),
    "GLIMMER_DRAFT_N": env.get("GLIMMER_DRAFT_N") or "15",
    "GLIMMER_FA": env.get("GLIMMER_FA") or "auto",
    "GLIMMER_REASONING_BUDGET": env.get("GLIMMER_REASONING_BUDGET") or "-1",
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

if command -v pmset >/dev/null 2>&1 && pmset -g batt 2>/dev/null | grep -q "Battery Power"; then
  echo "On battery: the local model runs about 12 times slower. Plug in for normal speed."
fi
FREE_KB="$(df -Pk "$(dirname "$HOME_DIR")" 2>/dev/null | awk 'NR == 2 {print $4}' || true)"
if [ -n "$FREE_KB" ] && [ "$FREE_KB" -lt 5242880 ]; then
  echo "Only $((FREE_KB / 1048576)) GB of disk is free. Keep 5 GB or more so the logs and the database can grow (docs/UPTIME.md)."
fi

if [ "$LFM_ONLY" = 1 ]; then
  echo "Device only: LFM3-VL-2B answers every step, and no model is reached off this device."
elif [ "$BACKEND" = llama_server ]; then
  [ -n "$LLAMA_SERVER_BIN" ] || LLAMA_SERVER_BIN="$(command -v llama-server || true)"
  [ -n "$LLAMA_SERVER_BIN" ] || die "GLIMMER_BACKEND=llama_server needs LLAMA_SERVER_BIN (path to llama-server)"
  [ -x "$LLAMA_SERVER_BIN" ] || die "LLAMA_SERVER_BIN is not an executable file: $LLAMA_SERVER_BIN"
  [ -n "$GLIMMER_GGUF" ] || die "GLIMMER_BACKEND=llama_server needs GLIMMER_GGUF (path to the Glimmer .gguf)"
  [ -f "$GLIMMER_GGUF" ] || die "GLIMMER_GGUF is not a file: $GLIMMER_GGUF"
  case "$GLIMMER_FA" in on|off|auto) ;; *) die "GLIMMER_FA must be on, off or auto" ;; esac
  case "$GLIMMER_REASONING_BUDGET" in -1) ;; ''|*[!0-9]*) die "GLIMMER_REASONING_BUDGET must be -1 or a number of tokens" ;; esac
  # Glimmer's servers only: flash attention, the reasoning budget and, with a drafter, DFlash.
  GLIMMER_FLAGS=(-fa "$GLIMMER_FA" --reasoning-budget "$GLIMMER_REASONING_BUDGET")
  if [ -n "$GLIMMER_DRAFT_GGUF" ]; then
    [ -f "$GLIMMER_DRAFT_GGUF" ] || die "GLIMMER_DRAFT_GGUF is not a file: $GLIMMER_DRAFT_GGUF"
    case "$GLIMMER_DRAFT_N" in ''|*[!0-9]*|0) die "GLIMMER_DRAFT_N must be a number of tokens, 1 or more" ;; esac
    GLIMMER_FLAGS+=(-md "$GLIMMER_DRAFT_GGUF" -ngld 99 --spec-type draft-dflash --spec-draft-n-max "$GLIMMER_DRAFT_N")
    echo "Glimmer drafts with $(basename "$GLIMMER_DRAFT_GGUF"), $GLIMMER_DRAFT_N tokens a step."
  fi
  PORTS="8081 8082"
  [ "$ONE_SERVER" = 1 ] && PORTS="8081"
  for port in $PORTS; do
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

  ADAPTER="$HOME_DIR/adapters/router.gguf"
  ANSWER_LORA=()
  # Device only: one copy of the model. A global scale of 0 keeps the adapter out of everything
  # but router calls, which name it per request.
  if [ "$ONE_SERVER" = 1 ] && [ -f "$ADAPTER" ]; then ANSWER_LORA=(--lora "$ADAPTER" --lora-init-without-apply); fi
  echo "Starting Glimmer on 127.0.0.1:8081"
  "$LLAMA_SERVER_BIN" --model "$GLIMMER_GGUF" --alias glimmer --host 127.0.0.1 --port 8081 \
    -c "$ANSWER_CTX" -np 1 -ngl 99 --jinja "${SERVER_FLAGS[@]}" "${GLIMMER_FLAGS[@]}" ${ANSWER_LORA[@]+"${ANSWER_LORA[@]}"} \
    >"$LOG_DIR/answer.log" 2>&1 &
  ANSWER_PID=$!
  PIDS="$PIDS $ANSWER_PID"
  require "$ANSWER_PID" "Glimmer"

  if [ "$ONE_SERVER" = 1 ]; then
    :  # the router shares the server above
  elif [ -f "$ADAPTER" ]; then
    echo "Starting Glimmer (router) on 127.0.0.1:8082 with the router adapter loaded"
    "$LLAMA_SERVER_BIN" --model "$GLIMMER_GGUF" --alias glimmer --host 127.0.0.1 --port 8082 \
      -c "$ROUTER_CTX" -np 1 -ngl 99 --jinja "${SERVER_FLAGS[@]}" "${GLIMMER_FLAGS[@]}" --lora "$ADAPTER" --lora-init-without-apply \
      >"$LOG_DIR/router.log" 2>&1 &
  else
    echo "Starting Glimmer (router) on 127.0.0.1:8082 (no router adapter yet)"
    "$LLAMA_SERVER_BIN" --model "$GLIMMER_GGUF" --alias glimmer --host 127.0.0.1 --port 8082 \
      -c "$ROUTER_CTX" -np 1 -ngl 99 --jinja "${SERVER_FLAGS[@]}" "${GLIMMER_FLAGS[@]}" >"$LOG_DIR/router.log" 2>&1 &
  fi
  if [ "$ONE_SERVER" != 1 ]; then
    ROUTER_PID=$!
    PIDS="$PIDS $ROUTER_PID"
    require "$ROUTER_PID" "Glimmer (router)"
  fi

  wait_for "http://127.0.0.1:8081/health" 600 "Glimmer" "$ANSWER_PID" "$LOG_DIR/answer.log"
  if [ "$ONE_SERVER" != 1 ]; then
    wait_for "http://127.0.0.1:8082/health" 600 "Glimmer (router)" "$ROUTER_PID" "$LOG_DIR/router.log"
  fi
  echo "Glimmer is up."
else
  echo "GLIMMER_BACKEND=$BACKEND: no local models. Development mode, invented data only."
fi

if [ "$CHECKER" = lfm ]; then
  mkdir -p "$LOG_DIR" && chmod 700 "$LOG_DIR"
  "$ROOT/scripts/start_checker.sh" >"$LOG_DIR/checker.log" 2>&1 &
  CHECKER_PID=$!
  PIDS="$PIDS $CHECKER_PID"
  require "$CHECKER_PID" "the checker (LFM3-VL-2B)"
  wait_for "http://127.0.0.1:8083/health" 300 "the checker (LFM3-VL-2B)" "$CHECKER_PID" "$LOG_DIR/checker.log"
  echo "The checker is up."
fi

# Optional helpers go through keep_running (scripts/supervise.sh), never require.
if [ "$EMBEDDINGS" = 1 ]; then
  mkdir -p "$LOG_DIR" && chmod 700 "$LOG_DIR"
  : >"$LOG_DIR/embedder.log"
  keep_running "the embedder" "$LOG_DIR/embedder.log" "$ROOT/scripts/start_embedder.sh" &
  PIDS="$PIDS $!"
  if wait_up "http://127.0.0.1:8084/health" 120; then
    echo "The embedder is up."
  else
    echo "The embedder did not answer within 120s; search uses keywords only until it does. See $LOG_DIR/embedder.log"
  fi
fi

if port_busy "$APPROVAL_PORT"; then die "something already answers on 127.0.0.1:$APPROVAL_PORT; stop it first"; fi
echo "Starting Muse Privacy"
(cd "$ROOT" && exec "$PY" -m base) &
APP_PID=$!
PIDS="$PIDS $APP_PID"
require "$APP_PID" "Muse Privacy (the approval page and connector)"
wait_for "http://127.0.0.1:$APPROVAL_PORT/health" 60 "Muse Privacy" "$APP_PID" "the output above"

if [ -n "$RELAY" ] && [ -f "$HOME_DIR/relay.json" ]; then
  mkdir -p "$LOG_DIR" && chmod 700 "$LOG_DIR"
  : >"$LOG_DIR/relay.log"
  (cd "$ROOT" && keep_running "the relay client" "$LOG_DIR/relay.log" "$PY" -m base.connector.relay_client run) &
  PIDS="$PIDS $!"
  echo "Connecting to the relay."
elif [ -n "$RELAY" ]; then
  echo "This device is not linked yet. See docs/MUSE_SETUP.md."
fi
if command -v caffeinate >/dev/null 2>&1; then
  # No idle sleep, and no system sleep on AC power, while this script runs. A closed lid still sleeps.
  caffeinate -i -s -w $$ &
  PIDS="$PIDS $!"
fi
echo "Muse Privacy is up: http://127.0.0.1:$APPROVAL_PORT (Ctrl-C stops it)"

watch_required
die "$STOPPED stopped; shutting the rest down (launchd starts everything again when installed)"
