---
name: recipe-api
description: Use when a product leans on Model API basics, such as streaming, tool calls, JSON output, caching, reasoning, vision, very long documents, retries or web search with footnotes.
---

# Model API patterns

Everything runs on the server through `metaClient(request)` from `@/lib/meta/client`. The call details are in the meta-reasoning skill; this skill adds what it leaves out. Real products use `muse-wonder-1.0`. Tests use `muse-spark-1.3-contributor` (`TEST_MODEL`).

The links are for people and BUILD_NOTES. The build firewall may block GitHub, so never fetch or clone them.

## 01/01 Chat, 01/02 Streaming

Use `meta.responses.create`, not chat completions: it gives the same outcome and the rest of the platform expects it. For streaming, pass `stream: true`, forward each `response.output_text.delta` to the page through a `ReadableStream`, and read usage from `response.completed`. Check: text appears before the reply ends, and a dropped stream shows a retry button.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/01_api_fundamentals/02_streaming.ipynb

## 01/03 Tool calling

Write the loop by hand in a route: send the tools, run each `function_call` item, return a `function_call_output` with the same `call_id`, and repeat until no call comes back. Validate every argument with zod before running it, and hand a validation failure back to the model as the tool's output. Cap the turns in code. Check: a scripted model proves the loop stops at the cap. Limit: one route call lasts at most 300 seconds, so keep this to a few turns. Longer loops need a long recipe.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/01_api_fundamentals/03_tool_calling.ipynb

## 01/04 Structured output

Always `respondJson` with a zod schema. Never parse model text by hand.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/01_api_fundamentals/04_structured_output.ipynb

## 01/05 Prompt caching

Caching needs no setting. It matches from the first token forward, so:

- Put long stable text first: instructions, then documents, then the visitor's question last.
- Never put a date, id or visitor name in the stable part.
- Keep tool definitions and their order the same on every call.
- Optionally pass a fixed `prompt_cache_key` naming the shared prefix.

Read hits from `usage.input_tokens_details.cached_tokens` on a Responses reply. The first call with a new prefix reads 0. Show the saving only from that real number. Limit: the gateway reserves budget as if nothing were cached, so a daily budget can stop calls earlier than the real spend suggests.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/01_api_fundamentals/05_prompt_caching.ipynb

## 01/06 Reasoning tokens

Set `reasoning: { effort }`. Reasoning bills as output, so read `usage.output_tokens_details.reasoning_tokens` and count it in the cost. Use `low` by default, and higher only where a test shows it changes the answer.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/01_api_fundamentals/06_reasoning_tokens.ipynb

## 01/07 Vision input

`imagePart` from `@/lib/meta/parts`. Shrink photos in the browser first with `@/lib/client/resize`. A request body is capped at 4.5 MB, so anything larger goes through `uploadMedia` and is passed by URL.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/01_api_fundamentals/07_vision_input.ipynb

## 01/08 Long context

The window is about 1M tokens, and a request over it fails with a 400: nothing truncates for you. The daily budget is the tighter limit. A full window costs about $4 of input per call. **Plan for at most about 100,000 input tokens per call, about $0.40 uncached.** For more than that, split the document, or read only the sections a first pass picks. Count before sending (about 4 characters per token) and show the person what was left out. Keep the document in the cached prefix for follow-up questions. Limit: this product's budget does not suit repeated full-window calls.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/01_api_fundamentals/08_long_context.ipynb

## Files API for long documents

Upload a PDF once with `meta.files.create({ file, purpose: "user_data" })`, then use `filePart({ fileId })` from `@/lib/meta/parts` on each call, in the stable prefix. Bigger files reach the server through `uploadMedia`. Limit: a PDF is billed by its pages on every call, unless it's cached, so read only what the task needs.

## 01/09 Error handling

Through the gateway, treat errors this way:

| Status | Do |
|---|---|
| 400, 401, 403, 404 | Never retry. Fix the request, or tell the person plainly |
| 429 with code `budget_exceeded` | Never retry, even though it is a 429. Read `error.code` first. Say today's budget is used up and resets at 00:00 UTC |
| 413 | Never retry. Send a smaller file or use `uploadMedia` |
| Any other 429 | Wait for `Retry-After` when present, otherwise back off with jitter. At most 3 tries |
| 500, 502, 503, 504, timeouts | Back off with jitter. At most 3 tries, and only for calls safe to repeat |

Each retry can spend money, so count it. Check: a test with a stubbed 429 and a stubbed 400 proves one retries and the other does not.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/01_api_fundamentals/09_error_handling.ipynb

## 01/10 Search with footnotes

Any Muse Wonder product may pass `tools: [{ type: "web_search" }]` directly. The gateway caps searches per request and bills each query. **Live replies have carried no `url_citation` annotations**, so never rely on them alone:

1. Read annotations when they exist.
2. Otherwise build footnotes from the `web_search_call` items: ask for `include: ["web_search_call.results"]`, and use the URLs in each item's `results`.
3. If neither gives a source, say "No sources were returned for this answer." Never invent a link, and never ask the model to write URLs from memory.

The model decides whether to search, so an answer can arrive with no search at all. Show that plainly. Checks: footnote numbers match real source URLs, and a reply with no sources shows the plain line. Limit: the footnotes list what the search returned, not which sentence each source supports.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/01_api_fundamentals/10_search_grounding.ipynb
