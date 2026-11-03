---
name: recipe-api
description: Use when a product leans on Model API basics, such as a first chat, streaming, tool calls, JSON output, caching, reasoning, photos, very long documents, retries or web search with footnotes.
---

# Model API patterns

Everything runs on the server through `metaClient(request)` from `@/lib/meta/client`. The call details are in the meta-reasoning skill; this skill adds what it leaves out. Product code and tests name `muse-wonder-1.0` and nothing else: a test build runs those calls on a cheaper model by itself, and a token refuses that model by name.

The links are for people and BUILD_NOTES. The build firewall may block GitHub, so never fetch or clone them.

`helpers/` beside this file holds pure TypeScript with no imports. Copy what the product needs into `lib/api/` and its tests: `usage.ts` (token counts, cost, the cache line), `stream.ts` (NDJSON streaming, server and page), `retry.ts` (retries with a ledger), `footnotes.ts` (sources from a searched reply), `context.ts` (fitting long text, a sliding window).

## The sample proves the pattern

Each recipe below says what its sample must hold. A sample that can show the feature only as 0, empty or "nothing to check" fails the test, and so does a result made in code when the model call fails. On failure, show the real error with a retry (`modelErrorResponse` from `@/lib/meta/errors`). Every flow ends on a result the person can see: the answer, the ledger and one `UsageStrip`.

## 01/01 Chat

