# Meta's Muse Connector Platform

Muse Privacy, the privacy part of Muse Muse (`privacy/`), is the connector Offline Base submits to Meta's Muse Connector Platform (muse.ai/platform). This page points to everything needed. Written Nov 3, 2026. Nothing has been submitted yet.

| Need | Where |
|---|---|
| Every form answer, ready to paste, and how each Meta guideline is met | [privacy/docs/CONNECTOR_SUBMISSION.md](../privacy/docs/CONNECTOR_SUBMISSION.md) |
| Using it from Claude, ChatGPT, Codex, Muse Code and the Muse app | [privacy/docs/CONNECT_CLIENTS.md](../privacy/docs/CONNECT_CLIENTS.md) |
| Relay: read-only links, review codes, MCP 2026-07-28 headers | `privacy/relay/src/readonly.ts`, `pairing.ts`, `index.ts`; tests in `privacy/relay/test/` |
| Public pages the form links to | https://muse-privacy-ten.vercel.app/connector, /privacy, /terms (source: `privacy/site/`) |

Live as of Nov 3:

- Connector URL: `https://muse-privacy-relay.offlinebase.workers.dev/mcp`, a Cloudflare Worker on Offline Base's own Cloudflare account (team@offlinebase.com) since Nov 3 evening. Deploy it from `privacy/relay/` with wrangler signed in as that account; put the account's OAuth KV namespace id in place of the placeholder in `wrangler.jsonc` only on the machine you deploy from (never commit it). The earlier address on the owner's personal account is retired.
- Support: team@offlinebase.com.
- Standalone repo: https://github.com/Offline-Base/muse-privacy, public since Nov 3.

Muse Muse itself has no platform-level connector to list: each product has its own MCP server (`/api/mcp/<slug>`), and `/api/build-mcp` is for builds only. Listing Muse Muse as a connector would need a new platform MCP server with OAuth.
