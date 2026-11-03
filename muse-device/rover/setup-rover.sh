#!/bin/bash
# Sets Muse Rover up on an Arduino UNO Q in one go (docs/ROVER.md). Run it as root, which a fleet exec is, from the
# muse-device folder Muse Muse sends: muse-device/rover/setup-rover.sh. Safe to run again: each step checks what's there and
# changes only what isn't right yet, and a run keeps the pins an earlier one set unless it's given --reset.
#
#   setup-rover.sh [--pin role=PIN]... [--stop-mm N] [--invert left|right|pan|tilt]... [--reset] [--no-test]
#
# It writes ~/.muse-device/rover.json for the arduino user, adds that user to the router socket's group and to video,
# installs cron and GStreamer if they're missing, puts the muse-device server in ~/muse-device with its cron autostart,
# copies the Muse Rover app to ~/ArduinoApps/muse-rover with its config header, starts it and makes it the app the board
# starts at boot, restarts the server, and tests the rover through it. The test turns each wheel for a moment, so give the
# rover room. The first build of the sketch takes minutes. The whole run has one deadline, MUSE_ROVER_DEADLINE_S seconds
# (1500 unless set), which cuts each step's own time limit, so the report prints before an exec given 30 minutes gives up.
#
# Each step prints ok or why not, and the last line is MUSE_ROVER_REPORT and one JSON object, for a caller to find. It exits
# 0 only when every step is ok. It never reads or prints the board's token. It leaves the jetson-infra agent, the router's
# service and its config, and every Docker container alone, except that arduino-app-cli runs the app's own.
#
# Everything in the user's home is done as that user, through su, which also gives each command the groups added here.
set -u
PATH="$PATH:/usr/local/sbin:/usr/sbin:/sbin"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT="$(cd "$HERE/.." && pwd)"
ROVER_USER="${MUSE_ROVER_USER:-arduino}"
APP_ID=user:muse-rover
ROUTER_SOCKET=/var/run/arduino-router.sock
PORT=8765
LOCK_FILE="${MUSE_ROVER_LOCK:-/run/muse-rover-setup.lock}"
# The first build of a sketch on the board takes a few minutes, and the microcontroller restarts after it.
APP_START_TIMEOUT_S=900
APP_STOP_TIMEOUT_S=120
DEFAULT_APP_TIMEOUT_S=60
SKETCH_WAIT_S=90
SERVER_WAIT_S=20
SELF_TEST_TIMEOUT_S=180
# Every step's time limit is cut to what's left of the run's deadline, less MARGIN_S for the steps with no limit of their
# own (the copies, the server's restart) and the report.
DEADLINE_S="${MUSE_ROVER_DEADLINE_S:-1500}"
MARGIN_S=60

STEPS="$(mktemp)"
TEST_OUT="$(mktemp)"
APT_LOG="$(mktemp)"

# The report, however the script ends.
finish() {
  local code=1
  trap - EXIT
  if command -v python3 > /dev/null; then
    python3 - "$STEPS" "$TEST_OUT" << 'PY'
import json
import sys

steps = {}
with open(sys.argv[1], encoding="utf-8", errors="replace") as f:
    for line in f:
        name, _, result = line.rstrip("\n").partition("\t")
        steps[name] = result
test = None
try:
    with open(sys.argv[2], encoding="utf-8", errors="replace") as f:
        test = json.loads(f.read().strip().splitlines()[-1])
except (OSError, ValueError, IndexError):
    pass
ok = bool(steps) and all(result == "ok" or result.startswith("skipped") for result in steps.values())
print("MUSE_ROVER_REPORT " + json.dumps({"ok": ok, "steps": steps, "self_test": test}))
sys.exit(0 if ok else 1)
PY
    code=$?
  else
    echo 'MUSE_ROVER_REPORT {"ok": false, "steps": {"tools": "python3 is missing"}, "self_test": null}'
  fi
  rm -f "$STEPS" "$TEST_OUT" "$APT_LOG"
  exit "$code"
}
trap finish EXIT

# step <name> <ok, skipped: why, or why not>. Anything but ok or skipped fails the run.
step() {
  local result="${2//$'\n'/ }"
  result="${result//$'\t'/ }"
  printf '%s\t%s\n' "$1" "$result" >> "$STEPS"
  printf '%-12s %s\n' "$1:" "$result"
}

