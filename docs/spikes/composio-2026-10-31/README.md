# Composio spike, Oct 31, 2026

What Composio really does, checked against the live API for unit C0. The scripts here produced the files in `results/`. No keys are in either, and SerpAPI search paths and the Connect Link token are redacted.

**Result: Instant works on this org, and public tools can run on it.** Some of the plan's assumptions were wrong, listed below.

## Versions

- `@composio/core` **0.27.0**, pinned exactly. It pulls in `@composio/client` 2.0.0-rc.19. `1.0.0-beta.1` also exists, and we didn't use it.
- `@composio/core` needs Node 22.22.3 or newer. Unit T should check the Vercel runtime.
- The SDK isn't in `package.json` yet. The spike ran it from a scratch folder, because `node_modules` in a worktree is a shared symlink. Unit T adds it. The sync script uses plain `fetch` and doesn't need it.
- REST base: `https://backend.composio.dev/api/v3.1`, header `x-api-key`.

## Balance and spend

- Every paid call went through, and no 402 appeared. The API has no endpoint that reads the balance, so the amount left can only be seen on the dashboard. Composio's docs say balance checks are asynchronous and there is no built-in spend cap, so `TOOLS_DAILY_SPEND_CAP_USD` is the only cap we have.
- The documented refusal when the balance runs out is HTTP 402 `Metering_WalletBalanceExhausted`, with no fallback. We didn't see it, so its exact shape is unconfirmed.
- **Total spend: $0.058227 against the $1 cap**, matching `POST /project/usage/summary` (`instant_charge: 0.058227333335`). That summary was at exactly our first three calls when first read, so nothing else has spent on this project.

| Call | Latency | Charged |
|---|---|---|
| TAVILY_SEARCH | 1.4 s | $0.005000 |
| SERPAPI_NEWS_SEARCH | 2.3 s | $0.009167 |
| FIRECRAWL_SCRAPE | 0.5 s | $0.000798 |
| SERPAPI_SCHOLAR_SEARCH | 1.9 s | $0.009167 |
| SERPAPI_GOOGLE_MAPS_SEARCH | 1.6 s | $0.009167 |
| SERPAPI_EVENT_SEARCH | 10.4 s | $0.009167 |
| FIRECRAWL_SCRAPE, bad URL (failed) | 0.5 s | $0 |
| TAVILY_EXTRACT, not enabled (refused) | 0.2 s | $0 |
| FIRECRAWL_SCRAPE, session call with a bogus `version` | 0.5 s | $0.000798 |
| FIRECRAWL_SCRAPE, direct call at the latest version | 0.4 s | $0.000798 (only in the log) |
| GMAIL tools, not connected (refused, twice) | 0.2 s | $0 |
| TAVILY_SEARCH, tag filter test | n/a | $0.005000 |
| FIRECRAWL_SCRAPE, direct call at an older version (refused) | n/a | $0 |
| SERPAPI_EVENT_SEARCH, query that returns event cards | 2.2 s | $0.009167 |

The owner later removed Tavily and news from the catalog, because Meta's web_search is the only general web search. Those rows are what was spent before that.

## Sessions

This config is accepted, and all of it took effect except the tag filter:

```ts
composio.sessions.create(userId, {
  sessionPreset: SessionPreset.DIRECT_TOOLS, // "direct_tools"
  toolkits: { enable: ["serpapi", "firecrawl"] },
  tools: { serpapi: { enable: [...] }, firecrawl: { enable: [...] } },
  instant: { toolkits: { enable: ["serpapi", "firecrawl"] }, returnInstantCharge: true },
  manageConnections: { enable: false },
  sandbox: { enable: false },
});
```

- `session.tools()` lists exactly the enabled tools, with no meta tools.
- `composio.sessions.use(id)` reads a session back, and `session.update()` moves `configVersion` from 1 to 2.
- The returned config still says `workbench.proxy_execution_enabled: true` with the workbench off. We never call `proxy_execute`. Unit T should also set `enableProxyExecution: false`, which we didn't test.

## Execute replies

`session.execute(slug, args)` resolves to `{data, error, logId, resultType, instantCharge}`.

- `instantCharge` is `{amount: "0.005000", currency: "USD", charged_by: "composio"}`, with the amount as a string. It appears only with `returnInstantCharge: true`.
- A tool failure doesn't throw. It resolves with `resultType: "failed"`, a message in `error`, and no charge.
- Refusals throw a 400. The code to map is in `error.code` and `error.slug`:

