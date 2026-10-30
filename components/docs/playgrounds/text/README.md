# Text group demos

The live demos for the text capability pages: tool calling, tool search, search grounding, reasoning, structured output, prompt caching and token counting. Each page's DemoSpec (props, title, blurb, agent prompt) is in `lib/docs/demos/text.ts`. Components are client components configured by plain JSON props, built on the kit (`components/docs/kit`, `components/docs/playgrounds/common`): `useDocsRun` runs and records every call, `ModelSelect` shows the Contributor notice, errors go through `ErrorBox`, and "Show code" uses `CodeView`. Styles are in `text.module.css`, on the site's theme variables.

Every rule check and preset was run against the live API through the docs proxy on Oct 30, 2026. Where the API answered differently from the page, the demo says so instead of hiding it (custom tools answer 400; the hosted tool search call is named `crm.list_open_orders`; the model calls a loaded client tool `tool_get_shipping_eta`).

Answers are drawn from their Markdown (`AnswerText`), never injected as HTML. Demos that record their own calls for the copy prompt (prompt caching, reasoning, rule checks) do it after the reply, so "What I just ran" carries the numbers the page is about (`record.ts`). Every page's copy prompt keeps its task, facts, checklist and starter code whole even with the longest "What I just ran" the prompt builder allows; `render.test.tsx` checks that for every agent and language.

## Components

