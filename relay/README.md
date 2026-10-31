# Muse Privacy relay

A Cloudflare Worker that lets Muse, running in its cloud VM, reach the private workspace on the user's own device. The device dials out to the relay over a WebSocket, so nothing on the device listens on the network. Muse talks MCP over HTTPS to `/mcp` with an OAuth token, and the relay passes each request down that device's socket as a frame and returns the device's answer.

The relay forwards bytes. It never stores or logs a request or response body.

## Routes

| Route | Who calls it | What it does |
|---|---|---|
| `POST /device/register` | device, once | Body `{"name": "<label>"}` (optional, checked, not stored). Returns `{"device_id": "dev_...", "secret": "dev_....<random>"}` once. Only the SHA-256 of the secret is kept. At most 10 per IP per 10 minutes. |
| `POST /device/pair` | device | `Authorization: Bearer <secret>`. Returns `{"code": "ABCD2345", "expires_in": 600}`: 8 characters from `23456789ABCDEFGHJKLMNPQRSTUVWXYZ` (no 0, O, 1 or I). A new code voids the device's previous one. |
| `POST /device/unlink` | device | `Authorization: Bearer <secret>`. Revokes every OAuth grant bound to this device and returns `{"revoked": n}`. Run it with `python -m base.connector.relay_client unlink` after a pairing code was shared by mistake. |
| `GET /device/connect` | device | WebSocket upgrade with `Authorization: Bearer <secret>`. A new connection closes the old one (close code 4000), and the Python client stops when that happens to it. |
| `GET /authorize` | the user, sent by Muse | Page that shows which app is asking and where access will go, and asks for the pairing code. |
| `POST /authorize` | the page's form | Checks the code, then completes the OAuth authorization with props `{deviceId}`. |
| `POST /mcp`, `DELETE /mcp` | Muse | OAuth bearer required. Forwarded to the device as a request frame. |
| `GET /mcp` | Muse | `405`: no server-initiated stream in v1. |
| `/oauth/register`, `/oauth/token`, `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource/mcp` | Muse | Served by `@cloudflare/workers-oauth-provider`: dynamic client registration, PKCE (S256 only), refresh tokens (30 days), access tokens (1 hour). |

Muse's client can identify itself either way the MCP spec allows, since we have not seen which one it uses:

- **Dynamic client registration (DCR)**: it posts its name and redirect URI to `/oauth/register` and gets a `client_id`.
- **Client ID Metadata Document (CIMD)**: its `client_id` is an https URL that serves its metadata. The OAuth library fetches and checks that document. This needs the `global_fetch_strictly_public` compatibility flag (set in `wrangler.jsonc`), which keeps that fetch on the public internet. The metadata advertises `client_id_metadata_document_supported: true` only when both are on.

The device secret names its device (`dev_<32 hex>.<43 base64url>`), so the relay finds the device's Durable Object without a lookup table and then checks the secret's hash there in constant time. Clients should treat the secret as opaque.

## Frames

The full contract is "Relay frames" in `docs/CONTRACTS.md`. In short:

