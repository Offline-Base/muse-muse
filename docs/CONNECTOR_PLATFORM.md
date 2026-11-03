# Meta's Muse Connector Platform

Muse Privacy, the privacy part of Muse Muse (`privacy/`), is the connector Offline Base submits to Meta's Muse Connector Platform (muse.ai/platform). This page points to everything needed. Written Nov 3, 2026. Nothing has been submitted yet.

| Need | Where |
|---|---|
| Every form answer, ready to paste, and how each Meta guideline is met | [privacy/docs/CONNECTOR_SUBMISSION.md](../privacy/docs/CONNECTOR_SUBMISSION.md) |
| Using it from Claude, ChatGPT, Codex, Muse Code and the Muse app | [privacy/docs/CONNECT_CLIENTS.md](../privacy/docs/CONNECT_CLIENTS.md) |
| Relay (live, on Modal): read-only links, review codes, MCP 2026-07-28 headers, OAuth | `privacy/relay_modal/` (tests: `privacy/tests/test_relay_modal.py`); the retired Cloudflare version is `privacy/relay/` |
| Public pages the form links to | https://muse-privacy-ten.vercel.app/connector, /privacy, /terms (source: `privacy/site/`) |

Live as of Nov 3:

- Connector URL: `https://theethancastro--muse-privacy-relay.modal.run/mcp`, on Modal (a hackathon sponsor) since Nov 3 evening: `privacy/relay_modal/`, a Python port of `privacy/relay/` with its own OAuth 2.1 server, one always-on container and SQLite on a Modal Volume. Deploy with `privacy/relay_modal/deploy.sh` only (it stops the old container, or requests hang after a deploy); first-time secret setup is in `privacy/relay_modal/modal_app.py`. The Cloudflare relays (`privacy/relay/`, on the personal and Offline Base accounts) are retired.
- Support: team@offlinebase.com.
- Standalone repo: https://github.com/Offline-Base/muse-privacy, public since Nov 3.

Muse Muse itself has no platform-level connector to list: each product has its own MCP server (`/api/mcp/<slug>`), and `/api/build-mcp` is for builds only. Listing Muse Muse as a connector would need a new platform MCP server with OAuth.
