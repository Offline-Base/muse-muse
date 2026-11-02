#!/usr/bin/env bash
# Builds a Muse Muse product's Next standalone server for a linux/arm64 board (a Jetson Orin Nano), inside a Docker
# container on the Mac, and packs it with a run script. Nothing here touches a board: copy the tarball over yourself
# (docs/EDGE_DEMO.md). It is built so; it has not been run yet.
#
# Usage:
#   scripts/edge/build-arm64.sh <product-dir> [out-dir]
#
#   <product-dir>  the product's source, for example an unzipped /p/<slug>/code/source.zip
#   [out-dir]      default ./edge-out. Gets <name>-linux-arm64.tgz and the unpacked <name>/ folder.
#
# Env (written into the kit's run.sh as defaults; the board's own env wins when it runs):
#   EDGE_URL         default http://127.0.0.1:11435/v1, the board's llama-server
#   EDGE_FIRST       default 1: ask the board's model first
#   EDGE_MODEL       the served model's name, default "edge"
#   EDGE_BOARD       the label's board name, default "the edge board"
#   EDGE_MODEL_NAME  the label's model name, default EDGE_MODEL
#   GATEWAY_URL      optional. Unset means the product never tries the cloud. PRODUCT_TOKEN is never written into the
#                    kit: set it on the board yourself if GATEWAY_URL is set.
#   EDGE_PORT        default 3000, the port the product listens on
#   EDGE_BIND        default 0.0.0.0, the address it listens on
#   EDGE_NODE_IMAGE  default node:20-bullseye-slim (glibc 2.31, older than the board's Ubuntu 22.04)
#
# Exit codes: 0 built, 1 the build failed, 2 bad arguments or no Docker.
#
# It never copies .env files, node_modules or .next from the product, and never reads a secret.
set -euo pipefail

usage() {
  sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
}