# Whether more than $1 seconds of the run's deadline are left, less the margin.
has_time() {
  [ $((DEADLINE_S - MARGIN_S - SECONDS)) -gt "$1" ]
}

# Runs a command for at most $1 seconds, or what's left of the run's deadline less the margin if that's less, and kills it
# 10 seconds later if it ignores being stopped. With nothing left it doesn't start it, since timeout 0 would mean no limit,
# and returns 124 as timeout does when it stops one.
within() {
  local limit="$1" left=$((DEADLINE_S - MARGIN_S - SECONDS))
  shift
  [ "$left" -lt "$limit" ] && limit="$left"
  [ "$limit" -gt 0 ] || return 124
  timeout -k 10 "$limit" "$@"
}

# A command line for as_user, each argument quoted once.
quote() {
  printf '%q ' "$@"
}

# Runs a command line in a login shell of the rover's user, which has every group added to it so far. Without the lock's
# descriptor: the server it starts would hold that for as long as it runs, and no later setup could take it.
as_user() {
  su - "$ROVER_USER" -c "$1" 8>&-
}

# as_user for at most $1 seconds, through within.
as_user_for() {
  within "$1" su - "$ROVER_USER" -c "$2" 8>&-
}

# The end of a command's output, on one line.
tail_of() {
  printf '%s' "$1" | tr '\n\t' '  ' | sed 's/ *$//' | tail -c 400
}

in_group() {
  id -nG "$ROVER_USER" | tr ' ' '\n' | grep -qxF "$1"
}

apt_install() {
  local apt=(env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=120)
  within 900 "${apt[@]}" install -y --no-install-recommends "$@" >> "$APT_LOG" 2>&1 && return 0
  # An image's package lists can be old or empty.
  within 600 "${apt[@]}" update >> "$APT_LOG" 2>&1 &&
    within 900 "${apt[@]}" install -y --no-install-recommends "$@" >> "$APT_LOG" 2>&1
}

CONFIG_ARGS=()
RUN_TEST=1
while [ $# -gt 0 ]; do
  case "$1" in
    --pin | --invert | --stop-mm)
      if [ $# -lt 2 ]; then
        step flags "$1 needs a value"
        exit 1
      fi
      CONFIG_ARGS+=("$1" "$2")
      shift 2
      ;;
    --reset) CONFIG_ARGS+=(--reset) && shift ;;
    --no-test) RUN_TEST=0 && shift ;;
    *)
      step flags "there is no flag $1: the top of setup-rover.sh lists them"
      exit 1
      ;;
  esac
done
case "$DEADLINE_S" in
  '' | *[!0-9]*)
    step flags "MUSE_ROVER_DEADLINE_S is $DEADLINE_S, which isn't a whole number of seconds"
    exit 1
    ;;
