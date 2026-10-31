#!/bin/bash
# Runs on the collector machine; deploy_collectors.py puts it there. Runs the TypeScript collectors in
# scripts/knowledge/sources side by side and copies what they make to S3 every 5 minutes.
#
#   collectors.sh <bucket> setup    Node, npm packages, cached pages from S3, the 5-minute loop (holds the lock: see deploy)
#   collectors.sh <bucket> tick     starts every collector whose current version hasn't started, then syncs
#   collectors.sh <bucket> status   what's running, what finished, how many documents
#
# Each collector is its own systemd unit, muse-collector-<name>, so it outlives the Systems Manager command that started
# it. A file changed while it runs is left alone and starts once the old run ends. A run that fails isn't retried until
# the file changes (or deploy_collectors.py --rerun). All units sit in one slice with a memory ceiling and a low CPU
# share, so they can't starve bulk.py, which runs outside it and is never touched from here.
set -u

BUCKET="$1"
COMMAND="$2"
NAME="${3:-}"

ROOT=/opt/muse
APP="$ROOT/app"
SELF="$APP/scripts/knowledge/aws/box/collectors.sh"
STATE="$ROOT/collectors/state"
LOGS="$ROOT/collectors/logs"
LOCK="$ROOT/collectors.lock"
SOURCES="$APP/.data/knowledge/sources"
SLICE=musecollectors.slice
S3="s3://$BUCKET/knowledge/corpus"
NODE_VERSION=v22.23.4
NODE_SHA256=b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406
NODE_DIR="$ROOT/node-$NODE_VERSION"
# Steps that reach the GitHub API, by part of their name, whether through gh or api.github.com: the machine holds no
# token and has no gh. They run from the Mac only: skipped here, and their output is never uploaded from here, so an S3
# copy made from the Mac stays as it is. Plain raw.githubusercontent.com reads need no token and stay here.
MAC_ONLY="meta-cookbooks github cvelist sdk-changelogs ecmascript whatwg kubernetes-blog react-blog django-releases acl-anthology openfootball nflverse"

export HOME=/root
export PATH="$NODE_DIR/bin:/usr/local/bin:/usr/bin:/bin"
export AWS_DEFAULT_REGION=us-east-1

setup() {
  mkdir -p "$STATE" "$LOGS" "$SOURCES/cache"
  if [ ! -x "$NODE_DIR/bin/node" ]; then
    local tmp
    tmp=$(mktemp -d)
    curl -sSfL -o "$tmp/node.tar.gz" "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.gz" || return 1
    echo "$NODE_SHA256  $tmp/node.tar.gz" | sha256sum -c --quiet - || return 1
    rm -rf "$NODE_DIR.partial"
    mkdir -p "$NODE_DIR.partial"
    tar -xzf "$tmp/node.tar.gz" -C "$NODE_DIR.partial" --strip-components=1 || return 1
    mv "$NODE_DIR.partial" "$NODE_DIR"
    rm -rf "$tmp"
  fi
  # The National Hurricane Center's Tropical Cyclone Reports are PDFs (science.ts).
  command -v pdftotext > /dev/null || dnf install -y -q poppler-utils || return 1
  cd "$APP" || return 1
  if ! cmp -s package.json "$STATE/package.json" || [ ! -x node_modules/.bin/tsx ]; then
    npm install --no-audit --no-fund --ignore-scripts --loglevel=error || return 1
    cp package.json "$STATE/package.json"
  fi
  aws s3 sync "$S3/cache/" "$SOURCES/cache/" --size-only --only-show-errors
  echo '{"note": "Raw responses the collectors fetched, named by a hash of the URL, so a rerun does not fetch them again. Private. Licenses and source URLs are in ../sources/MANIFEST.json."}' > "$SOURCES/cache/MANIFEST.json"
  if [ ! -f "/run/systemd/system/$SLICE" ]; then
    printf '[Slice]\nMemoryMax=24G\nCPUWeight=50\n' > "/run/systemd/system/$SLICE"
    systemctl daemon-reload
  fi
  systemctl is-active --quiet muse-collectors-loop ||
    systemd-run --quiet --unit=muse-collectors-loop --slice="$SLICE" --collect bash "$SELF" "$BUCKET" loop
}

loop() {
  while true; do
    bash "$SELF" "$BUCKET" tick
    sleep 300
  done
}

