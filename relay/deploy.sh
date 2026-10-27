#!/usr/bin/env bash
# Deploy the Muse Privacy relay as its own Worker, "muse-privacy-relay".
#
#   npx wrangler login     # once
#   ./deploy.sh
#
# On the first run it creates the KV namespace the OAuth library uses (bound as OAUTH_KV) if it
# does not exist yet, and writes its id into wrangler.jsonc in place of REPLACE_WITH_OAUTH_KV_ID.
# Then it type checks, runs the tests and deploys. Reruns reuse the same namespace.
set -euo pipefail
cd "$(dirname "$0")"

KV_TITLE="muse-privacy-relay-oauth"
PLACEHOLDER="REPLACE_WITH_OAUTH_KV_ID"

npx wrangler whoami >/dev/null 2>&1 || { echo "Sign in first: npx wrangler login" >&2; exit 1; }
npm ci --legacy-peer-deps --no-audit --no-fund

# The namespace id for KV_TITLE, or nothing. Looked up by title so reruns find the same one.
kv_id() {
  npx wrangler kv namespace list 2>/dev/null | node -e '
    let text = "";
    process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => {
      try {
        const found = JSON.parse(text.slice(text.indexOf("["))).find((ns) => ns.title === process.argv[1]);
        process.stdout.write(found ? found.id : "");
      } catch {}
    });' "$KV_TITLE"
}

if grep -q "$PLACEHOLDER" wrangler.jsonc; then
  id="$(kv_id)"
  if [ -z "$id" ]; then
    echo "Creating KV namespace $KV_TITLE"
    npx wrangler kv namespace create "$KV_TITLE" >/dev/null
    id="$(kv_id)"
  fi
  [ -n "$id" ] || { echo "Could not find the KV namespace id. Create it and put its id in wrangler.jsonc." >&2; exit 1; }
  sed -i.bak "s/$PLACEHOLDER/$id/" wrangler.jsonc && rm -f wrangler.jsonc.bak
  echo "OAUTH_KV is $KV_TITLE"
fi

npx tsc --noEmit
npx vitest run

echo "Deploying muse-privacy-relay"
npx wrangler deploy

echo "Done. Check: curl https://<your workers.dev address>/.well-known/oauth-authorization-server"
echo "Then set RELAY_URL in the device's .env to that address."
