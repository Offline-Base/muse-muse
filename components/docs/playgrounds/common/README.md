# Text playgrounds

Client components configured by plain JSON props, so a page group's DemoSpec can point at one directly (`Component: ChatPlayground, props: {...}`; the page adds `slug`). Import from `@/components/docs/playgrounds/common` or the file itself. Each has a model menu with the Contributor notice, Run and Stop, errors through ErrorBox, a "Show code" toggle with the exact request, and records what ran for the copy prompt. They're built from the kit (components/docs/kit, see its README.md).

Defaults: model `muse-spark-1.3-contributor`, reasoning effort `"low"` (quick and cheap; pass `null` to leave it to the model).

## `ChatPlayground`

Responses, Chat Completions or Messages. Responses follow-ups use `previous_response_id` (unless `extraBody.store` is false); the other two resend the history.

| Prop | Default | |
|---|---|---|
| `protocol` | `"responses"` | `"responses" \| "chat" \| "messages"` |
| `protocols` | none | Show a switcher between these. Switching starts a new conversation. |
| `model`, `models` | Contributor, all text models | Starting model; `models` limits the menu. |
| `system` | "" | Instructions: `instructions` (Responses), a developer message (Chat), `system` (Messages). |
| `prompt`, `placeholder` | | The starting question and the box's placeholder. |
| `effort` | `"low"` | `Effort \| null`. |
| `summary` | false | Ask for a reasoning summary (Responses only). |
| `stream` | true | |
| `multiTurn` | true | Keep the conversation across runs. |
| `maxOutputTokens` | none | Messages always sends `max_tokens` (4096 when unset). The proxy clamps all three. |
| `presets` | none | `{ label, prompt, system?, extraBody? }[]`; a preset's extraBody is merged over the page's for that run. |
| `extraBody` | none | Merged into every request: `{ tools: [{ type: "web_search" }] }`, `{ include: ["web_search_call.results"] }`, `{ text: { format: {...} } }`. `tools` and `include` add up; other keys win. |
| `extraBodyFor` | none | `{ responses?: {...}, chat?: {...}, messages?: {...} }`, merged after `extraBody` for one protocol. |
| `showSystem`, `showOptions` | true, true | Hide the instructions field, or the effort, summary and stream controls. |

It shows the reasoning summary, citations and web searches, and notes when the model asks for a tool (it doesn't run tools; use ToolLoopPlayground).

## `AskPagePanel`

`{ slug }`. The "Ask about this page" chat. POSTs `{ slug, messages, model }` to `/api/docs/ask` (`ASK_BASE`) through docsStream and reads the answer as a Responses stream. Three starter questions from the page title (from DocsPageContext, or the slug), the last six turns as history, a model menu of Contributor, Muse Spark 1.2 and Muse Wonder 1.0. Not recorded for the copy prompt, so a question never replaces the API request the reader last ran. "Show code" gives the Responses request a reader would send to build the same panel (`askCodeBody`): the page's Markdown as instructions, the question as input.

## `ApiConsole`

The contract's props:

```ts
interface ApiConsoleProps {
  method: "GET" | "POST" | "DELETE";
  path: string;              // Meta's, without /v1: "responses", "files/file-abc/content", "responses/resp_1?stream=true"
  body?: unknown;            // a JSON body to edit
  form?: FormSpec[];         // multipart: { name, value? } or { name, file: { label, accept?, as? } }
  fileSlots?: FileSlot[];    // { pointer, target?: "body" | "form", label, accept?, as?: "dataUrl" | "base64" | "file" }
  stream?: boolean;          // read the reply as SSE; defaults to body.stream === true
  title?: string;
  hideIdHint?: boolean;      // beyond the contract: drop the "upload a file first" line when the host offers the upload
}
```

- The path is editable. Paths the proxy doesn't forward say so up front. Example ids (`resp_abc123`, `file_abc123`, `{response_id}`) offer the responses and files this visitor created.
- The body opens in a JSON editor with `muse-spark-1.3` already shown as `muse-spark-1.3-contributor`, a model menu when it has a `model`, and a "Stream the reply" switch on streamable endpoints (it adds `stream_options.include_usage` for Chat Completions).
- Body slots read the picked file or sample into a data URL (or bare base64) at the JSON Pointer when it sends; form files go as multipart parts. Run waits until every slot has a file. Files stay under 3 MB.
- POST streams render live; a GET `?stream=true` (a background response) is read whole and replayed. `files/{id}/content` replies come with a download.
- `FormSpec`, `FileSlot` and `FileSlotSpec` are exported from this file (defined in lib/docs/client/form.ts).

## `StructuredOutputPlayground`

| Prop | Default | |
|---|---|---|
| `presets` | required | `{ label, name, schema, prompt, system? }[]`. The first loads on start. |
| `protocol`, `protocols` | `"responses"` | `"responses"` (text.format) or `"chat"` (response_format). |
| `model`, `models` | Contributor | |
| `strict` | true | Warns before sending when strict mode would reject the schema (additionalProperties, required, allOf, oneOf, root type). |
| `effort` | `"low"` | |
| `stream` | true | |

The reply is parsed and checked against the schema field by field (pass and fail list, plus the parsed JSON).

## `ToolLoopPlayground`

| Prop | Default | |
|---|---|---|
| `prompt` | required | |
| `tools` | required | Built-in mock tools by name (`get_weather`, `get_time`, `calculator`, `lookup_order`, `search_docs`, `send_email`) and/or definitions `{ name, description?, parameters?, strict?, result? }`. A definition without code or `result` echoes its arguments. |
| `results` | none | Fixed results per tool name, over the built-ins' own answers. |
| `protocol`, `protocols` | `"responses"` | `"responses"` (previous_response_id plus function_call_output) or `"chat"` (assistant tool_calls plus tool messages). |
| `model`, `models` | Contributor | |
| `system` | "" | |
| `parallel` | true | `parallel_tool_calls`. Parallel calls run together. |
| `maxCalls` | 6 | Most model calls in one run. |
| `effort` | `"low"` | |
| `stream` | false | Stream each model call, so arguments appear as they arrive. |
| `presets` | none | `{ label, prompt }[]` |
| `advancedPresets` | false | Keep the presets behind Options, when the demo shows its own row of examples above this. |

Step runs the next action (call the model, run the tools, send the results), Run all goes to the final answer. Each step shows its request and reply JSON. The mock tools run in the page with sample data; nothing leaves it, and send_email only pretends.

## `PresetRow`

PresetPills for the simple view: the first `keep` pills (default 5) always show, and the rest wait behind Options as a second row. Use it for any preset list that would wrap.
