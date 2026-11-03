#!/usr/bin/env bash
# One command for the owner, from the main checkout (~/muse-muse), after `git pull origin main`:
#   bash scripts/overnight-demo.sh
# 0. turns on the demo switches in Production (RECIPES_ENABLED, AGENTS_ENABLED, VERIFY_AGENTS, AGENT_LONG_RUNS); Wonder stays off,
# 1. makes a new builder snapshot and sets BUILDER_SNAPSHOT_ID on Production and Preview,
# 2. makes sure .env.local and Production share an AUTOMATION_SECRET (creates one only if .env.local has none),
# 3. commits lib/sandbox/snapshots.json and pushes, which deploys Production, and waits for that deploy,
# 4. starts every demo build (scripts/demo-batch.ts).
# When it prints "you can close the laptop", the builds are running on Vercel. No secret is ever printed.
set -euo pipefail
SCOPE=ethan-6436s-projects
PROJECT=muse-muse
SITE=https://musemuse.dev
envset() { vercel env add "$1" --environment "$2" --value "$3" --force --project "$PROJECT" --scope "$SCOPE" --yes >/dev/null; }

echo "== 0. Demo switches in Production (BUILDS_ON_CONTRIBUTOR untouched, so Wonder stays off)"
for f in RECIPES_ENABLED AGENTS_ENABLED VERIFY_AGENTS AGENT_LONG_RUNS; do
  vercel env add "$f" --environment production --value 1 --force --no-sensitive --project "$PROJECT" --scope "$SCOPE" --yes >/dev/null
  echo "$f=1"
done

echo "== 1. Builder snapshot (about 10 to 15 minutes)"
npm ci --no-audit --no-fund >/dev/null
npm run snapshot 2>&1 | tee "$HOME/snapshot.log"
SNAP=$(grep -o 'BUILDER_SNAPSHOT_ID=snap_[A-Za-z0-9]*' "$HOME/snapshot.log" | tail -1 | cut -d= -f2)
[ -n "$SNAP" ] || { echo "No snapshot id in the output. Nothing else was changed."; exit 1; }
for e in production preview; do envset BUILDER_SNAPSHOT_ID "$e" "$SNAP"; done
echo "BUILDER_SNAPSHOT_ID set to $SNAP"

echo "== 2. Automation key"
if grep -q '^AUTOMATION_SECRET=.\+' .env.local 2>/dev/null; then
  echo "AUTOMATION_SECRET is already in .env.local (it must match Production's)."
else
  NEW=$(openssl rand -hex 32)
  envset AUTOMATION_SECRET production "$NEW"
  printf '\nAUTOMATION_SECRET=%s\n' "$NEW" >> .env.local
  unset NEW
  echo "Made a new AUTOMATION_SECRET and saved it to .env.local and Production."
fi

echo "== 3. Commit the snapshot record and deploy"
BEFORE=$(curl -s "$SITE" | grep -o 'dpl_[A-Za-z0-9]*' | head -1 || true)
git add lib/sandbox/snapshots.json
git commit -qm "Builder snapshot $SNAP: /taste, design looks, recipe models, Meta skill guidance"
git push -q origin HEAD:main
echo "Pushed. Waiting for Production to deploy (usually 1 to 3 minutes)..."
for _ in $(seq 1 45); do
  sleep 20
  NOW=$(curl -s "$SITE" | grep -o 'dpl_[A-Za-z0-9]*' | head -1 || true)
  if [ -n "$NOW" ] && [ "$NOW" != "$BEFORE" ]; then echo "Deployed ($NOW)."; break; fi
done
[ "${NOW:-}" != "$BEFORE" ] || { echo "The deploy didn't show up in 15 minutes. Check Vercel, then run: npm run demo-batch"; exit 1; }

echo "== 4. Start the demo builds"
npm run demo-batch
