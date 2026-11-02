#!/bin/bash
# Checks the iPhone Simulator (S2), the emulator (S1) and the mock glasses (glasses S2) on the shell builds already on the
# box, against the local stand-in. It accepts nothing and spends nothing. Clips and reports go to ~/musemuse-lab/checks/<time>/
# and the lab's bucket. It carries on past a failed check and exits nonzero if any failed. Run it as ec2-user.
# See docs/NATIVE_LAB.md, "Checking the phone kinds".
#
#   bash setup/mac-checks.sh [out-dir]
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
ROOT="$HOME/musemuse-lab"
SHELLS="$ROOT/shells"
# The lab bucket is muse-knowledge-<account id>. The id is read from the box's own credentials, so it stays out of the repo.
BUCKET="s3://${MUSE_LAB_BUCKET:-muse-knowledge-$(aws sts get-caller-identity --query Account --output text 2>/dev/null)}"
TARGET="${MUSE_LAB_CHECK_TARGET:-https://muse-muse.vercel.app/}"
OUT="${1:-$ROOT/checks/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$OUT"
exec > >(tee -a "$OUT/checks.log") 2>&1
export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/opt/openjdk@17/bin:/opt/homebrew/bin:/opt/homebrew/share/android-commandlinetools/platform-tools:/opt/homebrew/share/android-commandlinetools/emulator:$PATH"

status=0
check() {
  kind="$1"; app="$2"; shift 2
  echo; echo "== Checking $kind"
  if [ ! -s "$app" ]; then
    echo "Missing $app. See docs/NATIVE_LAB.md, \"What's on the boxes\"."
    status=1
    return
  fi
  node "$HERE/tools/check.mjs" --kind "$kind" --app "$app" --out "$OUT/$kind" "$@" || status=1
}

check ios_sim "$SHELLS/lab-ios-sim.tar.gz" --target "$TARGET"
check android_emu "$SHELLS/lab-android.apk" --target "$TARGET"
# The live site isn't a glasses product, so this one uses a small page that keeps the glasses template's contract. The bucket
# isn't public, so it's a signed address, short-lived and able to read only that page. Nothing here prints it.
GLASSES_PAGE="$(aws s3 presign "$BUCKET/lab/shells/glasses-check.html" --expires-in 1800)"
check glasses_sim "$SHELLS/glasses-ios-sim.tar.gz" --photo "$SHELLS/mock-photo.jpg" --target "$GLASSES_PAGE"

aws s3 cp --recursive --only-show-errors --exclude "*/root/*" "$OUT" "$BUCKET/lab/checks/$(basename "$OUT")/" || echo "The upload to S3 failed. The files are in $OUT."
echo; echo "Results are in $OUT and $BUCKET/lab/checks/$(basename "$OUT")/."
exit "$status"