| Component | Page | What it does | Props (besides `slug`) |
|---|---|---|---|
| `ToolCallingDemo` | tool-calling | The kit's `ToolLoopPlayground` set up per scenario (the page's get_weather, parallel calls, a chain, calculations, a strict schema), plus `RuleChecks` | `scenarios: ToolScenario[]` (`id, label, about, prompt, tools, results?, parallel?, system?, protocols?, presets?`), `checks?`, `checksIntro?`, `protocols?`, `model?`, `models?`, `effort?`, `maxCalls?` |
| `ToolSearchPlayground` | tool-search | A 37-function library (`tool-library.ts`) deferred behind `tool_search`, hosted or client-executed, step by step: what was searched, what loaded, the call, the mock result, the answer. Free up-front counts with `responses/input_tokens` | `hostedPresets`, `clientPresets` (`{label, prompt}[]`), `mode?`, `namespaces?`, `model?`, `models?`, `effort?`, `maxCalls?`, `checks?`, `checksIntro?` |
| `SearchGroundingPlayground` | search-grounding | `web_search` with `search_context_size`, `user_location` and `include: ["web_search_call.results"]`, streamed: the searches, the answer with a marker after each cited span, numbered sources, the raw results marked where cited | `presets?` (`{label, prompt, contextSize?, location?}[]`), `prompt?`, `places?`, `model?`, `models?`, `effort?`, `include?`, `stream?`, `maxOutputTokens?`, `checks?`, `checksIntro?` |
| `ReasoningLab` | reasoning | One prompt at each effort picked (three at a time), compared by reasoning tokens, time and cost, with summaries; then a follow-up by `previous_response_id` or a stateless replay of the encrypted reasoning | `presets` (`{label, prompt, followUp?, model?, efforts?, maxOutputTokens?}[]`), `efforts?`, `summary?`, `maxOutputTokens?`, `protocol?`, `model?`, `models?`, `checks?`, `checksIntro?` |
| `StructuredOutputDemo` | structured-output | The kit's `StructuredOutputPlayground` with the page's Address example and practical schemas, `SchemaSizeCheck` (the page's limits, measured locally) and `RuleChecks` | `presets: SchemaPreset[]`, `protocols?`, `strict?` (default false), `effort?`, `model?`, `models?`, `stream?`, `sizePresets?` (`{label, schema?, generate?}[]`), `enumAllowance?`, `checks?`, `checksIntro?` |
| `PromptCachingLab` | prompt-caching | The same long prefix (the Alice sample) sent twice; `cached_tokens`, time to first text and cost for each call, and the page's two ways to break the prefix. The cost line before a run is worked out for the chosen model and prefix (`pairCost`) | `scenarios` (`{id: "same" \| "timestamp" \| "edit", label, about}[]`), `questions: [string, string]`, `part?`, `model?`, `models?`, `effort?`, `sampleUrl?` |
| `TokenCounter` | token-counting | Counts six cases (a question, instructions, a tool conversation, web search scaffolding, an image at several sizes, a long document, or any body) on `responses/input_tokens` or `messages/count_tokens`, against the context window, across models, and against the reply's usage. "Send it and compare" only pairs a reply with a count of the same body (`countKey`); otherwise it counts that body first | `endpoint?`, `model?`, `models?`, `sampleId?`, `documentUrl?` |
| `RuleChecks` | shared | A page's rules checked live: each row sends the smallest request that shows one rule and compares the answer with what the page says. A 400 that the page predicts is shown as Meta's message, not as an error. A check with `replyHas` also needs that output item or content block in a 2xx reply | `checks: RuleCheck[]` (`id, rule, sends, path, body, expect: "accepted" \| "rejected", anchor?, note?, replyHas?`), `intro?`, `model?`, `models?` |
| `AnswerText` | shared | A model's answer from its Markdown: paragraphs, lists, tables, code, links (http, https, mailto) and TeX math as Unicode text; with `cite`, the citation marks become underlined spans and markers | `text`, `cite?: { marker(n), citedClass }`, `tail?` (a streaming caret), `className?` |

Small parts in `parts.tsx`: `DemoTabs` (the kit's tabs over panels that stay mounted), `BarList` (label, bar and value in shared columns; the label goes above its bar in a box under 26rem), `Meter`, `Tiles`/`Tile`, `Badge`, `PickPills`, `LazyDetails` (renders its content once opened, so folded JSON trees cost nothing), `cx`, `n`.

## Pure modules (tested in `__tests__/logic.test.ts` against real replies in `__tests__/fixtures/`)

- `items.ts`: a Responses reply as ordered output items, streamed or whole (`itemsReader`, `itemsOf`, `answerItems`, `commentaryItems`), keeping each message's own citation offsets and its `phase`.
- `grounding.ts`: `groundingBody`, `groundingSteps`, `searchCounts`, `numberSources`, `segmentCitations` (code-point offsets mapped onto UTF-16), `encodeCitations` (the segments as one text with citation marks, for `AnswerText`), `sourceKey`, `hostOf`.
- `markdown-lite.ts`: `parseMarkdown`, `parseInlines`, `texToText` (TeX to Unicode: `\sqrt{2} = \frac{p}{q}` reads √2 = p/q), and the citation marks `CITE_OPEN`, `CITE_CLOSE`, `markerChar`.
- `rules.ts`: `RuleCheck`, `verdictOf` (only 2xx and 400 decide), `checkVerdict` (adds `replyHas`), `replyBlock`, `acceptedSummary`, `withModel`, `mayBill`.
- `record.ts`: `recordOf`, `failureOutcome`: the copy prompt's record, built after the reply.
- `tool-library.ts`: `TOOL_LIBRARY`, `hostedTools`, `loadedTools`, `CLIENT_SEARCH_TOOL`, `searchLibrary`, `findFunction` (reads `crm.x`, a `namespace` field, or a `tool_` prefix), `runLibraryCall`. Actions answer as done with `simulated: true` and a "Demo only" note (failure-shaped answers made the model report a failure); `list_holidays` knows 2026 in US and GB and says so for anything else.
- `tool-search.ts`: the loop as data: `nextTsAction`, `nextTsBody` (hosted chains with `previous_response_id`; client replays the turn with the user's message first), `searchStepFor`, `toolsStepFor`, `loadedGroups`, `searchedFor`, `savings`, `recordBody`.
- `efforts.ts`: `effortBody`, `effortResult`, `presetSetup` (a preset resets what it leaves out), `previousFollowUp`, `replayFirstTurn`, `replayFollowUp`, `encryptedItems`, `runLimited`.
- `schema-size.ts`: `schemaStats`, `limitChecks`, `SCHEMA_LIMITS`, `generatedSchema`. Depth counts object and array levels, as the API did.
- `caching.ts`: `cacheBody`, `prefixFor`, `bookPart`, `editedMiddle`, `freshTag`, `cacheRunFrom`, `inputCost`, `pairCost`, `cachedShare`, `cacheReading`, `shortenForCode`.
- `token-cases.ts`: `COUNT_CASES`, `countBody` (both endpoints), `countKey`, `sendBodyFor`, `windowShare`, `shareLabel`, `countOf`, `displayCountBody`.
- `chain.ts`: `withChainRetry`: one retry, after 1.2 s, when a chained call (`previous_response_id`) comes back 400 "referenced response not found" or 5xx (Meta's 503 "persistence service error").
- `money.ts`: `usdExact`: cents from a dollar up, two significant digits below.

## Tests

```
npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/text/__tests__/logic.test.ts components/docs/playgrounds/text/__tests__/render.test.tsx
```
