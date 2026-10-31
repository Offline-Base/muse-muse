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

## In the brief

With `AGENTS_ENABLED` on, the writer's schema has `agent`, null for a product that isn't one:

```ts
agent: { task: string; tools: Array<{ id: ToolId; need: string; why: string }> /* 1 to 6 */; connections: "none" | "owner"; stepsPerRun: number }
```

- **The catalog** lists each tool with its tier and price, from `lib/tools/composio/catalog.json`, and Meta's search first. Personal
  tools appear only with `COMPOSIO_PERSONAL_ENABLED`. Tiers and prices go to the writer through `catalogSummary()`.
- **`applyTargets` settles it.** The agent target and the field always agree: a person's pick gets web search at least, and a
  dropped target drops the field. Tools with their flag off go. `connections` follows the tools. It adds Muse Wonder if it's missing
  and the owner-only limit. An agent target with no agent written gets one repair call first (`targetProblems`).
- **Tokens** carry `agent` and `tool:<id>`, through `allowedModelsFor`.
- **A stored brief's tool ids are plain strings**, since a tool can leave the catalog. `allowedModelsFor` skips ones it doesn't know.
- **Canned outputs.** `prepareToolFixtures` in `lib/tools/fixtures.ts` is one Muse Wonder call of about $0.04 at the fixtures step,
  only for read tools other than web search. It saves them to `builds.tool_fixtures`, and a refinement copies them. Each output must
  match the catalog sample's shape, and links and addresses off `example.com` are rewritten. If this fails, the build goes on, and
  each tool's catalog sample stands in.

## Routes

| Method and path | Answers |
|---|---|
| `GET {GATEWAY_URL}/tools?ids=web_search,places&format=functions\|namespaced` | `{simulated, principal, toolSearch, tools:[{id, label, stepTitle, tier, access, builtin?, functions?, namespace?, connection?, confirm?}]}` |
| `POST {GATEWAY_URL}/tools/execute` with `{name, arguments, approval?, userInput?}` | See below |
| `GET {GATEWAY_URL}/tools/connections` | The current principal's connections |
| `POST {GATEWAY_URL}/tools/connect` with `{toolkit, returnTo}` | A link to connect an account |
| `POST {GATEWAY_URL}/tools/disconnect` with `{toolkit}` | Removes every account this owner has on the toolkit at Composio, with or without a row, and marks the connection revoked. `ok` means they are gone |
| `GET {PLATFORM_URL}/api/gateway/tools/callback` | Composio's callback. The browser arrives with no product token, so its `state` is HMAC-signed, and it must be signed in to the platform as the person who started connecting |
| `POST {GATEWAY_URL}/identity/owner` with `{code}` | Trades an owner code for a 12-hour owner session: `{session, expiresAt}` |
| `GET {PLATFORM_URL}/api/products/<slug>/owner-pass` | For the signed-in owner: mints a 5-minute code and redirects to `{liveUrl}/api/musemuse/owner?code=` |

- **`name`** is the function's name, which is its Composio slug, from the list route.
- **`userInput`** is the person's own words for this run, up to 64 KB, and never tool output. `read_page` needs it: the URL must
  appear in it, or the call is refused. An email address in it authorizes no site. Send it only with that tool.
- **Listing:** a tool the caller can't use (a personal tool for a visitor) is listed with its `connection` but no `functions`,
  so the model can't try it. With `format=namespaced` and more than 8 functions, the answer adds `toolSearch: true` and
  `namespaces`, ready for Meta's `tools` array, and each tool's `namespace` names its own. Add `{"type":"tool_search"}`.
- **Connect:** `{ok, url, simulated}`. Send the browser to `url`. A build gets `url: null` and a sample `connection`.
- **After connecting:** the browser lands on `{liveUrl}/api/musemuse/connected?toolkit=&returnTo=`, plus `&error=connect_failed`
  when it didn't work. `returnTo` is a checked path on the product. Redirect there. A browser that isn't signed in as the person
  who started gets a plain page instead, and whatever account the attempt left is deleted. One live account stays per toolkit.

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

