#!/bin/bash
# What the owner's yes to the Xcode and Android SDK licenses runs. It accepts them through setup/mac.sh, restarts the agent,
# then checks the iPhone Simulator (S2), the emulator (S1) and the mock glasses (glasses S2) on the shell builds already on
# the box, against the local stand-in. Clips and reports go to ~/musemuse-lab/checks/<time>/ and the lab's bucket. It carries
# on past a failed check and exits nonzero if any failed. Run it as ec2-user. See docs/NATIVE_LAB.md, "When the owner says yes".
set -uo pipefail

if [ "${MUSE_LAB_ACCEPT_LICENSES:-}" != "1" ]; then
  echo "This accepts the Xcode and Android SDK licenses, so it only runs with MUSE_LAB_ACCEPT_LICENSES=1, set by the owner." >&2
  exit 2
fi
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$HOME/musemuse-lab"
SHELLS="$ROOT/shells"
BUCKET="s3://muse-knowledge-916979311153/lab/checks"
TARGET="${MUSE_LAB_CHECK_TARGET:-https://muse-muse.vercel.app/}"
OUT="$ROOT/checks/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"
exec > >(tee -a "$OUT/finish.log") 2>&1

bash "$HERE/setup/mac.sh" || { echo "mac.sh failed. Fix it and run this again."; exit 1; }
export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/opt/openjdk@17/bin:/opt/homebrew/bin:/opt/homebrew/share/android-commandlinetools/platform-tools:/opt/homebrew/share/android-commandlinetools/emulator:$PATH"

launchctl kickstart -k "gui/$(id -u)/ai.musemuse.lab" || echo "The agent didn't restart. It will pick up the new tools within 5 minutes anyway."

status=0
check() {
  kind="$1"; app="$2"; shift 2
  echo; echo "== Checking $kind"
  if [ ! -s "$app" ]; then
    echo "Missing $app. See docs/NATIVE_LAB.md, \"What's on the boxes\"."
    status=1
    return
  fi
  node "$HERE/tools/check.mjs" --kind "$kind" --app "$app" --target "$TARGET" --out "$OUT/$kind" "$@" || status=1
}

check ios_sim "$SHELLS/lab-ios-sim.tar.gz"
check android_emu "$SHELLS/lab-android.apk"
check glasses_sim "$SHELLS/glasses-ios-sim.tar.gz" --photo "$SHELLS/mock-photo.jpg"

aws s3 cp --recursive --only-show-errors --exclude "*/root/*" "$OUT" "$BUCKET/$(basename "$OUT")/" || echo "The upload to S3 failed. The files are in $OUT."
echo; echo "Results are in $OUT and $BUCKET/$(basename "$OUT")/."
exit "$status"
