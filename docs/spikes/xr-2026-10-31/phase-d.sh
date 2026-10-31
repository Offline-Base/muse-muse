# Phase D: a Demo Studio render of the scripted VR session, recorded the way the demo task does (lib/sandbox/tasks.ts).
export PATH="$HOME/.local/bin:$PATH" NPM_CONFIG_UPDATE_NOTIFIER=false NEXT_TELEMETRY_DISABLED=1 FORCE_COLOR=0
mkdir -p /tmp/out/d
cd /vercel/app || exit 9
ls .next/BUILD_ID || { echo "no build, phase B must pass its build first"; exit 7; }
sed -e 's#"@playwright/test"#"./demo-fixtures"#g' tests/smoke.spec.ts > tests/smoke.demo.spec.ts
echo "== D1 record"
SECONDS=0
./node_modules/.bin/playwright test tests/smoke.demo.spec.ts --project=studio --workers=1 2>&1 | tail -25
echo "record exit ${PIPESTATUS[0]} in $SECONDS s"
rm -f tests/smoke.demo.spec.ts
cat test-results/demo/recorder.log 2>/dev/null | head -20
cat > /tmp/xr-spec.json <<JSON
{ "title": "Box Room", "tagline": "Step into the room and pick the blue box.", "models": [], "url": null, "timeline": "/vercel/app/test-results/demo/timeline.json", "out": "/tmp/xd" }
JSON
echo "== D2 render"
SECONDS=0
node scripts/demo-studio.mjs --spec /tmp/xr-spec.json 2>&1 | tail -14 | cut -c1-600
echo "render exit ${PIPESTATUS[0]} in $SECONDS s"
echo "== D3 check"
ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate -show_entries format=duration,size -of compact /tmp/xd/demo.mp4
node /tmp/spike/phase-d/check.mjs
cp /tmp/xd/demo.mp4 /tmp/xd/poster.jpg /tmp/xd/studio.json /tmp/out/d/ 2>/dev/null
cp test-results/demo/timeline.json /tmp/out/d/ 2>/dev/null
exit 0
