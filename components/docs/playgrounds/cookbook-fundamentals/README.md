# Cookbook fundamentals demos

The live demos for the cookbook index, its API fundamentals and agent patterns pages, and those recipes (`lib/docs/demos/cookbook-fundamentals.ts` holds each page's DemoSpec and copy prompt). Every component is a client component built on the kit (`components/docs/kit`): `useDocsRun` for each call (so it's recorded for "Copy prompt for your coding agent"), `ModelSelect` with the Contributor notice, `RunButton`, `ErrorBox`, `ResponseView`, `CodeView` behind "Show code". Text calls default to `muse-spark-1.3-contributor`. Props are plain JSON.

## Components

| Component | Pages | Props |
|---|---|---|
| `RecipeBrowser` | cookbook, cookbook/api-fundamentals, cookbook/agent-patterns | `sections?: string[]` (ids in `recipes.ts`; all when left out), `start?: string` (the recipe selected on load). A card's "Try its core call" opens the call in the top panel (model menu, Contributor notice, Run); nothing is sent from a card. Muse Code and open-weight recipes show their command, and a recipe with both (Muse Spark Open on Mac) shows the command and the call |
| `TabbedDemo` | quickstart-chat-completions, structured-output | `label`, `tabs: { id, label, kind, props }[]` with kind `chat` (the kit's ChatPlayground), `structured` (StructuredOutputPlayground), `showcase` (RequestShowcase) or `stateless` (StatelessCompare) |
| `StatelessCompare` | (a tab) | `turn1?`, `turn2?`: turn 2 sent alone and with the history |
| `RequestShowcase` | (tabs) | `items: { id, label, what, path, body, expect: "ok" \| "error", read?: "text" \| "json" }[]`, `intro?`, `modelMenu?` (true) |
| `StreamingDemo` | streaming-responses | `prompt?`, `presets?: { label, prompt }[]`, `effort?` ("minimal") |
| `ToolCallingDemo` | tool-function-calling | `prompt`, `readings: Record<city, string>`, `presets?`, `maxCalls?` (5) |
| `PromptCachingDemo` | prompt-caching | `calls?` (3) |
| `ReasoningDemo` | reasoning-thinking-tokens | `questions: { label, prompt }[]` |
| `VisionInputDemo` | vision-input | none |
| `SearchGroundingDemo` | search-grounding | `presets: { label, prompt, contextSize?, stream? }[]`. Live replies carry no url_citation annotations today, so it lists the search results instead and can replay Meta's documented example reply (`DOCUMENTED_SEARCH_REPLY`, no request) through the same footnote rendering |
| `RetryDemo` | error-handling-retry | `unsupported: ShowcaseItem[]` (the parameters tab) |
| `AgentLoopDemo` | basic-agent-loop, interleaved-reasoning-tool-use | `project: "agent-loop-target" \| "callback-target"`, `variant: "loop" \| "interleaved"`, `effort?`, `summary?`, `maxTurns?`, `tokenBudget?` |
| `ContextDemo` | multi-turn-context-management | `instructions`, `script: { label, content }[]`. The running state sends STATE.md once (the kept reply loses its block); the declared window starts at 2k, or 1k for compaction |
| `EditsDemo` | search-and-replace-edits | none |
| `LongContextDemo` | long-context | none |

`ui.tsx` has the shared pieces (`DemoTabs` keeps every panel mounted, `Stats`, `BarList`, `Meter`, `Parts`, `StatusPill`, `CodeLines`, `DiffView`, and for the panel's simple view `Note advanced`, `Advanced` and `SplitPills`, which keep a note, a control or the extra pills behind Options); `useToolLoop.ts` is the kit's tool loop as a hook, with custom tools, guards, a body transform, and retries of Meta's occasional "referenced response not found" 400 on a continuation (`shouldRetryReference`; up to three, after 1.2, 2.5 and 5 s, where the kit's ToolLoopPlayground tries once).

The copy prompts (`agentPrompt` in `lib/docs/demos/cookbook-fundamentals.ts`) keep every snippet to 1,000 characters and leave room for the longest agent introduction, so "Include what I just ran" with an agent loop's large recorded turn trims only the record (`__tests__/prompts.test.ts` checks every page, agent and language). Curl bodies go through `curl()`, which escapes single quotes.

## Pure modules (tested in `__tests__/`)

- `recipes.ts`: every recipe the cookbook page lists, with its core call (or its starting command).
- `stream-timing.ts`: first chunk and first token times, the guarded text, the finish and usage chunks, where a naive loop crashes.
- `footnotes.ts`: the search-grounding recipe's render_with_footnotes (back to front, one number per URL), passages, and `DOCUMENTED_SEARCH_REPLY` (the example response on Meta's search grounding guide).
- `retry.ts`: classify failures, backoff with jitter, the retry loop (and the naive one), the circuit breaker.
- `caching.ts`, `vision.ts` (the recipe's solid_png ported, request shapes), `long-context.ts` (window and cost before sending, dense filler), `context.ts` (trim_history, STATE.md, compaction, each strategy's default window and meter warning).
- `edits.ts` (the exactly-once edit rule, a light Python check), `diff.ts` (unified diffs).
- `projects.ts` and `sam-files.ts` (the sample projects), `sandbox.ts` (the test runner: strict-mode JavaScript in a string, run in a Web Worker with the network APIs deleted, a per-test and a whole-run time limit; the page accepts only the report carrying the run's nonce, and the tests' assert is frozen), `agent.ts` (the project tools, guards, the recipes' trace formats, and `oracleFiles`: the oracle runs the project's original tests against the agent's code, or a task's own tests where it changes an API on purpose (`AgentTask.oracleTests`, the retry migration), and names any other test the agent changed).

## Tests

`npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/cookbook-fundamentals/__tests__/*.test.ts components/docs/playgrounds/cookbook-fundamentals/__tests__/*.test.tsx`

`fixtures/` holds three real replies from the live docs (a streamed chat completion with arrival times, a web search response, a function-call turn), with the hashed visitor id and encrypted reasoning removed.
