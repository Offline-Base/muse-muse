#!/bin/bash
# What the owner's yes to the Xcode and Android SDK licenses runs. It accepts them through setup/mac.sh, restarts the agent,
# then runs setup/mac-checks.sh. Run it as ec2-user. See docs/NATIVE_LAB.md. It ran on Oct 31, so a box that's already through
# it only needs mac-checks.sh.
set -uo pipefail

if [ "${MUSE_LAB_ACCEPT_LICENSES:-}" != "1" ]; then
  echo "This accepts the Xcode and Android SDK licenses, so it only runs with MUSE_LAB_ACCEPT_LICENSES=1, set by the owner." >&2
  exit 2
fi
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$HOME/musemuse-lab"
OUT="$ROOT/checks/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"
exec > >(tee -a "$OUT/finish.log") 2>&1

bash "$HERE/setup/mac.sh" || { echo "mac.sh failed. Fix it and run this again."; exit 1; }

launchctl kickstart -k "gui/$(id -u)/ai.musemuse.lab" || echo "The agent didn't restart. It will pick up the new tools within 5 minutes anyway."

bash "$HERE/setup/mac-checks.sh" "$OUT"
