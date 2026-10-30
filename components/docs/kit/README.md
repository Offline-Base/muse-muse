# Docs demo kit

The pieces every docs demo is built from, so they all look and behave alike (docs/DOCS_MIRROR.md, "Kit contract"). Import from `@/components/docs/kit`. The ready-made text playgrounds are in `components/docs/playgrounds/common/` (see its README.md); the media ones in `components/docs/media/`.

Ground rules the kit already follows, and your demo should too:

- Calls go through the docs proxy (`/api/docs/v1/...`) with `useDocsRun`, never to api.meta.ai and never with a key.
- Text demos default to `DEFAULT_TEXT_MODEL` (`muse-spark-1.3-contributor`). `ModelSelect` shows the Contributor notice under itself; if you send to a Contributor model without one, render `ContributorNotice` yourself.
- Every demo has Run and Stop (`RunButton`), shows failures with `ErrorBox`, and has a "Show code" toggle with `CodeView` for the exact request.
- `useDocsRun` records each request for "Copy prompt for your coding agent". Pass `record` to describe it better, or `record: false` for calls that aren't API requests a reader would build.
- Styles are global `pg-` classes in `kit.css` (imported by `app/docs/layout.tsx`). Don't import the CSS from a component. Your own components use CSS Modules.
- No em dashes in anything you write.

## Running requests

### `useDocsRun()`

```ts
const { state, result, error, elapsedMs, run, abort, reset } = useDocsRun();
await run("responses", { body, stream: true, onEvent: (e) => collector.push(e) });
```

- `state`: `"idle" | "running" | "done" | "error"`. A stopped run goes back to `"idle"`.
- `result`: the last `DocsResult` (lib/docs/client/api): `ok`, `status`, `json`, `text`, `blob`, `headers`, `error`, `model` (x-docs-model, the model the proxy really ran), `note` (x-docs-note), `elapsedMs`. Null while running.
- `error`: the `DocsError` to show, including an error a stream reported mid-way (a failed response, an `error` event). Null for a stopped run.
- `elapsedMs`: ticks every 100 ms while running, then the call's own time.
- `run(path, options)`: `path` is Meta's ("responses", "files/file-1/content"). Options are `CallInit` (`method`, `body`, `form`, `raw`, `signal`, `base`) plus `stream?: boolean`, `onEvent?(e: SseEvent)`, `record?: Partial<RecordedRequest> | false`. Never throws: a stop resolves with `error.code === "aborted"`. A new `run` stops the one before it.
- `abort()`: Stop. `reset()`: stop and forget the result.
- `isAborted(result)`: true for a stopped run. `ABORTED_ERROR` is the error it carries.

Calls with `base` set (`/api/docs/ask`, `/api/docs/asr-realtime`) are only recorded when you pass `record`.

## Controls