The gateway serves `/v1/responses` only, so use `meta.responses.create`, never chat completions: same outcome, and the rest of the platform expects it. A chat is the meta-chat skill's route.
- The standing rules go in `instructions` (Meta's developer level), kept on the server.
- History: send the turns each time (`chatInput`). The sample conversation has a second turn that only makes sense with the first, like "make that shorter".
- Leave `temperature` unset (Meta tunes for 1.0). A "focused or varied" control sets `temperature` only, never `top_p` too.
- `stop`, `n` above 1 and `logit_bias` answer 400.
Link: https://dev.meta.ai/docs/cookbook/quickstart-chat-completions

## 01/02 Streaming

Pass `stream: true` and return `ndjsonStream(events)` from `helpers/stream.ts`. The page reads it with `readNdjson`, which also times the first text against the end.
- Reasoning comes before the first word, so show "Thinking" until the first delta.
- A Stop button aborts the fetch.
- A dropped or stopped stream keeps its text, marked "Cut off", with a retry that starts over (a stream can't resume).
- Usage arrives in the `done` line, from `response.completed`.
Sample: a reply long enough to watch arrive, several paragraphs. Check: the smoke test asserts `firstTextMs` is under `totalMs`, and a test feeds an error event and sees the page keep the partial text.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/01_api_fundamentals/02_streaming.ipynb

## 01/03 Tool calling

Write the loop by hand in a route:
1. Send the tools: `{ type: "function", name, description, parameters, strict: true }`.
2. Run each `function_call` item, parallel ones too.
3. Validate every argument with zod first, and hand a validation failure back to the model as that tool's output.
4. Answer with `function_call_output` items carrying the same `call_id`, on `previous_response_id: r.id`, and repeat until no call comes back.

Cap the turns in code. Never send `tool_choice` other than `"auto"`: Meta answers 400. The model may answer with no call, so handle plain text too. Tools run real code on the product's own made-up data (a stock table, a calendar of slots); none returns a canned "would have done". Show a tool log on the page: each call's name, arguments, result and turn. Sample: a request that needs at least two different tools. Check: a scripted model proves the loop stops at the cap, and the smoke test sees at least one logged call. Limit: one route call lasts at most 300 seconds, so keep this to a few turns. Longer loops need a long recipe.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/01_api_fundamentals/03_tool_calling.ipynb

## 01/04 Structured output

`respondJson` with a zod schema. Never parse model text by hand.
- Lock the shape: every field required unless it truly may be missing, and `z.enum` for closed sets.
- No recursive schemas (Meta answers 400). Flatten them or cap the depth.
- On Responses the setting is `text.format`, never `response_format`.
- When the page also shows tokens, `respondJson` hides usage. Call `meta.responses.create` with `text: { format: { type: "json_schema", name, schema: z.toJSONSchema(Schema), strict: true } }` and `Schema.parse(JSON.parse(res.output_text))`. A parse failure shows the error and a retry, never a repaired guess.

Show the result as fields, plus the schema it passed. Sample: messy input with a field that's missing or ambiguous, so the schema's optional or enum handling shows.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/01_api_fundamentals/04_structured_output.ipynb

## 01/05 Prompt caching

Caching needs no setting. It matches from the first token forward, so:
- Put long stable text first: instructions, then documents, then the visitor's question last.
- Never put a date, id or visitor name in the stable part.
- Keep tool definitions and their order the same on every call.
- Pass a fixed `prompt_cache_key` naming the shared prefix, like a hash of the document. Never one per visitor. Optionally add `prompt_cache_retention: "24h"`, which is a hint.

**The prefix must be long:** at least about 2,000 tokens, about 8,000 characters. Meta's own examples use 2,000 to 5,000. The Nov 3 audit's 314-token calls read 0 cached four times in a row. A brief's text fixture stops at 6,000 characters, so the build writes the full sample document into `fixtures/` itself: many sections, each with its own made-up facts.

Read hits from `usage.input_tokens_details.cached_tokens` (`readTokens`). Show a ledger, one row per call: input, cached and `cacheLine`. The first call with a new prefix reads 0 by design, and the page says so. A repeat that still reads 0 says "No cache hit", never an estimated saving. Show the saving only from the real number, in the result's one `UsageStrip` (product-ui, Cost and usage).

Check: a unit test proves two questions build byte-identical prefixes, and the smoke test asks two questions on the sample and records the second call's cached count. A hit is likely but not guaranteed, so the test records it rather than failing on 0.

Limit: the gateway reserves budget as if nothing were cached, so a daily budget can stop calls earlier than the real spend suggests.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/01_api_fundamentals/05_prompt_caching.ipynb

## 01/06 Reasoning tokens

Set `reasoning: { effort }`: `minimal`, `low`, `medium` or `high` (`xhigh` is the same as high, and `none` isn't accepted). Reasoning bills as output, so read `usage.output_tokens_details.reasoning_tokens` and count it in the cost. Use `low` by default, and higher only where a test shows it changes the answer.
- The reasoning itself can't be read: Meta encrypts it and the summary is empty. Never show text labeled as the model's thinking. Show the counts.
- If the product wants visible steps, ask for them as a schema field and label them "the model's written explanation".
- A comparison runs the same question at two efforts in parallel and shows each answer with its reasoning tokens, time and cost, plus whether the answers agree.

Sample: one easy question, where efforts tie, and one multi-step puzzle, where they may not.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/01_api_fundamentals/06_reasoning_tokens.ipynb

## 01/07 Vision input

`imagePart` from `@/lib/meta/parts`, in a `user` message only: an image in `instructions` or a developer message answers 400.
- Several images can go in one call, in order. Keep it to a handful, since each costs tokens by its size.
- Types: PNG, JPEG, WebP, GIF. Never SVG. A drawn screen goes through `svgToPng` or `canvasToPng` from `@/lib/client/raster`.
- Shrink photos in the browser first with `@/lib/client/resize`. A request body is capped at 4.5 MB, so anything larger goes through `uploadMedia` and is passed by URL.
- The gateway doesn't serve `/v1/responses/input_tokens`, so report image tokens from the reply's usage.
- Boxes come back in the units you ask for: draw them with `@/lib/client/overlay` in those same units.

Samples are realistic photos from `fixtures/`, never drawings, test patterns or placeholder blocks.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/01_api_fundamentals/07_vision_input.ipynb

## 01/08 Long context

The window is about 1M tokens, and a request over it fails with a 400: nothing truncates for you (`truncation: "auto"` is refused). The daily budget is the tighter limit. A full window costs about $4 of input per call. **Plan for at most about 100,000 input tokens per call, about $0.40 uncached.**
- For more than that, split the document, or read only the sections a first pass picks: `fitSections` with `pick`.
- Before sending, show the estimated tokens and cost and the sections left out (about 4 characters per token).
- Keep the document in the cached prefix (`documentText`) for follow-up questions, and cap a long chat with `slidingWindow`.
- Sample: long enough to need the plan, about 40,000 to 80,000 characters. Write it in code from a table of distinct made-up facts, one section each, so tests know every answer. Plant one fact deep in a late section and ask about it.

Limit: this product's budget does not suit repeated full-window calls.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/01_api_fundamentals/08_long_context.ipynb

## Files API for long documents

Upload a PDF once with `meta.files.create({ file, purpose: "user_data" })`, then use `filePart({ fileId })` from `@/lib/meta/parts` on each call, in the stable prefix. Bigger files reach the server through `uploadMedia`. Limit: a PDF is billed by its pages on every call, unless it's cached, so read only what the task needs.

## 01/09 Error handling

Use `withRetries` from `helpers/retry.ts`, and call with `{ maxRetries: 0 }` as the request options inside it: `metaClient` already retries once, which would multiply the tries.

| Status | Do |
|---|---|
| 400, 401, 403, 404 | Never retry. Fix the request, or tell the person plainly |
| 429 with code `budget_exceeded` | Never retry, even though it is a 429. Read `error.code` first. Say today's budget is used up and resets at 00:00 UTC |
| 413 | Never retry. Send a smaller file or use `uploadMedia` |
| Any other 429 | Wait for `Retry-After` when present, otherwise back off with jitter. At most 3 tries |
| 500, 502, 503, 504, timeouts | Back off with jitter. At most 3 tries, and only for calls safe to repeat |

Each retry can spend money, so count it. Show the ledger: each attempt's status, the decision and the wait.
- A real 400 costs nothing: send `response_format` on Responses, which Meta refuses.
- 429s and 503s can't be made on demand, so a practice switch may fake one for one call in code. Its rows say "Simulated" (`simulated` in `withRetries`), and it never counts as spend.
- After 3 failed calls in a row, pause calls for 30 seconds and say so (a circuit breaker).

Check: a test with a stubbed 429 and a stubbed 400 proves one retries and the other does not, and a stubbed `budget_exceeded` 429 never retries.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/01_api_fundamentals/09_error_handling.ipynb

## 01/10 Search with footnotes

Any Muse Wonder product may pass `tools: [{ type: "web_search" }]` directly, with an optional `search_context_size`. The gateway caps searches per request and bills each query. **Live replies have carried no `url_citation` annotations**, so never rely on them alone. `footnotes(res.output)` from `helpers/footnotes.ts` does this in order:
1. Read annotations when they exist.
2. Otherwise list the URLs in each `web_search_call` item's `results`. Ask for them with `include: ["web_search_call.results"]`.
3. If neither gives a source, it says "No sources were returned for this answer." Never invent a link, and never ask the model to write URLs from memory.

The model decides whether to search, so an answer can arrive with no search at all. Show that plainly (`searches` is 0). When streaming, sources are complete only at the end. Ask about public things the web has, like a real city's events this week, even when the person is made up: a search for made-up facts finds nothing. Checks: footnote numbers match real source URLs, and a reply with no sources shows the plain line. Limit: when only search results came back, the footnotes list what the search returned, not which sentence each source supports.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/01_api_fundamentals/10_search_grounding.ipynb