tick() {
  (
    flock 9
    for file in "$APP"/scripts/knowledge/sources/*.ts; do
      name=$(basename "$file" .ts)
      [ "$name" = common ] && continue
      grep -q 'runAll(' "$file" || continue
      systemctl is-active --quiet "muse-collector-$name" && continue
      hash=$(sha256sum < "$file" | cut -d' ' -f1)
      [ "$(cat "$STATE/$name.hash" 2>/dev/null)" = "$hash" ] && continue
      if systemd-run --quiet --unit="muse-collector-$name" --slice="$SLICE" --collect -p OOMPolicy=continue bash "$SELF" "$BUCKET" one "$name"; then
        echo "$hash" > "$STATE/$name.hash"
        rm -f "$STATE/$name.exit"
        date -u +%FT%TZ > "$STATE/$name.started"
      fi
    done
  ) 9>"$LOCK"
  sync_all -n
}

# Runs inside the collector's own unit. Always syncs at the end, so a finished run is in S3 at once.
one() {
  local log="$LOGS/$NAME.log" code
  cd "$APP" || return 1
  echo "=== start $(date -u +%FT%TZ) $(sha256sum < "scripts/knowledge/sources/$NAME.ts" | cut -c1-12)" >> "$log"
  SKIP_STEPS="${MAC_ONLY// /,}" NODE_OPTIONS=--max-old-space-size=8192 node_modules/.bin/tsx "scripts/knowledge/sources/$NAME.ts" >> "$log" 2>&1
  code=$?
  echo "$code" > "$STATE/$NAME.exit"
  echo "=== exit $code $(date -u +%FT%TZ)" >> "$log"
  sync_all -w1800
}

# One sync at a time: the 5-minute one skips if another is going (-n), a finishing run waits its turn (-w).
sync_all() {
  (
    flock "$1" 8 || exit 0
    local up=() down=() part
    for part in $MAC_ONLY; do
      up+=(--exclude "*$part*")
      down+=(--include "*$part*")
    done
    # The Mac's own output comes down so the manifest covers it; it never goes back up from here.
    aws s3 sync "$S3/sources/" "$SOURCES/" --exclude '*' "${down[@]}" --only-show-errors
    write_manifest
    # A file smaller than its S3 copy (a pause, failed fetches, a file still being written) doesn't replace it. It's named
    # in status. To accept a smaller file on purpose, delete the S3 copy from the Mac; this machine's role can't delete.
    local size key
    : > "$STATE/kept-larger"
    while read -r _ _ size key; do
      case "$key" in *.jsonl) ;; *) continue ;; esac
      if [ -f "$SOURCES/$key" ] && [ "$(stat -c %s "$SOURCES/$key")" -lt "$size" ]; then
        up+=(--exclude "$key")
        echo "$key: $(stat -c %s "$SOURCES/$key") bytes here, $size in S3" >> "$STATE/kept-larger"
      fi
    done < <(aws s3 ls "$S3/sources/")
    aws s3 sync "$SOURCES/" "$S3/sources/" --exclude 'cache/*' "${up[@]}" --only-show-errors
    aws s3 sync "$SOURCES/cache/" "$S3/cache/" --size-only --exclude '*.part' --only-show-errors
    status > "$LOGS/status.txt"
    aws s3 sync "$LOGS/" "$S3/logs/" --only-show-errors
  ) 8>"$LOCK.sync" >> "$LOGS/sync.log" 2>&1
}

write_manifest() {
  local manifest="$SOURCES/MANIFEST.json"
  [ -f "$manifest" ] && [ -z "$(find "$SOURCES" -maxdepth 1 -name '*.jsonl' -newer "$manifest")" ] && return 0
  python3 -I -c '
import collections, glob, json, os, sys, time
out = {"note": "Private until a release is reviewed. Each record carries its own license and visibility.", "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "datasets": {}}
for path in sorted(glob.glob(sys.argv[1] + "/*.jsonl")):
    n, sources, licenses, visibility, url = 0, collections.Counter(), collections.Counter(), collections.Counter(), None
    with open(path, encoding="utf8", errors="replace") as f:
        for line in f:
            try:
                r = json.loads(line)
            except ValueError:
                continue
            n += 1
            sources[r.get("source")] += 1
            licenses[r.get("license")] += 1
            visibility[r.get("visibility")] += 1
            url = url or r.get("url")
    out["datasets"][os.path.basename(path)] = {"documents": n, "sources": dict(sources.most_common(50)), "licenses": dict(licenses.most_common(50)), "visibility": dict(visibility), "exampleUrl": url}
print(json.dumps(out, indent=1))
' "$SOURCES" > "$STATE/MANIFEST.json" && mv "$STATE/MANIFEST.json" "$manifest"
}

status() {
  echo "at $(date -u +%FT%TZ)"
  local h name s last
  for h in "$STATE"/*.hash; do
    [ -e "$h" ] || continue
    name=$(basename "$h" .hash)
    if [ -f "$STATE/$name.exit" ]; then
      s="exit $(cat "$STATE/$name.exit")"
    elif systemctl is-active --quiet "muse-collector-$name"; then
      s=running
    else
      s=died
    fi
    [ "$(sha256sum < "$APP/scripts/knowledge/sources/$name.ts" | cut -d' ' -f1)" = "$(cat "$h")" ] || s="$s, newer version waiting"
    last=$(grep -v '^=== ' "$LOGS/$name.log" 2>/dev/null | tail -n 1 | cut -c1-160)
    echo "$name: $s, started $(cat "$STATE/$name.started" 2>/dev/null), last line: $last"
  done
  local f
  for f in "$SOURCES"/*.jsonl; do
    [ -e "$f" ] || continue
    echo "$(basename "$f"): $(wc -l < "$f") documents, $(du -h "$f" | cut -f1)"
  done
  [ -s "$STATE/kept-larger" ] && sed 's/^/S3 copy kept, it is larger: /' "$STATE/kept-larger"
  return 0
}

case "$COMMAND" in
  setup) setup ;;
  loop) loop ;;
  tick) tick ;;
  one) one ;;
  status) status ;;
  *) echo "unknown command $COMMAND" >&2; exit 2 ;;
esac