| Export | Props | What it is |
|---|---|---|
| `ModelSelect` | `kind: "text" \| "vision" \| "image" \| "sam" \| "voice"`, `value`, `onChange(model)`, `allow?: string[]`, `id?`, `label?` ("Model"), `notice?` (true), `disabled?` | The model menu for one endpoint kind, Contributor and Standard mode in groups, the Contributor notice under it with the hint naming this menu's Standard models. `muse-spark-1.3` shows as the Contributor model it runs as and is never offered. A kind with one model (image, sam, voice) shows it as text. With `notice={false}`, render `ContributorNotice` yourself and pass it the menu's ids. |
| `RunButton` | `running`, `onRun()`, `onStop?()`, `label?` ("Run"), `disabled?` | The blue Run pill; Stop (outline) while running when `onStop` is given, otherwise a disabled spinner. |
| `ContributorNotice` | `model`, `menu?: string[]` (the model ids the menu beside it offers) | "Runs on Muse Spark 1.3 Contributor: Meta may use what you send to train future models. Don't send anything private." Nothing for Standard models. With `menu`, a hint names the Standard models that menu offers ("For Standard mode, pick Muse Spark 1.2 or Muse Spark 1.1 in the model menu."), and none when it offers none; without `menu`, no hint. `contributorNoticeText(label)` returns the notice's words, `standardHintText(menu)` the hint's (or null). |
| `EffortSelect` | `id`, `model`, `value: Effort \| null`, `onChange(effort \| null)`, `disabled?`, `label?` ("Reasoning") | Reasoning effort with only the levels the model takes ("max" is Muse Wonder's). "Default" is null: leave the field out. |
| `Field` | `id` (the control's id), `label`, `hint?`, `children`, `className?` | A labeled field. The hint gets id `${id}-hint` for `aria-describedby`. |
| `TextInput`, `TextArea` | Any input or textarea props, plus `ref` | Styled native controls. |
| `Toggle` | `id`, `label`, `checked`, `onChange(checked)`, `disabled?` | A switch (`role="switch"`) with a clickable label. |
| `Segmented` | `label` (aria-label), `options: { value, label, disabled? }[]`, `value`, `onChange(value)`, `disabled?`, `size?` ("md" or "sm") | One of a few choices as pills, a radio group with arrow keys. The type comes from `value`, so `onChange={setState}` works. |
| `PresetPills` | `presets: { label }[]`, `active?: number \| null`, `onPick(index)`, `label?` ("Try"), `disabled?` | Example inputs as pills. |
| `Tabs`, `TabPanel` | Tabs: `label`, `tabs: { id, label, count? }[]`, `value`, `onChange(id)`, `idBase`, `className?`. TabPanel: `idBase`, `id`, `active`, `children`, `className?` | Underline tabs with arrow keys, Home and End. Only the active panel renders its children. Use one `useId()` as `idBase` for both. |
| `runOnModEnter(run)` | | An `onKeyDown` handler: Ctrl+Enter or Cmd+Enter runs. |
| `useModEnterHint(action)` | | The hint to show beside it, such as "Cmd+Enter to ask" on Apple platforms and "Ctrl+Enter to ask" elsewhere; null on touch screens with no keyboard. |
| `JsonEditor` | `id`, `value`, `onChange(text)`, `label?` ("Request body"), `rows?` (12), `resetTo?`, `hint?`, `disabled?` | A monospace JSON textarea that says "Valid JSON" or "Line 3, column 12: ...", with Format and (when `resetTo` differs) Reset. The text stays your state; parse it with `parseJsonText` (lib/docs/client/json). |
| `FileSlotInput` | `id`, `label`, `accept?`, `value: PickedFile \| null`, `onChange(file \| null)`, `disabled?`, `hint?` | Choose a file or one of the docs samples for the accept type (`samplesOf` in lib/docs/media/samples). Turns away files over 3 MB. `PickedFile` is `{ file: File; source: "upload" \| "sample"; sampleId? }`; read it with `readFileAs` (lib/docs/client/files). |

## Showing replies

| Export | Props | What it is |
|---|---|---|
| `ResponseView` | `result: DocsResult \| null`, `text?`, `children?`, `json?`, `usage?`, `model?`, `events?: EventLogEntry[]`, `running?`, `elapsedMs?` | Status (200 OK, 429 Too Many Requests, Stopped), the model that ran, latency, tokens and cost, the proxy's note; then Output, JSON and Headers tabs (Events too when `events` is given). Output is `children`, else `text`, else whatever the reply carries (text from any protocol, images, a transcript, a file to download, else the JSON). For a stream pass the final object as `json` (result.json is null for streams) and `running`/`elapsedMs` while it runs. Renders nothing with no result and not running. |
| `ReplyView` | `reply: Collected \| null`, `running?`, `events?`, `placeholder?` | A whole reply from the stream readers: web searches, reasoning summary, text with a caret while streaming, sources, tool calls, images. |
| `StreamView` | `text`, `reasoning?`, `refusal?`, `running?`, `events?`, `placeholder?` | The text part of ReplyView on its own. |
| `Citations` | `citations: Citation[]` | Numbered sources (one line per URL), opening in a new tab. |
| `Searches` | `searches: SearchCall[]` | "Web search: query" lines with status and result counts. |
| `ToolCalls` | `calls: ToolCall[]`, `title?` | Each call's name, call id and pretty arguments (as they stream). `prettyArguments(json)` formats arguments. |
| `Images` | `images: GeneratedImage[]`, `alt?` | Base64 images as a grid. |
| `EventLog` | `events: EventLogEntry[]` | The folded event log (`logEvent` in lib/docs/client/events builds it). |
| `UsageLine` | `model`, `usage` (any protocol's shape), `images?`, `webSearches?`, `audioMs?` | "2,000 in, 1,792 cached · 300 out, 250 reasoning · $0.0004 est." Muse Image counts images, SAM images or frames, Voice Transcribe audio. Nothing when there's nothing to count. Use `costExtrasOf(reply)` from lib/docs/client/cost for the extras. |
| `ErrorBox` | `error: DocsError \| null` | The error explained: rate limit (with a retry-after countdown), daily budget, paused demos, too large, unknown model or endpoint, blocked, timeout, a bad request; then the proxy's or Meta's message and code. Nothing for null or a stopped run. |
| `CodeView` | `method`, `path`, `body?`, `form?: FormSpec[]`, `stream?` (defaults to body.stream), `caption?` | The request as curl, Python (OpenAI SDK or requests) and TypeScript (OpenAI SDK or fetch); Messages uses the Anthropic SDK. Drawn like the mirrored code blocks: tabs in the block, syntax colors, copy button; key from `MODEL_API_KEY`. Long base64 shows as `<BASE64>`. The docs' `muse-spark-1.3-contributor` is written as Meta's `muse-spark-1.3`, with a note. Pass the exact body you send. |
| `JsonTree` | `value`, `openDepth?` (3), `label?` | Colored, foldable JSON; a folded object shows its `id`, `name` or `type`; base64 and long strings show their start and size. |
| `BlobOutput` | `blob`, `name` | A returned file: download link, and a preview for images. |
| `statusText(result)`, `latencyLabel(ms)` | | "429 Too Many Requests", "1.4 s". |

`DocsPageProvider`, `useDocsPage`, `DocsPageInfo` and `RecordedRequest` are re-exported from DocsPageContext.tsx.

## Client helpers (lib/docs/client)

Pure modules, safe in the browser and in tests. `api.ts` (docsCall, docsStream, sseReader) is the contract's.

- `models.ts`: `DEFAULT_TEXT_MODEL`, `DOCS_MODELS` per kind, `modelsFor(kind, allow?)`, `runsAs(model)` (muse-spark-1.3 becomes Contributor), `isContributor`, `docsModelLabel`, `kindOfModel`, `Effort`, `EFFORTS`, `effortsFor(model)`, `fitEffort(model, effort)` (send this, so a "max" left over from Muse Wonder doesn't reach a model that rejects it).
- `body.ts`: one neutral request (`NeutralRequest`: model, system, messages, maxOutputTokens, effort, summary, tools, parallelToolCalls, schema, stream, previousResponseId) to `responsesBody`, `chatBody`, `messagesBody` or `buildBody(protocol, n)`; `chatBodyWith(n, messages)` for prebuilt history; `mergeBody(base, extra)` (tools and include add up); `PROTOCOL_PATH`, `PROTOCOL_LABEL`.
- `stream.ts`: `responsesCollector()`, `chatCollector()`, `messagesCollector()`, `collectorFor(protocol)`: `push(event)` each SSE event (or a whole JSON reply) and `snapshot()` a `Collected` (text, reasoning, toolCalls with streamed arguments and callId, citations, searches, images, usage, id, model, final object, error, done). `collectReply(protocol, json)` for plain replies. `protocolOfPath`, `protocolOfReply`, `imageMime`.
- `cost.ts`: `tokenUsage(usage)` from any shape, `estimateCost(model, usage, extras)`, `estimateReplyCost(model, reply)`, `costExtrasOf(reply)`, `formatUsd`.
- `codegen.ts`: `codeSamples(request)`, `curlCode`, `pythonCode(req, "sdk" | "http")`, `typescriptCode(req, "sdk" | "http")`, `displayBody`.
- `pointer.ts`: `jsonGet`, `jsonSet` (copies, creates missing steps), `jsonHas`, `parsePointer`, `formatPointer`.
- `form.ts`: `FormSpec`, `FileSlot`, `FileSlotSpec`, `placeholderFileName`, `mimeOfName`.
- `json.ts`: `parseJsonText` (errors with line and column), `formatJson`.
- `schema.ts`: `validateJson(schema, value)` (a report with field-by-field checks), `strictSubsetProblems(schema)` (what strict mode would reject), `describeSchema`.
- `calc.ts`: `evaluate(expression)`, a safe arithmetic parser (no eval), `tidy`.
- `tools.ts`: `MOCK_TOOLS` (get_weather, get_time, calculator, lookup_order, search_docs, send_email), `resolveTools(tools, results)`, `runToolCall(tools, name, argumentsJson)`.
- `toolloop.ts`: the tool loop as data: `nextAction(steps, maxCalls)`, `nextModelBody(protocol, base, steps)`, `finalAnswer`, `requestedCalls`.
- `record.ts`: `trimForRecord(body)`, `describeForm(form)`, `outcomeOfReply`, `outcomeOfCollected`.
- `errors.ts`: `explainError`, `errorKind`, `waitLabel`.
- `endpoints.ts`: `isAllowedEndpoint(method, path)` (the proxy's list), `isStreamable`, `isBinaryReply`, `modelKindFor(path, model)`, `placeholderKind`.
- `events.ts`: `logEvent(log, event)`, `eventType`.
- `ask.ts`: `starterQuestions(title, slug)`, `trimHistory`.
- `recent.ts`: the responses and files this visitor created (`recentIds`, `rememberReply`), for id pickers.
- `files.ts`: `readFileAs(file, "dataUrl" | "base64")`, `fetchSample(sample)`, `sampleKindOf(accept)`, `uploadProblem(file)` (3 MB), `sizeLabel`.

## Tests

`npx tsx --test --experimental-test-module-mocks lib/docs/client/__tests__/*.test.ts components/docs/kit/__tests__/*.test.tsx components/docs/playgrounds/common/__tests__/*.test.tsx`

## Simple view and `pg-advanced`

The "Try it live" panel opens in a simple view (app/docs/docs.css, `.docs-try.is-simple`). Anything with the global class `pg-advanced` stays hidden until the reader turns on Options, as do `p.pg-hint`, `p.pg-muted` and any element left with only labels and advanced children. It is CSS only, so hidden controls stay mounted and keep their state and defaults. `Toggle`, `Segmented`, `EffortSelect` and `ModelSelect` mark themselves for common tuning controls; add the class yourself to anything else that only tunes a request. In a CSS Module component: `className={`${styles.row} pg-advanced`}`.

Never mark: the demo's main action, its required input, its result, an error, or the Contributor notice.