if [[ $# -lt 1 || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  [[ $# -lt 1 ]] && exit 2 || exit 0
fi

SRC="$1"
OUT="${2:-./edge-out}"
if [[ ! -f "$SRC/package.json" ]]; then
  echo "build-arm64: $SRC has no package.json. Pass the product's source folder." >&2
  exit 2
fi
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "build-arm64: Docker isn't running. Start Docker Desktop and try again." >&2
  exit 2
fi

EDGE_URL="${EDGE_URL:-http://127.0.0.1:11435/v1}"
EDGE_FIRST="${EDGE_FIRST:-1}"
EDGE_MODEL="${EDGE_MODEL:-edge}"
EDGE_BOARD="${EDGE_BOARD:-the edge board}"
EDGE_MODEL_NAME="${EDGE_MODEL_NAME:-$EDGE_MODEL}"
GATEWAY_URL="${GATEWAY_URL:-}"
EDGE_PORT="${EDGE_PORT:-3000}"
EDGE_BIND="${EDGE_BIND:-0.0.0.0}"
IMAGE="${EDGE_NODE_IMAGE:-node:20-bullseye-slim}"

NAME="$(basename "$(cd "$SRC" && pwd)" | tr -c 'A-Za-z0-9._-\n' '-')"
mkdir -p "$OUT"
OUT_ABS="$(cd "$OUT" && pwd)"
rm -rf "${OUT_ABS:?}/$NAME" "$OUT_ABS/$NAME-linux-arm64.tgz"

for v in "$EDGE_URL" "$EDGE_FIRST" "$EDGE_MODEL" "$EDGE_BOARD" "$EDGE_MODEL_NAME" "$GATEWAY_URL" "$EDGE_PORT" "$EDGE_BIND"; do
  if [[ "$v" == *[\"\$\`\\]* ]]; then
    echo "build-arm64: a setting has a quote, dollar sign, backtick or backslash in it: $v" >&2
    exit 2
  fi
done

# The run script the kit carries. Each value sits in double quotes, which is why the check above refuses quote characters.
RUN_SH="$(mktemp)"
PATCH_JS="$(mktemp)"
trap 'rm -f "$RUN_SH" "$PATCH_JS"' EXIT
cat >"$PATCH_JS" <<'JS'
// Adds output: "standalone" to the product's Next config, or says plainly that it couldn't.
const fs = require("fs");
const file = ["next.config.ts", "next.config.mjs", "next.config.js"].find((f) => fs.existsSync(f));
if (!file) {
  fs.writeFileSync("next.config.mjs", 'export default { output: "standalone" };\n');
  process.exit(0);
}
const src = fs.readFileSync(file, "utf8");
if (/output:\s*["']standalone["']/.test(src)) process.exit(0);
const next = src.replace(/(NextConfig\s*=\s*\{)/, '$1\n  output: "standalone",');
if (next === src) {
  console.error(`Could not add output: "standalone" to ${file}. Add it by hand and run again.`);
  process.exit(1);
}
fs.writeFileSync(file, next);
JS
{
  echo '#!/usr/bin/env bash'
  echo '# Starts the product on the board. Every value below is only a default: the env you start it with wins.'
  echo 'set -euo pipefail'
  echo 'cd "$(dirname "$0")"'
  printf 'export EDGE_URL="${EDGE_URL:-%s}"\n' "$EDGE_URL"
  printf 'export EDGE_FIRST="${EDGE_FIRST:-%s}"\n' "$EDGE_FIRST"
  printf 'export EDGE_MODEL="${EDGE_MODEL:-%s}"\n' "$EDGE_MODEL"
  printf 'export EDGE_BOARD="${EDGE_BOARD:-%s}"\n' "$EDGE_BOARD"
  printf 'export EDGE_MODEL_NAME="${EDGE_MODEL_NAME:-%s}"\n' "$EDGE_MODEL_NAME"
  if [[ -n "$GATEWAY_URL" ]]; then
    printf 'export GATEWAY_URL="${GATEWAY_URL:-%s}"\n' "$GATEWAY_URL"
    echo '# PRODUCT_TOKEN is never in this kit. Without it the product skips the cloud and asks the board only.'
  else
    echo '# No GATEWAY_URL: the product never tries the cloud and asks the board only.'
  fi
  printf 'export PORT="${PORT:-%s}"\n' "$EDGE_PORT"
  printf 'export HOSTNAME="%s"\n' "$EDGE_BIND"
  echo 'export NODE_ENV=production NEXT_TELEMETRY_DISABLED=1'
  echo 'exec node server.js'
} >"$RUN_SH"

echo "Building $NAME for linux/arm64 in $IMAGE. This needs the internet once, for npm ci."

# The source goes in as a tar stream, so .env files never leave the Mac's folder and nothing is mounted read-write but
# the out folder.
tar -C "$SRC" --exclude=node_modules --exclude=.next --exclude='.env*' --exclude=test-results --exclude=playwright-report -cf - . |
  docker run --rm -i --platform linux/arm64 \
    --user "$(id -u):$(id -g)" \
    -e HOME=/tmp/home -e NEXT_TELEMETRY_DISABLED=1 -e NAME="$NAME" \
    -v "$OUT_ABS":/out \
    -v "$RUN_SH":/tmp/run.sh:ro \
    -v "$PATCH_JS":/tmp/standalone.cjs:ro \
    "$IMAGE" bash -c '
set -euo pipefail
mkdir -p /tmp/home /tmp/work
cd /tmp/work
tar -xf -
# Standalone output, unless the config already asks for it (the edge target sets it).
node /tmp/standalone.cjs
npm ci --no-audit --no-fund
npm run build
test -f .next/standalone/server.js || { echo "No .next/standalone/server.js after the build." >&2; exit 1; }
KIT="/out/$NAME"
mkdir -p "$KIT"
cp -a .next/standalone/. "$KIT/"
mkdir -p "$KIT/.next"
cp -a .next/static "$KIT/.next/static"
[ -d public ] && cp -a public "$KIT/public" || true
cp /tmp/run.sh "$KIT/run.sh"
chmod +x "$KIT/run.sh"
# No env file rides along, even one the build wrote.
find "$KIT" -maxdepth 2 -name ".env*" -delete
tar -C /out -czf "/out/$NAME-linux-arm64.tgz" "$NAME"
'

echo "Built $OUT_ABS/$NAME-linux-arm64.tgz"
echo "On the board: tar -xzf $NAME-linux-arm64.tgz && ./$NAME/run.sh   (docs/EDGE_DEMO.md)"
