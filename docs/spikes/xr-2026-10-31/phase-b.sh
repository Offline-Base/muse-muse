# Phase B: the Next.js template plus R3F, @react-three/xr and uikit, through next build and next start. Network: npm only.
export PATH="$HOME/.local/bin:$PATH" NPM_CONFIG_UPDATE_NOTIFIER=false NEXT_TELEMETRY_DISABLED=1 FORCE_COLOR=0
mkdir -p /tmp/out/b
cd /vercel/app || exit 9
echo "== B1 install"
SECONDS=0
npm install --no-audit --no-fund --loglevel=error --save-exact three@0.184.0 @react-three/fiber@9.8.2 @react-three/xr@6.6.32 @react-three/uikit@1.0.78 iwer@2.7.0 @iwer/devui@2.7.0 2>&1 | tail -6
npm install --no-audit --no-fund --loglevel=error --save-exact --save-dev @types/three@0.184.1 2>&1 | tail -3
echo "install in $SECONDS s"; du -sh node_modules
echo "== B2 npm ls three"
npm ls three 2>&1 | head -40
echo "distinct three versions: $(npm ls three --all --parseable --long 2>/dev/null | grep -oE 'three@[^:]+' | sort -u | tr '\n' ' ')"
echo "== B3 local controller and hand models"
SECONDS=0
npm install --prefix /tmp/assets --no-audit --no-fund --loglevel=error @webxr-input-profiles/assets@1.0.20 2>&1 | tail -2
A=/tmp/assets/node_modules/@webxr-input-profiles/assets
mkdir -p public/xr/profiles
cp "$A/dist/profiles/profilesList.json" public/xr/profiles/
for p in meta-quest-touch-plus generic-hand generic-trigger; do cp -r "$A/dist/profiles/$p" public/xr/profiles/; done
du -sh public/xr/profiles; ls public/xr/profiles; node -e "console.log(require('$A/package.json').license)"; ls "$A" | head; echo "assets in $SECONDS s"
echo "== B4 overlay and patches"
cd /tmp/spike/phase-b/files && find . -type f -name '*.src' | while read -r f; do t="/vercel/app/${f%.src}"; mkdir -p "$(dirname "$t")"; cp "$f" "$t"; done
cd /vercel/app
printf '{ "channel": "chromium", "args": ["--enable-unsafe-swiftshader"] }\n' > scripts/browser.json
node /tmp/spike/phase-b/patch-template.mjs || exit 8
echo "== B5 next build"
SECONDS=0
./node_modules/.bin/next build 2>&1 | tail -25
echo "build exit ${PIPESTATUS[0]} in $SECONDS s"
node /tmp/spike/phase-b/bundle.mjs
echo "== B6 matrix under next start"
PORT=3150
(./node_modules/.bin/next start -p $PORT >/tmp/next-start.log 2>&1 &)
for i in $(seq 1 60); do curl -s -o /dev/null -m 2 "http://localhost:$PORT/" && break; sleep 1; done
curl -s -o /dev/null -w "page %{http_code} in %{time_total} s\n" "http://localhost:$PORT/"
SECONDS=0
cd /vercel/app && node /tmp/spike/phase-b/matrix.mjs $PORT 2>&1
echo "matrix exit $? in $SECONDS s"
pkill -f "next start -p $PORT" || true; pkill -f "next-server" || true; sleep 1
tail -5 /tmp/next-start.log
echo "chosen flags: $(tr -d '\n' < scripts/browser.json)"
[ -n "$XR_SKIP_MATRIX" ] && exit 0
echo "== B7 npm run verify"
SECONDS=0
node scripts/verify.mjs > /tmp/out/verify.log 2>&1
code=$?
echo "verify exit $code in $SECONDS s"
grep '^verify: ' /tmp/out/verify.log | cut -c1-240
tail -1 /tmp/out/verify.log | cut -c1-3000
cp -r test-results/judge /tmp/out/judge 2>/dev/null
tail -40 /tmp/out/verify.log | grep -v '^{"musemuse_verify' | cut -c1-300
exit 0
