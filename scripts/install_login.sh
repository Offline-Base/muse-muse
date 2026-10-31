#!/usr/bin/env bash
# Starts Muse Privacy at login and after a crash, using a LaunchAgent for this user only.
#
#   scripts/install_login.sh            install and start it
#   scripts/install_login.sh --remove   stop it and remove it
#
# Logs go to BASE_HOME/logs. Everything still binds 127.0.0.1.
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

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.base/logs"
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
  <key>StandardOutPath</key><string>$HOME/.base/logs/start.log</string>
  <key>StandardErrorPath</key><string>$HOME/.base/logs/start.log</string>
</dict>
</plist>
PLIST
launchctl bootstrap "$TARGET" "$PLIST"
echo "Installed. Muse Privacy starts at login. Open http://127.0.0.1:8787/setup to finish."
