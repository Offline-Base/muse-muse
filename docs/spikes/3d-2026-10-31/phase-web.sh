# Phase web: three.js and gltf-transform from npm through the build firewall, every GLB optimized two ways (meshopt and
# Draco, textures to WebP), then each loaded with three.js in headless Chromium on SwiftShader and screenshotted.
# Runs after phases render and muse, and takes whatever GLBs they left.
set -u
export PATH="$HOME/.local/bin:$PATH" NPM_CONFIG_UPDATE_NOTIFIER=false
OUT=/tmp/out/web
mkdir -p "$OUT/opt" /tmp/web
W=/tmp/spike/lib/web
now() { date +%s.%N; }
since() { awk -v a="$1" -v b="$(now)" 'BEGIN { printf "%.2f", b - a }'; }

echo "== W1 install ($SPIKE_FIREWALL)"
cd /tmp/web && printf '{"private":true}' > package.json
GT=$(npm view @gltf-transform/cli version 2>/dev/null)
echo "@gltf-transform/cli newest: ${GT:-unknown}"
t=$(now)
npm install --no-audit --no-fund --loglevel=error --save-exact three@0.184.0 "@gltf-transform/cli@${GT:-4}" 2>&1 | tail -5
echo "install in $(since "$t") s; $(du -sh node_modules | cut -f1) for $(ls node_modules | wc -l) top-level packages"
node -e "require('/tmp/web/node_modules/sharp'); console.log('sharp loads', require('/tmp/web/node_modules/sharp/package.json').version)" 2>&1 | tail -1
G=/tmp/web/node_modules/.bin/gltf-transform
echo "gltf-transform $($G --version 2>&1 | tail -1)"

echo "== W2 optimize"
mapfile -t GLBS < <(find /tmp/out/render /tmp/out/muse -name '*.glb' 2>/dev/null | sort)
for f in "${GLBS[@]}"; do
  n=$(basename "$f" .glb)
  echo "-- $n: $(stat -c %s "$f") bytes"
  $G inspect "$f" --format md > "$OUT/$n.inspect.md" 2>&1 || echo "inspect failed"
  for c in meshopt draco; do
    t=$(now)
    if $G optimize "$f" "$OUT/opt/$n-$c.glb" --compress "$c" --texture-compress webp > "$OUT/opt/$n-$c.log" 2>&1; then
      echo "$n $c+webp: $(stat -c %s "$OUT/opt/$n-$c.glb") bytes in $(since "$t") s"
    else
      echo "$n $c+webp failed: $(grep -iE 'error' "$OUT/opt/$n-$c.log" | head -2 | cut -c1-200 | tr '\n' ' ')"
      t=$(now)
      $G optimize "$f" "$OUT/opt/$n-$c.glb" --compress "$c" --texture-compress false > "$OUT/opt/$n-$c.log" 2>&1 \
        && echo "$n $c, textures as they were: $(stat -c %s "$OUT/opt/$n-$c.glb") bytes in $(since "$t") s" || echo "$n $c failed again"
    fi
  done
done

echo "== W3 three.js in headless Chromium"
(node $W/serve.mjs 3197 /tmp/web/node_modules/three > /tmp/web/serve.log 2>&1 &)
for i in $(seq 1 20); do curl -s -o /dev/null -m 1 http://127.0.0.1:3197/ && break; sleep 0.25; done
ITEMS=()
for f in "${GLBS[@]}"; do
  n=$(basename "$f" .glb)
  ITEMS+=("$n=/models/${f#/tmp/out/}")
  for c in meshopt draco; do [ -s "$OUT/opt/$n-$c.glb" ] && ITEMS+=("$n-$c=/models/web/opt/$n-$c.glb"); done
done
mkdir -p "$OUT/shots"
t=$(now)
node $W/shoot.mjs 3197 "$OUT/shots" "${ITEMS[@]}" 2>&1 | cut -c1-700
echo "shots in $(since "$t") s"
node /tmp/spike/lib/png-stats.mjs "$OUT"/shots/*.png
pkill -f "serve.mjs 3197" || true
exit 0