esac
DEADLINE_S=$((10#$DEADLINE_S))
OUT_OF_TIME="not tried: the run's ${DEADLINE_S}-second deadline (MUSE_ROVER_DEADLINE_S) was up"

if [ "$(id -u)" -ne 0 ]; then
  step root "run this as root, which a fleet exec is"
  exit 1
fi
exec 8>> "$LOCK_FILE"
if ! flock -n 8; then
  step lock "another setup-rover.sh is running on this board"
  exit 1
fi

for tool in python3 arduino-app-cli su usermod flock timeout; do
  if ! command -v "$tool" > /dev/null; then
    step tools "$tool is missing, so this doesn't look like an Arduino UNO Q"
    exit 1
  fi
done
step tools ok

if ! id "$ROVER_USER" > /dev/null 2>&1; then
  step user "there is no $ROVER_USER user on this board"
  exit 1
fi
ROVER_HOME="$(getent passwd "$ROVER_USER" | cut -d: -f6)"
STATE="$ROVER_HOME/.muse-device"
DEST="$ROVER_HOME/muse-device"
APP_DIR="$ROVER_HOME/ArduinoApps/muse-rover"
if ! as_user "$(quote test -r "$KIT/server.py") && $(quote test -r "$HERE/app/sketch/sketch.ino")" > /dev/null 2>&1; then
  step user "$ROVER_USER can't read the kit in $KIT: unpack it where anyone can read it, such as /tmp"
  exit 1
fi
step user ok

# 1. rover.json, which also checks every pin and limit before anything else changes.
if out="$(as_user "$(quote mkdir -p -m 700 "$STATE") && $(quote python3 "$HERE/rover_config.py" write "$STATE/rover.json" ${CONFIG_ARGS[@]+"${CONFIG_ARGS[@]}"})" 2>&1)"; then
  step config ok
  echo "             $(tail_of "$out")"
else
  step config "$(tail_of "$out")"
  exit 1
fi

# 2. The router's socket is root:arduino-router and mode 660, and the camera's node is video's.
groups_result=ok
socket_group="$(stat -c %G "$ROUTER_SOCKET" 2> /dev/null || true)"
if [ -z "$socket_group" ]; then
  groups_result="there is no router socket at $ROUTER_SOCKET, so arduino-router isn't running. This leaves its service alone"
elif [ "$socket_group" = root ]; then
  groups_result="the router's socket belongs to group root, and this won't add $ROVER_USER to root"
elif ! in_group "$socket_group" && ! usermod -aG "$socket_group" "$ROVER_USER"; then
  groups_result="couldn't add $ROVER_USER to $socket_group"
fi
if getent group video > /dev/null && ! in_group video && ! usermod -aG video "$ROVER_USER" && [ "$groups_result" = ok ]; then
  groups_result="couldn't add $ROVER_USER to video, so the camera may be out of reach"
fi
step groups "$groups_result"

# 3. cron for the server's autostart, and GStreamer for capture_image.
need=()
command -v crontab > /dev/null || need+=(cron)
if ! command -v gst-launch-1.0 > /dev/null; then
  need+=(gstreamer1.0-tools gstreamer1.0-plugins-good)
elif command -v gst-inspect-1.0 > /dev/null && ! gst-inspect-1.0 v4l2src > /dev/null 2>&1; then
  need+=(gstreamer1.0-plugins-good)
fi
if [ ${#need[@]} -eq 0 ]; then
  step packages ok
elif ! has_time 0; then
  step packages "$OUT_OF_TIME"
elif apt_install "${need[@]}"; then
  step packages ok
else
  step packages "couldn't install ${need[*]}: $(tail -n 3 "$APT_LOG" | tr '\n' ' ')"
fi

# 4. The server and what it needs, beside each other in ~/muse-device. Other files there are left as they are.
if [ "$KIT" -ef "$DEST" ]; then
  step files ok
elif out="$(as_user "$(quote mkdir -p "$DEST/rover") && $(quote cp "$KIT/server.py" "$KIT/autostart.sh" "$DEST/") && $(quote cp "$HERE/bridge_client.py" "$HERE/rover_config.py" "$HERE/selftest.py" "$DEST/rover/") && $(quote chmod 755 "$DEST/autostart.sh")" 2>&1)"; then
  step files ok
else
  step files "$(tail_of "$out")"
  exit 1
fi

# 5. The cron line that keeps the server up, as the user's own.
if command -v systemctl > /dev/null && ! systemctl is-active --quiet cron 2> /dev/null; then
  systemctl enable --now cron > /dev/null 2>&1 || true
fi
if ! out="$(as_user "$(quote /bin/bash "$DEST/autostart.sh" install)" 2>&1)"; then
  step autostart "$(tail_of "$out")"
elif others="$(as_user "crontab -l" 2> /dev/null | grep -F autostart.sh | grep -vF "$DEST/autostart.sh")"; then
  step autostart "another cron line also starts a server, and whichever starts first wins: $(tail_of "$others")"
else
  step autostart ok
fi

# 6. The app, with this rover's config header, then started. Starting it builds the sketch and flashes the microcontroller.
app_ok=0
if ! has_time 0; then
  step app "$OUT_OF_TIME"
elif ! out="$(as_user "$(quote mkdir -p "$APP_DIR") && $(quote cp -R "$HERE/app/." "$APP_DIR/") && $(quote python3 "$DEST/rover/rover_config.py" header "$STATE/rover.json" "$APP_DIR/sketch/rover_config.h")" 2>&1)"; then
  step app "couldn't copy the app to $APP_DIR: $(tail_of "$out")"
else
  as_user_for "$APP_STOP_TIMEOUT_S" "$(quote arduino-app-cli app stop "$APP_ID")" > /dev/null 2>&1 || true
  out="$(as_user_for "$APP_START_TIMEOUT_S" "$(quote arduino-app-cli app start "$APP_ID")" 2>&1)"
  code=$?
  if [ "$code" -eq 124 ]; then
    step app "arduino-app-cli ran out of time starting $APP_ID, at $APP_START_TIMEOUT_S seconds or the run's deadline: $(tail_of "$out")"
  elif [ "$code" -ne 0 ]; then
    step app "arduino-app-cli couldn't start $APP_ID: $(tail_of "$out")"
  else
    # Asked until it answers or SKETCH_WAIT_S is up, however long each try takes.
    sketch_by=$((SECONDS + SKETCH_WAIT_S))
    while :; do
      if out="$(as_user_for 15 "$(quote python3 "$DEST/rover/bridge_client.py" status)" 2>&1)"; then
        app_ok=1
        break
      fi
      [ "$SECONDS" -lt "$sketch_by" ] && has_time 3 || break
      sleep 3
    done
    if [ "$app_ok" -eq 1 ]; then
      step app ok
    elif [ "$SECONDS" -lt "$sketch_by" ]; then
      step app "the app started, but the run's deadline came before its sketch answered through the router: $(tail_of "$out")"
    else
      step app "the app started, but its sketch didn't answer through the router within $SKETCH_WAIT_S seconds: $(tail_of "$out")"
    fi
  fi
fi

# 7. The app the board starts at boot.
if [ "$app_ok" -ne 1 ]; then
  step default_app "not tried, since the app didn't start"
elif ! has_time 0; then
  step default_app "$OUT_OF_TIME"
elif as_user_for "$DEFAULT_APP_TIMEOUT_S" "$(quote arduino-app-cli properties set default "$APP_ID")" > /dev/null 2>&1 &&
  as_user_for "$DEFAULT_APP_TIMEOUT_S" "$(quote arduino-app-cli properties get default)" 2> /dev/null | grep -q muse-rover; then
  step default_app ok
else
  step default_app "arduino-app-cli didn't make $APP_ID the default, so the rover won't start it at boot"
fi

# 8. The server again, so it has the new files, the rover's tools and its new groups. autostart.sh starts it.
pattern="^python3 server\.py --host 0\.0\.0\.0 --port $PORT"
pkill -u "$ROVER_USER" -f "$pattern" 2> /dev/null
for _ in $(seq 1 20); do
  pgrep -u "$ROVER_USER" -f "$pattern" > /dev/null 2>&1 || break
  sleep 0.5
done
as_user "$(quote /bin/bash "$DEST/autostart.sh")" > /dev/null 2>&1
server_up=0
server_by=$((SECONDS + SERVER_WAIT_S))
while :; do
  if python3 -c "import socket; socket.create_connection(('127.0.0.1', $PORT), 1).close()" 2> /dev/null; then
    server_up=1
    break
  fi
  [ "$SECONDS" -lt "$server_by" ] || break
  sleep 1
done
if [ "$server_up" -eq 1 ]; then
  step server ok
else
  step server "the server didn't come up on port $PORT within $SERVER_WAIT_S seconds: see $STATE/server.log"
fi

# 9. The rover through the server, as Muse Muse will use it.
if [ "$RUN_TEST" -eq 0 ]; then
  step self_test "skipped: --no-test"
elif ! has_time 0; then
  step self_test "$OUT_OF_TIME"
else
  as_user_for "$SELF_TEST_TIMEOUT_S" "$(quote python3 "$DEST/rover/selftest.py" --port "$PORT")" > "$TEST_OUT" 2> /dev/null
  step self_test "$(python3 - "$TEST_OUT" << 'PY'
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8", errors="replace") as f:
        report = json.loads(f.read().strip().splitlines()[-1])
except (OSError, ValueError, IndexError):
    print("the self-test printed no report")
    sys.exit()
failed = [f"{name}: {result}" for name, result in report.get("checks", {}).items() if not result.startswith(("ok", "skipped"))]
print("ok" if report.get("ok") and not failed else "; ".join(failed) or "failed")
PY
)"
fi
exit 0
