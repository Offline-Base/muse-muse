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
| `POST {GATEWAY_URL}/tools/execute` with `{name, arguments, approval?}` | See below |
| `GET {GATEWAY_URL}/tools/connections` | The current principal's connections |
| `POST {GATEWAY_URL}/tools/connect` with `{toolkit, returnTo}` | A link to connect an account |
| `POST {GATEWAY_URL}/tools/disconnect` with `{toolkit}` | Marks the connection revoked |
| `GET {PLATFORM_URL}/api/gateway/tools/callback` | Composio's callback. The browser arrives with no product token, so its `state` is HMAC-signed |
| `POST {GATEWAY_URL}/identity/owner` with `{code}` | Trades an owner code for a 12-hour owner session |

`/tools/execute` answers one of:

```jsonc
{ "ok": true, "output": {}, "sources": [], "costUsd": 0.008, "simulated": false }
{ "ok": false, "code": "needs_confirmation", "approval": { "id": "...", "title": "...", "lines": [] } }
{ "ok": false, "code": "needs_connection", "toolkit": "gmail", "label": "Gmail", "canConnect": true }
```

The last two aren't errors. The status is 200 and the product shows a card. For a confirmation, the product's server repeats
the call with `approval`, and changed arguments fail the check.

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
8. A build token gets a canned result. A live token calls Composio with a 30-second timeout, no automatic retry and no `version`.
9. Settle at the reply's `instantCharge.amount`, apply the catalog's `output` rules, trim to 32 KB, extract sources and answer.

## Errors

In the gateway's usual `gatewayError` shape. `TOOL_ERRORS` in `lib/tools/ids.ts` has the list.

| Code | Status | Means |
|---|---|---|
| `invalid_arguments` | 400 | An argument isn't in the catalog, is too big or is missing |
| `tool_not_allowed` | 403 | Not on this product's list, denied, or its flag is off |
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

- **Writes need a confirmation every time.** Deletes are never allowed. Gmail send is capped at 5 recipients and 10 sends a day.
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

A product's tool rows don't go to the live site when a local product is promoted (`docs/NATIVE.md`). Canned outputs do.

## Data retention

Composio keeps tool payloads for up to a year without its paid zero data retention. Products say so, and it needs settling
before personal tools reach anyone but owners.
