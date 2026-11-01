#!/usr/bin/env bash
# Deploy the Muse Privacy relay as its own Worker, "muse-privacy-relay".
#
#   npx wrangler login     # once
#   ./deploy.sh
#
# On the first run it creates the KV namespace the OAuth library uses (bound as OAUTH_KV) if it
# does not exist yet, and writes its id into wrangler.jsonc in place of REPLACE_WITH_OAUTH_KV_ID.
# Then it type checks, runs the tests and deploys. After the deploy, if the Worker has no
# PAIRING_PEPPER secret yet, it makes one with openssl and sets it with `wrangler secret put`.
# The value is never printed. Reruns reuse the same namespace and keep the same pepper.
set -euo pipefail
cd "$(dirname "$0")"

KV_TITLE="muse-privacy-relay-oauth"
PLACEHOLDER="REPLACE_WITH_OAUTH_KV_ID"
export WRANGLER_SEND_METRICS=false

command -v openssl >/dev/null || { echo "openssl is needed to make the pairing secret." >&2; exit 1; }
npx wrangler whoami >/dev/null 2>&1 || { echo "Sign in first: npx wrangler login" >&2; exit 1; }
npm ci --legacy-peer-deps --no-audit --no-fund

# Reads JSON from stdin (after any banner line) and prints the id of the KV namespace titled $1.
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

# Prints "yes" when the deployed Worker already has PAIRING_PEPPER, "no" when it does not, and
# fails when the list cannot be read or parsed, so a network error never rotates the pepper.
has_pepper() {
  local listed
  listed="$(npx wrangler secret list --format json)"
  printf '%s' "$listed" | node -e '
    let text = "";
    process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => {
      const names = JSON.parse(text.slice(text.indexOf("["))).map((secret) => secret.name);
      process.stdout.write(names.includes("PAIRING_PEPPER") ? "yes" : "no");
    });'
}

pepper_state="$(has_pepper)"  # a failed read stops the script here (set -e)
if [ "$pepper_state" = "no" ]; then
  # Until this finishes (a few seconds on the first deploy) the relay answers 503 to register and pair.
  echo "Setting the PAIRING_PEPPER secret (new random value, not shown)"
  openssl rand -hex 32 | npx wrangler secret put PAIRING_PEPPER >/dev/null
else
  echo "PAIRING_PEPPER is already set; keeping it"
fi

echo "Done. Check: curl https://<your workers.dev address>/.well-known/oauth-authorization-server"
echo "Then set RELAY_URL in the device's .env to that address."
