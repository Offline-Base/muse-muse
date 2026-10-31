# Agent tools: the contract

A product can use tools two ways, and every later unit builds on what this page fixes. Nothing here runs until
`AGENTS_ENABLED` is on and the units below land.

- **Meta's built-in `web_search`** goes through the gateway's `/v1/responses` route. It is the only general web search. It
  already runs several queries in one action, opens pages from its results and finds text in them.
- **Everything else** goes through Composio, behind the tool gateway at `{GATEWAY_URL}/tools`. One `COMPOSIO_API_KEY` lives
  in the platform's environment. Products, sandboxes and browsers never see it, and neither does a session's MCP URL.

The routes are provider-neutral, so nothing a product sees names Composio.

## Tool ids

`lib/tools/catalog.source.ts` is the one list, and `lib/tools/ids.ts` reads its ids from there. `lib/tools/composio/catalog.json`
is what the sync generated from it.

| Tier | Ids |
|---|---|
| Public | `web_search` (built in), `scholar`, `places`, `events`, `read_page` |
| Personal, for the product's owner | `gmail_read`, `gmail_draft`, `gmail_send`, `calendar_read`, `calendar_add`, `slack_read`, `slack_search`, `slack_send` |

- **There is no `web_results` and no `news`.** Meta's search covers both.
- **Deep research** isn't a tool. It is a `deepResearch` helper in the template's `runAgent`, on Meta search only.
- **`read_page`** takes only URLs found in the person's own input, since Meta's `open_page` opens only URLs from its results.
- **Exa is on a denylist in code**, including through Composio. It stays off until Exa approves in writing.
- **Composio's tool finder, workbench and proxy tools are never exposed.** Meta's `tool_search` handles large tool sets.
- **Run `npm run tools:sync -- --check` before each deploy.** A pinned version only fixes the schema the model sees.

A token carries `agent` and one `tool:<id>` per tool the brief picked, in `allowedModels` (`AGENT_MARKER`, `toolMarker` and
`toolOfMarker`). A product's manifest can narrow that list, never widen it.

## Routes

| Method and path | Answers |
|---|---|
| `GET {GATEWAY_URL}/tools?ids=web_search,places&format=functions\|namespaced` | `{simulated, principal, toolSearch, tools:[{id, label, stepTitle, tier, access, builtin?, functions?, namespace?, connection?, confirm?}]}` |
| `POST {GATEWAY_URL}/tools/execute` with `{name, arguments, approval?, userInput?}` | See below |
| `GET {GATEWAY_URL}/tools/connections` | The current principal's connections |
| `POST {GATEWAY_URL}/tools/connect` with `{toolkit, returnTo}` | A link to connect an account |
| `POST {GATEWAY_URL}/tools/disconnect` with `{toolkit}` | Marks the connection revoked |
| `GET {PLATFORM_URL}/api/gateway/tools/callback` | Composio's callback. The browser arrives with no product token, so its `state` is HMAC-signed |
| `POST {GATEWAY_URL}/identity/owner` with `{code}` | Trades an owner code for a 12-hour owner session: `{session, expiresAt}` |
| `GET {PLATFORM_URL}/api/products/<slug>/owner-pass` | For the signed-in owner: mints a 5-minute code and redirects to `{liveUrl}/api/musemuse/owner?code=` |

- **`name`** is the function's name, which is its Composio slug, from the list route.
- **`userInput`** is the person's own words for this run, up to 64 KB. `read_page` needs it: the URL must appear in it, or
  the call is refused. Send it only with that tool.
- **Listing:** a tool the caller can't use (a personal tool for a visitor) is listed with its `connection` but no `functions`,
  so the model can't try it. With `format=namespaced` and more than 8 functions, the answer adds `toolSearch: true` and
  `namespaces`, ready for Meta's `tools` array, and each tool's `namespace` names its own. Add `{"type":"tool_search"}`.
- **Connect:** `{ok, url, simulated}`. Send the browser to `url`. A build gets `url: null` and a sample `connection`.
- **After connecting:** the browser lands on `{liveUrl}/api/musemuse/connected?toolkit=&returnTo=`, plus `&error=connect_failed`
  when it didn't work. `returnTo` is a checked path on the product. Redirect there.