- **`approval.lines` is the whole call.** One line per argument, uncut, up to the 16 KB argument limit, with whitespace collapsed
  and anything invisible or that reorders text shown as `\uFFFD`. Show every line in full on the card, and let it scroll.
- **Only the card proves a person agreed.** The approval id goes back to the same product server that spends it, so the gateway
  can't tell a click from a server repeating the call by itself. The kit must wait for the person, and the judge should check that.
- **Everything a tool returns is untrusted data:** `output`, `sources` and every error message. Wrap all of it before a model sees
  it, and never send any of it as `userInput`.
- **`x-musemuse-run-id`:** send it on every call in a run. A call without it has only the daily limits.

### Check order for execute

1. Bearer token, then product status.
2. The token has `agent` and `tool:<id>`, the manifest allows it, the tool isn't denied, and its tier's flag is on.
3. The principal's tier allows it.
4. Arguments: at most 16 KB, only what the catalog lists (others are refused, not dropped), required keys present, no private
   or localhost URLs. Then recipient rules, including aliases (Gmail's `to`, Slack's `channel_id`, Calendar's `attendees`), then
   confirmation. Email addresses and Slack channels are plain ASCII, and a subject has no control or invisible characters. Gmail
   takes plain text only, so `is_html` isn't in the catalog.
5. The token's, visitor's and IP's rate limits, the catalog's `perDay`, then an in-flight slot.
6. Budgets: the token's daily spend, `TOOLS_DAILY_SPEND_CAP_USD`, `TOOLS_DAILY_CALLS`, `DAILY_SPEND_CAP_USD` and the run's dollars.
   Each call holds its estimate first, so calls at once can't share the last of a budget. Last come the limits every product
   shares (`perMinute` and the toolkit's), so a call that nothing would pay for can't use them up.
7. A live `read_page` resolves its host, and any private address refuses the call. Spend the approval and reserve the spend.
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
| `tool_failed` | 502 | The tool failed, in our own words. The provider's text stays in the server log, without tokens or addresses |
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
- **Cleanup:** with `AGENTS_ENABLED` on, the hourly cron deletes the connected accounts of products that are disabled or failed. It
  goes by `tool_sessions` as well as `tool_connections`, since every connect starts a session, and drops an owner's session once
  that owner's accounts are gone, so an account no row knows about goes too.

A product's tool rows don't go to the live site when a local product is promoted (`docs/NATIVE.md`). Canned outputs do.

## Data retention

Composio keeps tool payloads for up to a year without its paid zero data retention. Products say so, and it needs settling
before personal tools reach anyone but owners.

## The template's kit

`template/targets/agent/` is an overlay, laid out like `template/targets/glasses`: `files/` goes on top of the product, `platform-files.json`
lists what the product may not edit, and `deps.json` is empty because the kit adds no npm package. Only a product whose brief's
targets list `agent` gets it. How to use it is in `files/.agents/skills/muse-agent/SKILL.md`.

- **`lib/agent/run.ts`:** `runAgent` streams the events in `lib/agent/events.ts`, `agentResponse` is a route's reply, `agentAction` is an
  action's, and `runAgentToEnd` returns one value.
- **`lib/agent/research.ts`:** `deepResearch` plans, runs each narrow question as its own request one at a time on Meta search, and merges.
- **`lib/agent/state.ts`:** seals a stopped run, with a key from the product's token, for an hour.
- **`app/api/musemuse/[...path]/route.ts`:** the owner's link, sign-out, connections and the way back from connecting.
- **`components/agent/`:** `AgentRun`, `ConfirmCard`, `ConnectCard` and `SourceList`, in the meta-ui style.

Calls go out with `x-musemuse-run-id`, `x-musemuse-visitor` and `x-musemuse-owner`. Keep going starts a new run id, because that is the
person choosing to spend more. An answer to a confirm card stays on the same one. An action's budget is at most 100 s, inside the
connector's 120 s, and a connector can't see or call an action marked `who: "owner"`.
