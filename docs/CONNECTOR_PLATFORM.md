# Meta's Muse Connector Platform

Muse Privacy, the privacy part of Muse Muse (`privacy/`), is the connector Offline Base submits to Meta's Muse Connector Platform (muse.ai/platform). This page points to everything needed. Written Nov 3, 2026. Nothing has been submitted yet.

| Need | Where |
|---|---|
| Every form answer, ready to paste, and how each Meta guideline is met | [privacy/docs/CONNECTOR_SUBMISSION.md](../privacy/docs/CONNECTOR_SUBMISSION.md) |
| Using it from Claude, ChatGPT, Codex, Muse Code and the Muse app | [privacy/docs/CONNECT_CLIENTS.md](../privacy/docs/CONNECT_CLIENTS.md) |
| Relay: read-only links, review codes, MCP 2026-07-28 headers | `privacy/relay/src/readonly.ts`, `pairing.ts`, `index.ts`; tests in `privacy/relay/test/` |
| Public pages the form links to | https://muse-privacy-ten.vercel.app/connector, /privacy, /terms (source: `privacy/site/`) |

Live as of Nov 3:

- Connector URL: `https://muse-privacy-relay.theethancastro.workers.dev/mcp` (Cloudflare Worker, version dccdcef8). It still runs on the owner's personal Cloudflare account; moving it to an Offline Base account or domain needs a domain on Cloudflare (offlinebase.com's DNS is on Vercel), and every client links again on the new URL.
- Support: team@offlinebase.com.
- Standalone repo: https://github.com/Offline-Base/muse-privacy, public since Nov 3.

Muse Muse itself has no platform-level connector to list: each product has its own MCP server (`/api/mcp/<slug>`), and `/api/build-mcp` is for builds only. Listing Muse Muse as a connector would need a new platform MCP server with OAuth.