`/tools/execute` answers one of:

```jsonc
{ "ok": true, "output": {}, "sources": [], "costUsd": 0.008, "simulated": false, "truncated": true } // truncated only when cut
{ "ok": false, "code": "needs_confirmation", "approval": { "id": "...", "title": "...", "lines": [] }, "stale": true } // stale only when one was sent
{ "ok": false, "code": "needs_connection", "toolkit": "gmail", "label": "Gmail", "canConnect": true }
```

The last two aren't errors. The status is 200 and the product shows a card. For a confirmation, the product's server repeats
the call with `approval`. An approval that doesn't fit (changed arguments, expired or already used) runs nothing and comes back
as a new `needs_confirmation` with `stale: true`, for the person to confirm again. An approval is spent when the call goes out,
so a rate limit doesn't burn one and a failed send needs a new one.

### Check order for execute

1. Bearer token, then product status.
2. The token has `agent` and `tool:<id>`, the manifest allows it, the tool isn't denied, and its tier's flag is on.
3. The principal's tier allows it.
4. Arguments: at most 16 KB, only what the catalog lists (others are refused, not dropped), required keys present, no private
   or localhost URLs. Then recipient rules, including aliases (Gmail's `to`, Slack's `channel_id`, Calendar's `attendees`),
   then confirmation.
5. Rate limits (`perMinute` and `perDay` from the catalog too), then an in-flight slot.
6. Budgets: the token's daily spend, `TOOLS_DAILY_SPEND_CAP_USD`, `TOOLS_DAILY_CALLS`, `DAILY_SPEND_CAP_USD` and the run's dollars.
7. Reserve the spend.
8. A build token gets a canned result. A live token gets its session (at most 15 seconds), then calls Composio with a 30-second
   timeout, no automatic retry and no `version`.
9. Settle, apply the catalog's `output` rules, extract sources, trim to 32 KB and answer.

Implemented by `handleTools` in `lib/tools/handler.ts`, with `TOOL_CHECKS` and the limits in `lib/tools/policy.ts`.

### What a call costs

`lib/tools/pricing.ts`. A reservation holds the list price plus Composio's call fee, then settles:

| Reply | Booked |
|---|---|
| `instantCharge.amount` above zero | The charge plus the $0.0003 call fee |
| A failure with no charge, or a charge of `"0.000000"` | $0, with one unit |
| Completed with no charge, as personal tools are | The estimate: the $0.0003 call fee plus the $0.0005 managed app fee |
| A timeout, a dropped connection or a 5xx | The estimate, because the tool may have run. A call aborted after 1 ms was still charged in the live check |
| A refusal (4302, 4310, 4324, 402, another 4xx) | Nothing. The reservation is deleted and the holds go back |

A failure can be `resultType: "failed"`, or `resultType: "completed"` with `data.success: false`, which is what an unreachable
page returns. Both answer `tool_failed`.

### The Composio SDK

`@composio/core` is pinned at 0.27.0 and asks for Node 22.22.3 or newer. Vercel runs this project on Node 24.x. A laptop on
22.22.2 gets npm's EBADENGINE warning and nothing else. `lib/tools/composio/client.ts` imports the SDK lazily and `next.config.ts`
keeps it out of the bundle, so nothing loads it until a live tool runs. Both Node versions were run live through these routes.
The route's traced files come to about 16 MB with the SDK in them. A session read back from Composio shows
`proxy_execution_enabled: false`, and its tools are only the ones it enabled, with no finder or workbench.

## Errors

In the gateway's usual `gatewayError` shape. `TOOL_ERRORS` in `lib/tools/ids.ts` has the list.

| Code | Status | Means |
|---|---|---|
| `invalid_arguments` | 400 | An argument isn't in the catalog, is too big or is missing |
| `tool_not_allowed` | 403 | Not on this product's list, denied, or its flag is off. Composio's 400 codes 4310 and 4324 also land here |
| `sign_in_required` | 403 | The tool needs the owner, and this isn't the owner |
| `rate_limited` | 429 | Too many calls |
| `run_limit` | 429 | This run used up its turns, tool calls or dollars |
| `budget_exceeded` | 429 | A daily budget is used up |
| `tool_failed` | 502 | The tool failed, in a plain message |
| `tools_paused` | 503 | Tools are off here. Composio's 402 `Metering_WalletBalanceExhausted` also lands here |

## Principals

`TOOL_PRINCIPALS` in `lib/tools/ids.ts`. Products have no sign-in yet, so access depends on who is asking.

| Principal | How the gateway knows | May use, for Nov 4 |
|---|---|---|
| `build` | The token's scope | Every tier, canned results only. Builds never call Composio |
| `product` | A product token, with no owner session | Public tools and Meta search |
| `visitor` | The `mm_vid` cookie, sent as `x-musemuse-visitor`. Weak: one browser, no recovery | The same as `product`. Used only for limits and `safety_identifier` |
| `owner` | A platform-signed session, sent as `x-musemuse-owner`, for 12 hours | Public tools, plus personal tools on the owner's own accounts |
| `user` | Platform sign-in, later | Personal tools per user, on the same code path |

- **Writes need a confirmation every time.** Deletes are never allowed. Anything with recipients is capped at 5 (Gmail's to, cc
  and bcc together, or a calendar event's attendees). Gmail send and Slack send are capped at 10 a day per product.
- **The owner pass belongs to whoever asked for it.** An admin acting as owner gets their own connection on that product, never the
  owner's mail. An expired or forged session just leaves the caller as a visitor.
- **Products under the shared guest account can't get owner passes.**
- **Composio user ids** are `"mm" + kind + "_" + base32(HMAC(key, kind:productId:subject)).slice(0, 32)`, so no id is shared
  across products. An owner connects Gmail once per product, on purpose.
- **Signing keys** come from `toolKey(label)` in `lib/tools/keys.ts`: one per use, derived from `TOOLS_SIGNING_SECRET` or else
  `GATEWAY_TOKEN_PEPPER`.

## Settings

All in `lib/env.ts` and `.env.example`.

| Variable | Default | Does |
|---|---|---|
| `AGENTS_ENABLED` | off | The writer may pick the agent target |
| `COMPOSIO_API_KEY` | none | Platform only |
| `COMPOSIO_PERSONAL_ENABLED` | off | Owner toolkits |
| `TOOLS_DAILY_SPEND_CAP_USD` | 10 | Composio has no cap, so this is the only one. 0 pauses tools |
| `TOOLS_DAILY_CALLS` | 3000 | Keeps the platform under Composio's 100k calls a month |
| `TOOLS_SIGNING_SECRET` | derived | Optional |
| `GATEWAY_WONDER_TPM` | 1,500,000 | Products' share of the team's Muse Wonder tokens per minute |

## Tables and usage

Migration `0013_agents`.

- **`tool_sessions`:** one per product and Composio user. A session is updated when its config's hash changes.
- **`tool_connections`:** a partial unique index keeps one active row per product, user and toolkit. Disconnecting sets
  `revoked_at`. Only Composio's id for the account is stored, never a credential.
- **`builds.tool_fixtures`:** canned outputs by Composio slug. The fixture is `hash(normalized args) % n`, so a verify run gets
  the same output each time.
- **`usage.units`:** what a call counts in besides tokens: searches on a Meta call, 1 on a tool call. `recordUsage` and
  `settleSpend` keep a row at $0 when it has units.
- **Tool calls** are `usage` rows with `source: "tools"`, `endpoint: "tools/execute"` and `model: "composio:<SLUG>"`.
- **`TOOLS_DAILY_CALLS` and `perDay`** are `rate_limits` counters whose window is the next UTC midnight. The hourly cleanup deletes
  windows that started over an hour ago, so a window starting at today's midnight would reset every hour. Builds never count.
- **Cleanup:** with `AGENTS_ENABLED` on, the hourly cron deletes the connected accounts of products that are disabled or failed.

A product's tool rows don't go to the live site when a local product is promoted (`docs/NATIVE.md`). Canned outputs do.

## Data retention

Composio keeps tool payloads for up to a year without its paid zero data retention. Products say so, and it needs settling
before personal tools reach anyone but owners.