- Relay to device: `{"type": "request", "id": "<uuid>", "method": "POST" | "DELETE", "headers": {...}, "body": "<text>"}`. Headers are lowercase and only `content-type`, `accept`, `mcp-session-id` and `mcp-protocol-version`. The OAuth token never goes down.
- Device to relay: `{"type": "response", "id": "<same uuid>", "status": 200, "headers": {...}, "body": "<text>"}`. Only `content-type` and `mcp-session-id` are passed back to Muse. A status outside 200 to 599 becomes 502.
- On the device, the relay client sends each request to the local connector with its own token and the header `x-muse-privacy-via: relay`, so the device's audit log can tell relayed calls from local ones. A frame's own headers are filtered first, so a frame cannot set it.
- `{"type": "ping"}` gets `{"type": "pong"}`. The exact text `{"type": "ping"}` (Python's `json.dumps` spelling) is answered by the runtime without waking the Durable Object; other spellings work too.
- No device socket: `503 {"error": "device offline"}`, also when the device drops while a request is waiting. No response frame within 60 seconds: `504 {"error": "device timeout"}`. More than 32 requests waiting on one device: `429 {"error": "device busy"}`. Request bodies over 4 MiB: `413`.
- A `tools/call` gets a tool result Muse can read instead of those errors (`src/toolresult.ts`). When the device is offline (503, or 502 from a device whose app is not running), took too long (504) or is busy (429), and the body is one JSON-RPC `tools/call` with an id, the relay answers `200` with `{"jsonrpc": "2.0", "id": <the same id>, "result": {"content": [{"type": "text", "text": ...}], "isError": true}}` and one fixed sentence, for example "The user's Muse Privacy device is offline right now (asleep, or the app is not running), so nothing was shared. Ask the user to wake the device and try again." `initialize`, `tools/list`, notifications and batches keep the status codes above. To do this the relay reads only the body's `method` and `id`, and only on those failures; it still never stores or logs a body.

## Pairing

1. The device calls `POST /device/pair` and shows the code.
2. Muse sends the user to `/authorize`. The OAuth library validates the client and redirect URI and binds the page to this browser with a `__Host-` cookie.
3. The user types the code. The relay checks it before touching the consent handle, so a typo leaves the page usable.
4. Each code works once and expires after 10 minutes. In each 10 minute window there are at most 5 tries of one code value (from any IP) and at most 20 tries from one IP. The second limit is 20, not 5, so a classroom or office behind one NAT can pair several devices, typos included. Past either limit the try is refused even if the code is right.
5. The grant is stored with props `{deviceId}`, so its tokens only ever reach that device's Durable Object.
6. To cut Muse off (a phished code, a lost session): `python -m base.connector.relay_client unlink` revokes every grant for the device; pair again to reconnect. If the device secret itself may be stolen, `python -m base.connector.relay_client register --force` gives the device a new id and secret, which also ends every old link, and Muse must pair again.

Codes and client IPs are kept only as HMAC-SHA256 under `PAIRING_PEPPER`, a Worker secret of at least 32 characters. A copy of the relay's storage without that secret cannot be brute-forced back to live codes or IP addresses. Without the secret the relay refuses to register or pair (`503 {"error": "relay is not set up: PAIRING_PEPPER is missing"}`) and the authorize page says the relay is not set up. Changing the secret only voids codes that are still live and resets the attempt counters; linked apps keep working.

## What the relay keeps

| Where | What |
|---|---|
| `DeviceHub` Durable Object, one per device | `secret_sha256`. The live WebSocket, in memory. |
| `PairingGate` Durable Object, one instance | HMAC of each live code, its device id and expiry; attempt counters keyed by the HMAC of the client IP or of the code tried, each with its window end. |
| `OAUTH_KV` | The OAuth library's clients, grants and tokens. Tokens are stored as hashes and grant props are encrypted. CIMD documents are cached by the library in the Workers cache, not here. |
| Worker secret | `PAIRING_PEPPER`. |

Pairing codes and counters live in a Durable Object rather than KV because KV is eventually consistent: two racing requests could both use one code, and counters could undercount. The Durable Object runs each check as one step.

Workers observability keeps errors only (`invocation_logs: false`), and the code has no `console` calls.

## Develop and test

```sh
cd relay
npm ci --legacy-peer-deps
npm test             # vitest in workerd via @cloudflare/vitest-pool-workers
npx tsc --noEmit
```

Tests set `REQUEST_TIMEOUT_MS` to 400 so the timeout test is quick, and a test-only `PAIRING_PEPPER` (both in `vitest.config.ts`). The fake device in the tests is a real WebSocket opened through `/device/connect`. CIMD tests serve the metadata document from a stub, so nothing goes to the network.

To run the Worker on this machine, give it a pepper in `relay/.dev.vars` (gitignored) first:

```sh
printf 'PAIRING_PEPPER=%s\n' "$(openssl rand -hex 32)" > .dev.vars
npx wrangler dev --local --ip 127.0.0.1 --port 8796
```

### End to end with the Python device

`tests/test_relay_e2e.py` runs the whole path on this machine: `npx wrangler dev --local` on 127.0.0.1:8796 (override with `RELAY_E2E_PORT`) with a throwaway pepper in a temp `.dev.vars` and temp state, the real connector app with fake services that tag an invented name, the real relay client (register, pair, run), and httpx playing Muse (OAuth discovery, DCR, the authorize page with the pairing code and PKCE, the token exchange, then MCP `initialize`, `tools/list` and `tools/call` through `POST /mcp`). It also checks that a pairing code cannot be used twice and that a second relay client with the same secret replaces the first.

```sh
# from the repo root
RUN_INTEGRATION=1 uv run pytest tests/test_relay_e2e.py -q   # as a test (skipped without RUN_INTEGRATION=1)
uv run python tests/test_relay_e2e.py                        # by hand, printing each step
```

Nothing is deployed and nothing listens beyond 127.0.0.1. The only outside call is wrangler's npm update check.

## Deploy

You need a Cloudflare account (the free plan is enough: SQLite Durable Objects are on it) and Node 22.

1. Sign in once. This opens a browser.

   ```sh
   cd relay
   npx wrangler login
   ```

2. Deploy.

   ```sh
   ./deploy.sh
   ```

   It does, in order:
   1. checks that you are signed in (`wrangler whoami`) and that `openssl` is installed;
   2. `npm ci --legacy-peer-deps`;
   3. on the first run, finds or creates the KV namespace `muse-privacy-relay-oauth` and writes its id into `wrangler.jsonc` in place of `REPLACE_WITH_OAUTH_KV_ID` (the id is not a secret; keep the edited file);
   4. `npx tsc --noEmit` and `npx vitest run`;
   5. `npx wrangler deploy`, which prints the Worker's address, `https://muse-privacy-relay.<your-subdomain>.workers.dev`. On a new account wrangler first asks you to pick the workers.dev subdomain;
   6. if the Worker has no `PAIRING_PEPPER` secret yet, makes one with `openssl rand -hex 32` and pipes it to `wrangler secret put PAIRING_PEPPER`. The value is never printed. Reruns keep the existing secret. On the very first deploy, register and pair answer 503 for the few seconds between steps 5 and 6.

3. Check it. Replace the address with the one wrangler printed.

   ```sh
   RELAY=https://muse-privacy-relay.<your-subdomain>.workers.dev
   curl -s "$RELAY/health"                                   # {"ok":true}
   curl -s "$RELAY/.well-known/oauth-authorization-server"   # shows registration_endpoint and "client_id_metadata_document_supported":true
   ```

## Connect a device and add the connector in Muse

On the device (laptop shown; on a Jetson the same commands run as the `muse-privacy-relay` service, see `deploy/jetson/README.md`), from the repo root:

1. Put the relay's address in `.env`:

   ```sh
   RELAY_URL=https://muse-privacy-relay.<your-subdomain>.workers.dev
   ```

2. Register the device once. This writes `BASE_HOME/relay.json` (mode 0600) with the device secret.

   ```sh
   uv run python -m base.connector.relay_client register --name "Laptop"
   ```

3. Start the connector and keep the device connected, in two terminals:

   ```sh
   uv run python -m base.server                          # approval page and connector on 127.0.0.1
   uv run python -m base.connector.relay_client run      # dials out to the relay, reconnects on its own
   ```

Then in Muse:

4. Open Muse's connector settings and add a custom (remote MCP) connector with this URL, including `/mcp`:

   ```
   https://muse-privacy-relay.<your-subdomain>.workers.dev/mcp
   ```

   Leave any client ID and client secret fields empty: Muse registers itself (DCR) or names itself with its metadata document (CIMD).

5. Muse opens the relay's "Link your device" page. It shows the app's name and where access will go.

6. On the device, make a pairing code and type it on that page within 10 minutes:

   ```sh
   uv run python -m base.connector.relay_client pair
   ```

7. The page sends you back to Muse, which now lists the eight Muse Privacy tools. Linking again later needs a new code; a code works once.

If something goes wrong:

| What you see | What to do |
|---|---|
| Muse says the server is unavailable, or `/mcp` answers 503 `device offline` | Start `relay_client run` on the device (and `base.server`). A tool call while the device is offline gets the sentence "The user's Muse Privacy device is offline right now..." instead, once the relay with `src/toolresult.ts` is deployed. |
| "This relay is not set up yet" | `PAIRING_PEPPER` is missing: run `./deploy.sh` again. |
| "That code did not work" | Run `pair` again and type the new code; the old one is void. |
| "Too many tries" | Wait 10 minutes. |
| The relay client stops with "Another copy of this device connected" | Two copies are running with the same `relay.json`. Run one per device. |

## Versions

Pinned exactly in `package.json`:

| Package | Version |
|---|---|
| @cloudflare/workers-oauth-provider | 1.2.4 |
| @cloudflare/vitest-pool-workers | 0.22.0 (needs vitest 4 and a compatibility date no later than 2026-08-22) |
| vitest | 4.1.11 |
| wrangler | 4.147.0 |
| @cloudflare/workers-types | 5.20261002.1 |
| typescript | 5.9.3 |

Compatibility date: 2026-08-22. Compatibility flags: `global_fetch_strictly_public`. `.npmrc` sets `legacy-peer-deps`.
