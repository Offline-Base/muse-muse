#!/usr/bin/env bash
# Helpers scripts/start.sh sources to keep Muse Privacy up. Kept apart so tests can run them alone.
# Written for the bash 3.2 that macOS ships (launchd runs /bin/bash): no wait -n, no maps.
#
# Required processes (the models the answers need, the approval page and connector) are only
# watched: when one stops, start.sh stops everything, and launchd (scripts/install_login.sh)
# starts it all again. Optional helpers (the embedder, the relay client, any sidecar added later)
# are kept running instead, so one of them stopping never takes the app down.

REQUIRED=""  # one "pid name" per line

# require PID NAME: watch a required process.
require() {
  REQUIRED="$REQUIRED$1 $2
"
}

# watch_required: returns once a required process has stopped, with its name in STOPPED.
watch_required() {
  local pid name
  while sleep "${WATCH_EVERY:-2}"; do
    while read -r pid name; do
      [ -n "$pid" ] || continue
      if ! kill -0 "$pid" 2>/dev/null; then
        STOPPED="$name"
        return 0
      fi
    done <<EOF
$REQUIRED
EOF
  done
}

# keep_running NAME LOG COMMAND...: run an optional helper in the background with `&`. When it
# stops it is started again after RESTART_DELAY seconds (default 5), doubling each time up to
# RESTART_MAX_DELAY (default 300); after a run of 10 minutes or more the pause starts over. Exit
# status 3 means trying again cannot help (the relay client's answer when the relay refuses this
# device or another copy took over), so it stops trying and the rest keeps running. TERM stops
# the helper and this loop.
keep_running() {
  local name="$1" logfile="$2"
  shift 2
  local first="${RESTART_DELAY:-5}" max="${RESTART_MAX_DELAY:-300}"
  local delay="$first" child="" status started
  trap 'if [ -n "$child" ]; then kill "$child" 2>/dev/null; wait "$child" 2>/dev/null; fi; exit 0' TERM
  while :; do
    started=$SECONDS
    "$@" >>"$logfile" 2>&1 &
    child=$!
    status=0
    wait "$child" || status=$?
    child=""
    if [ "$status" -eq 3 ]; then
      printf 'start.sh: %s stopped and trying again cannot help (exit 3); the rest keeps running. See %s\n' \
        "$name" "$logfile" >&2
      return 0
    fi
    if [ $((SECONDS - started)) -ge 600 ]; then delay="$first"; fi
    printf 'start.sh: %s stopped (exit %s); starting it again in %ss. See %s\n' "$name" "$status" "$delay" "$logfile" >&2
    sleep "$delay" &
    child=$!
    wait "$child" || true
    child=""
    delay=$((delay * 2))
    if [ "$delay" -gt "$max" ]; then delay="$max"; fi
  done
}

# wait_up URL SECONDS [PID]: succeeds once URL answers, fails after SECONDS, or at once when PID
# (a keep_running loop) has stopped, since then nothing will answer (a helper that exited 3).
wait_up() {
  local url="$1" seconds="$2" pid="${3:-}" i=0
  while [ "$i" -lt "$seconds" ]; do
    if curl -fs -o /dev/null --max-time 2 "$url"; then return 0; fi
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then return 1; fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}
