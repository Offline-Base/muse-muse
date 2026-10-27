# Muse Privacy relay

A Cloudflare Worker that lets Muse, running in its cloud VM, reach the private workspace on the user's own device. The device dials out to the relay over a WebSocket, so nothing on the device listens on the network. Muse talks MCP over HTTPS to `/mcp` with an OAuth token, and the relay passes each request down that device's socket as a frame and returns the device's answer.

The relay forwards bytes. It never stores or logs a request or response body.

## Routes

| Route | Who calls it | What it does |
|---|---|---|
| `POST /device/register` | device, once | Body `{"name": "<label>"}` (optional, checked, not stored). Returns `{"device_id": "dev_...", "secret": "dev_....<random>"}` once. Only the SHA-256 of the secret is kept. At most 10 per IP per 10 minutes. |
| `POST /device/pair` | device | `Authorization: Bearer <secret>`. Returns `{"code": "ABCD2345", "expires_in": 600}`: 8 characters from `23456789ABCDEFGHJKLMNPQRSTUVWXYZ` (no 0, O, 1 or I). A new code voids the device's previous one. |
| `GET /device/connect` | device | WebSocket upgrade with `Authorization: Bearer <secret>`. A new connection closes the old one (close code 4000). |
| `GET /authorize` | the user, sent by Muse | Page that shows which app is asking and where access will go, and asks for the pairing code. |
| `POST /authorize` | the page's form | Checks the code, then completes the OAuth authorization with props `{deviceId}`. |
| `POST /mcp`, `DELETE /mcp` | Muse | OAuth bearer required. Forwarded to the device as a request frame. |
| `GET /mcp` | Muse | `405`: no server-initiated stream in v1. |
| `/oauth/register`, `/oauth/token`, `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource/mcp` | Muse | Served by `@cloudflare/workers-oauth-provider`: dynamic client registration, PKCE, refresh tokens (30 days), access tokens (1 hour). |

The device secret names its device (`dev_<32 hex>.<43 base64url>`), so the relay finds the device's Durable Object without a lookup table and then checks the secret's hash there in constant time. Clients should treat the secret as opaque.

## Frames

The full contract is "Relay frames" in `docs/CONTRACTS.md`. In short:

- Relay to device: `{"type": "request", "id": "<uuid>", "method": "POST" | "DELETE", "headers": {...}, "body": "<text>"}`. Headers are lowercase and only `content-type`, `accept`, `mcp-session-id` and `mcp-protocol-version`. The OAuth token never goes down.
- Device to relay: `{"type": "response", "id": "<same uuid>", "status": 200, "headers": {...}, "body": "<text>"}`. Only `content-type` and `mcp-session-id` are passed back to Muse. A status outside 200 to 599 becomes 502.
- `{"type": "ping"}` gets `{"type": "pong"}`. The exact text `{"type": "ping"}` (Python's `json.dumps` spelling) is answered by the runtime without waking the Durable Object; other spellings work too.
- No device socket: `503 {"error": "device offline"}`, also when the device drops while a request is waiting. No response frame within 60 seconds: `504 {"error": "device timeout"}`. More than 32 requests waiting on one device: `429 {"error": "device busy"}`. Request bodies over 4 MiB: `413`.

## Pairing

1. The device calls `POST /device/pair` and shows the code.
2. Muse sends the user to `/authorize`. The OAuth library validates the client and redirect URI and binds the page to this browser with a `__Host-` cookie.
3. The user types the code. The relay checks it before touching the consent handle, so a typo leaves the page usable.
4. Each code works once and expires after 10 minutes. There are at most 5 attempts per IP and 5 per code value in each 10 minute window; the sixth is refused even if the code is right.
5. The grant is stored with props `{deviceId}`, so its tokens only ever reach that device's Durable Object.

## What the relay keeps

| Where | What |
|---|---|
| `DeviceHub` Durable Object, one per device | `secret_sha256`. The live WebSocket, in memory. |
| `PairingGate` Durable Object, one instance | SHA-256 of each live code, its device id and expiry; attempt counters keyed by SHA-256 of the client IP or of the code tried, each with its window end. |
| `OAUTH_KV` | The OAuth library's clients, grants and tokens. Tokens are stored as hashes and grant props are encrypted. |

Pairing codes and counters live in a Durable Object rather than KV because KV is eventually consistent: two racing requests could both use one code, and counters could undercount. The Durable Object runs each check as one step.

Workers observability keeps errors only (`invocation_logs: false`), and the code has no `console` calls.

## Develop and test

```sh
cd relay
npm ci --legacy-peer-deps
npm test             # vitest in workerd via @cloudflare/vitest-pool-workers
npx tsc --noEmit
npm run dev          # wrangler dev on http://localhost:8787
```

Tests set `REQUEST_TIMEOUT_MS` to 400 so the timeout test is quick. The fake device in the tests is a real WebSocket opened through `/device/connect`.

## Deploy

```sh
npx wrangler login
./deploy.sh
```

`deploy.sh` creates the KV namespace if it is missing, writes its id into `wrangler.jsonc`, runs the type check and tests, and runs `wrangler deploy`. Then set `RELAY_URL` on the device to the Worker's address.

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

Compatibility date: 2026-08-22. `.npmrc` sets `legacy-peer-deps`.
