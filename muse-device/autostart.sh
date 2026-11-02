#!/bin/bash
# Keeps this board's Muse server running, across power cuts too. Boards have no passwordless sudo, so cron runs this as the
# board's user, every minute. It starts the server if it's down and does nothing otherwise. The server listens on the local
# network, where the fleet leader forwards calls to it (routes/device.py in jetson-infra), and every call needs its token.
#
#   autostart.sh install    adds the cron line, leaving every other line alone, and runs once
#   autostart.sh            one check, which is what cron runs
set -u
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

STATE="$HOME/.muse-device"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=8765
# Boards have little disk, and the server logs every request.
MAX_LOG_BYTES=$((5 * 1024 * 1024))

if [ "${1:-}" = "install" ]; then
  line="* * * * * /bin/bash $HERE/autostart.sh"
  # A crontab that can't be read must not look empty: writing then would lose every other line, such as the fleet's.
  if ! current="$(crontab -l 2>&1)"; then
    case "$current" in
      "no crontab for"*) current="" ;;
      *) echo "Can't read the crontab, so it wasn't changed: $current" >&2; exit 1 ;;
    esac
  fi
  if ! printf '%s\n' "$current" | grep -qxF "$line"; then
    { [ -n "$current" ] && printf '%s\n' "$current"; echo "$line"; } | crontab - || { echo "Couldn't write the crontab." >&2; exit 1; }
  fi
fi

mkdir -p "$STATE"
# Only one check at a time. exec and 9>&- together keep the server from holding this lock for as long as it runs.
exec 9>"$STATE/autostart.lock"
flock -n 9 || exit 0

if [ -f "$STATE/server.log" ] && [ "$(stat -c %s "$STATE/server.log")" -gt "$MAX_LOG_BYTES" ]; then
  # The server appends, so a file cut to nothing carries on from the start.
  : > "$STATE/server.log"
fi
if ! pgrep -u "$(id -u)" -f "^python3 server\.py --host 0\.0\.0\.0 --port $PORT" > /dev/null; then
  (cd "$HERE" && exec setsid nohup python3 server.py --host 0.0.0.0 --port "$PORT" >> "$STATE/server.log" 2>&1 < /dev/null 9>&- &)
fi
exit 0