| Case | Code | Slug | Maps to |
|---|---|---|---|
| Personal toolkit with no connection | 4302 | `ToolRouterV2_NoActiveConnection` | `needs_connection` |
| Tool outside the session's enable list | 4310 | `ToolRouterV2_ToolNotInEnabledList` | `tool_not_allowed` |

## Slugs and prices

The price line is Composio's list price. The charge is lower, and the discount field doesn't predict it exactly: Firecrawl's 79% off $0.003 would be $0.00063, but the charge is $0.000798. So `estimateUsd` is the list price, as an upper bound for the reservation, and settlement uses the reply's charge. Neither includes Composio's per-call fee, and no reply reports that fee.

| Id | Slug | Version | Instant | List price (discount) | Charged | Tags |
|---|---|---|---|---|---|---|
| scholar | SERPAPI_SCHOLAR_SEARCH | 20261030_00 | yes | $0.025 (63%) | $0.009167 | readOnly, openWorld |
| places | SERPAPI_GOOGLE_MAPS_SEARCH | 20261030_00 | yes | $0.025 (63%) | $0.009167 | readOnly, openWorld |
| events | SERPAPI_EVENT_SEARCH | 20261030_00 | yes | $0.025 (63%) | $0.009167 | readOnly, openWorld |
| read_page | FIRECRAWL_SCRAPE | 20261030_00 | yes | $0.003 (79%) | $0.000798 | **create** |
| gmail_read | GMAIL_FETCH_EMAILS, GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID | 20261029_00 | no | none | not run | readOnly, openWorld |
| gmail_draft | GMAIL_CREATE_EMAIL_DRAFT | 20261029_00 | no | none | not run | create, openWorld |
| gmail_send | GMAIL_SEND_EMAIL | 20261029_00 | no | none | not run | create, openWorld |
| calendar_read | GOOGLECALENDAR_EVENTS_LIST | 20261010_00 | no | none | not run | readOnly, idempotent, openWorld |
| calendar_add | GOOGLECALENDAR_CREATE_EVENT | 20261010_00 | no | none | not run | create, openWorld |
| slack_read | SLACK_FIND_CHANNELS, SLACK_FETCH_CONVERSATION_HISTORY | 20261023_00 | no | none | not run | readOnly, idempotent, openWorld |
| slack_search | SLACK_SEARCH_MESSAGES | 20261023_00 | no | none | not run | readOnly, idempotent, openWorld |
| slack_send | SLACK_SEND_MESSAGE | 20261023_00 | no | none | not run | create, openWorld |

No catalog tool carries `destructiveHint`. `results/01-discover.jsonl` has every tool in these toolkits, plus Exa and `composio_search`.

The API confirms Exa as Instant: `EXA_SEARCH` ($0.007), `EXA_ANSWER` and `EXA_GET_CONTENTS_ACTION` are all `instant.supported: true`. No Exa tool was run. `composio_search` still lists 22 tools although it's retired.

## Output shapes

- **Scholar and places** nest under `data.results`. **Events** doesn't: `events_results` and `organic_results` sit directly under `data`.
- **Event cards had no `link`** in the query we checked, and one query returned no cards at all, only web results.
- **Size:** news 10 KB, places 43 KB, events 60 to 132 KB. Most of that is metadata, an AI overview and `serpapi.com` links, so the catalog's `output` rules keep only the useful paths. Unit T has to apply them before the 32 KB trim, or a plain cut will lose results.
- `serpapi.com/searches/<id>` links appear in replies and shouldn't reach products. The replies we scanned had no `api_key=`.
- **Gmail, Calendar and Slack outputs are unverified,** since nothing is connected. Provider text can be wrong here: Tavily's says `response_data.results`, and the real path is `data.results`. These tools have `outputVerified: false` in the catalog.

## Connect Links

`session.authorize("gmail", {callbackUrl})` returns:

```json
{"id": "ca_...", "status": "INITIATED", "redirectUrl": "https://connect.composio.dev/link/<token>"}
```

- **Allowlisting:** none was needed to create the link. A callback on `callback-spike.example.com` with its own `?state=` was accepted. We didn't complete the flow, so whether that domain and the `state` parameter survive the redirect is still unconfirmed until the owner test.
- The docs say the callback adds `status` and `connected_account_id`, and that both are only hints to verify.
- `connectedAccounts.list({connectedAccountIds | userIds, toolkitSlugs, statuses})` works. The listed status was `INITIALIZING`, and items have no user id field, so verify by filtering on `userIds` rather than reading one back.
- `connectedAccounts.delete(id)` returns `{success: true}`.
- Opening the link answers 307 to `dashboard.composio.dev`. We went no further.

