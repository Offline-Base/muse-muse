#!/usr/bin/env bash
# Starts Muse Privacy at login and after a crash, using a LaunchAgent for this user only.
#
#   scripts/install_login.sh            install and start it
#   scripts/install_login.sh --remove   stop it and remove it
#
# Logs go to BASE_HOME/logs. Everything still binds 127.0.0.1. launchd starts scripts/start.sh
# again 30 s after it stops for any reason; start.sh stops on purpose when a required process
# stops (docs/UPTIME.md). After a restart of the Mac it starts once you log in.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="ai.offlinebase.muse-privacy"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
TARGET="gui/$(id -u)"

launchctl bootout "$TARGET/$LABEL" 2>/dev/null || true
if [ "${1:-}" = "--remove" ]; then
  rm -f "$PLIST"
  echo "Removed. Muse Privacy no longer starts at login."
  exit 0
fi

# The same logs folder start.sh uses (BASE_HOME/logs), read through base.config.
LOGS="$(cd "$ROOT" && "$ROOT/.venv/bin/python" -c 'from base.config import load_settings; print(load_settings().home / "logs")' 2>/dev/null || true)"
[ -n "$LOGS" ] || LOGS="$HOME/.base/logs"
mkdir -p "$HOME/Library/LaunchAgents" "$LOGS"
chmod 700 "$LOGS"
cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$ROOT/scripts/start.sh</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <!-- With no ProcessType launchd puts light limits on the job's CPU and disk use, which slows the models. -->
  <key>ProcessType</key><string>Interactive</string>
  <!-- launchd's own PATH has no Homebrew, where llama-server usually is. -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key><string>$LOGS/start.log</string>
  <key>StandardErrorPath</key><string>$LOGS/start.log</string>
</dict>
</plist>
PLIST
launchctl bootstrap "$TARGET" "$PLIST"
echo "Installed. Muse Privacy starts at login. Open http://127.0.0.1:8787/setup to finish."