## What this changes in the plan

1. **Don't pass a version to execute (2.2 step 8).** Session execute ignores it: a bogus `00000000_00` still ran. Direct execute refuses anything but the latest for Instant, with 403 code 6605: "Instant accounts run the latest version". A pin therefore fixes the schema we hand out, not the code that runs.
2. **Schemas can drift whatever we do (2.5).** Toolkit versions move every few days. Instant metadata is missing on older versions, so the sync reads Instant status and prices from the latest. It refuses a pin whose kept parameters no longer exist. Run `npm run tools:sync -- --check` before each deploy.
3. **Tags drift too.** TAVILY_SEARCH was `readOnlyHint` at 20261030_00 and `createHint` at 20261030_01, one version apart.
4. **`tags: {disable: ["destructiveHint"]}` protects nothing (2.4).** A tool named in `tools.enable` stays: GMAIL_DELETE_DRAFT was still listed and only failed on the missing connection, and with `createHint` disabled, TAVILY_SEARCH still ran and charged. The catalog's denylist is the guard.
5. **The session config needs `returnInstantCharge: true` (2.4).** Without it there's no charge to settle at (2.9). Direct execute never returns one, and reading it from the log takes another call.
6. **Failed calls weren't charged,** so 2.9's "otherwise keep the estimate" overbooks them. Our sample is one validation failure, so T should decide whether `failed` with no charge settles at $0.
7. **Composio's tags can't set `access` (2.7).** FIRECRAWL_SCRAPE is tagged create but only reads, and it would wrongly ask for confirmation. The catalog's `access` decides.
8. **Recipient rules need more (2.7):**
   - GMAIL_SEND_EMAIL accepts `to` as an alias outside its schema, so the gateway must refuse any argument not in the catalog's parameters.
   - Calendar attendees are emailed by default, so `calendar_add` lists `attendees` as a recipient field and narrows it to strings.
   - GMAIL_SEND_DRAFT has `destructiveHint`, so draft-then-send isn't available. `gmail_send` is always a fresh send.
   - The daily cap of 10 is now in the catalog as `perDay`, for `gmail_send` and `slack_send`.
9. **Parameters are a safety boundary, not just size (2.5).** Firecrawl `actions` is browser automation, `jsonOptions` runs an LLM, and Tavily `search_depth` doubled the price. `keepParams` drops them, and T has to enforce that at execute.
10. **`web_results` and `news` are gone, by the owner's decision.** Sections 2.5, 3.3 and 5 and test build 2 still mention them.
11. **`read_page` is limited only by its description for now.** To enforce "URLs the user gave", T or runAgent would have to check the URL against the user's input.

## Slack

The owner added Slack to the personal tier after the live runs. Only Composio's schemas and toolkit metadata were read: no Slack call, no connection and no Connect Link.

- Composio lists managed OAuth for it (`composio_managed_auth_schemes: ["OAUTH2"]`). Nobody has tried it yet.
- `slack_send` needs a confirmation each time and is capped at 10 a day per product, in the catalog as `perDay`. The gateway has to enforce both.
- `blocks`, `reply_broadcast` and the `channel_id` alias stay out of `slack_send`, and `channel` is its recipient field.
- **Check in the owner test:**
  - Whether a send posts as the owner or as a bot. Composio's text mentions a bot, and `not_in_channel` if it isn't a member.
  - Whether `slack_search` works on the managed app. It needs the `search:read` scope, and as far as we know Slack only allows search on a user token, which we didn't confirm.
  - Composio's text says Slack can cap history at 15 messages a page for apps outside the Marketplace.
- Slack messages, including private channels, pass through Composio and fall under its retention (plan section 8, item 7), so the ZDR decision covers them too.

## Left behind at Composio

- One Composio-managed Gmail auth config, created by `authorize` (enabled, 0 connections).
- Five sessions under `spike_c0_public` and `spike_c0_throwaway`. The ids weren't kept, and they cost nothing further.
- The one connected account the spike created was deleted, and the link was never completed.

## Running the scripts

```sh
COMPOSIO_ENV_FILE=<path to .env.local> COMPOSIO_SDK_DIR=<folder with @composio/core> \
  sh docs/spikes/composio-2026-10-31/run.sh docs/spikes/composio-2026-10-31/<script>.mjs
```

`run.sh` loads only `COMPOSIO_API_KEY`. `01` is free. The others spend money, so read them first: their results are already here.
