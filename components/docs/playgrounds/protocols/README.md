# Protocols demos

The live demos for the protocol pages and their API reference (lib/docs/demos/protocols.ts lists the 18 pages). Built on the kit (`components/docs/kit`) and the text playgrounds (`components/docs/playgrounds/common`); everything here takes plain JSON props, so a DemoSpec can point at it directly, and the docs page adds `slug`.

## Components

| Export | Props | What it is |
|---|---|---|
| `ProtocolLab` (ProtocolLab.tsx) | `tabs: LabTab[]`, `start?` | Underline tabs, one demo per tab. A tab is `{ id, label, intro?, kind, props }` with `kind` `"flow"` (FlowRunner), `"chat"` (ChatPlayground), `"console"` (ConsolePresets), `"tools"` (ToolLoopPlayground) or `"structured"` (StructuredOutputPlayground). A tab mounts when it first opens and stays mounted. One tab shows no tab bar. |
| `FlowRunner` (FlowRunner.tsx) | a `FlowSpec`: `steps`, `vars?`, `model?`, `models?`, `paceMs?`, `intro?`; `runLabel?` | A page's pattern as real requests, each built from the replies before it. Run all steps, Run (or Retry) step N, Reset; per step the resolved request, the reply (text, tool calls, searches), the fields it lists, the page's checks and stream events, the request body, reply JSON, event log and code. Before a step runs, its path, body and code show the model and vars filled in and stand-ins such as `resp_from_step_1` for what earlier replies supply. Every call counts toward the live docs' per-minute limits: `paceMs` spaces Run all's steps, a 429 with a short retry-after is waited out once, and one that persists stops the run at that step. Documented-error checks and `cleanup` steps aren't recorded for the copy prompt. |
| `ModelMenu` (ModelMenu.tsx) | `value`, `onChange(model)`, `allow?`, `disabled?` | The kit's text ModelSelect with the Contributor notice under it, whose Standard-mode hint names only the Standard models the menu offers. FlowRunner and SchemaExplorer use it. |
| `ConsolePresets` (ConsolePresets.tsx) | `presets: { label, note?, console: ApiConsoleProps }[]`, `label?`, `start?` | The kit's ApiConsole with a page's working requests as pills. |
| `ProtocolCompare` (ProtocolCompare.tsx) | `prompt?`, `system?`, `presets?`, `followUps?`, `model?`, `models?`, `effort?`, `maxOutputTokens?`, `stream?` | One question to Responses, Chat Completions and Messages at once, lined up in a table: reply, reply shape, where the text is, usage field names, cost, request size, and what each format calls the instructions, the token limit and reasoning. Follow-ups carry the conversation each format's way. A turn joins the conversation only when a format answered and nobody pressed Stop; a format that failed leaves that turn out of its own history (Responses chains from its latest stored response), and the Next turn row says so. A chained Responses turn that hits the storage-lag 400 is retried once. |
| `SchemaExplorer` (SchemaExplorer.tsx) | `source?` (the schemas page slug), `examples` (each may limit its `models`, as background runs keep to Muse Spark), `targets`, `starters?`, `initial?`, `model?`, `models?`, `markdown?` (tests) | A schemas page as a searchable list and a detail pane: fields, types that open the schemas they name, Used by, and for schemas with a target, a live example whose real request, reply or stream event is checked against the table field by field. Reads the page from `/docs/md/<source>` on mount. |

## Flows (flow.ts)

A step is `{ id, title, method?, path, body?, stream?, note?, expect?, poll?, retry?, independent?, cleanup?, waitMs?, show? }`. Paths and bodies take templates:

- `{{model}}`, `{{vars.name}}`, `{{sample:field-report}}` (a docs sample as a data URL), `{{sample64:cat-sofa}}` (bare base64)
- `{{turn1.id}}`, `{{call.output[type=function_call].call_id}}`, `{{call.choices[0].message}}`: a field of an earlier reply. A string that is only a template becomes the value itself; `{ "$spread": "turn1.output" }` splices an array into an array.
- `expect`: `status` (the documented status, or a list), `events` (types a stream should carry), `checks` (`{ path, label, equals?, present?, empty?, oneOf?, matches? }`, templates allowed in `equals`; `matches` is a case-insensitive pattern, which the 400 checks use on `error.param` or `error.message` so a 400 for another reason doesn't pass).
- `poll` repeats a GET until a field reaches a value (every 3 s or more: each poll counts toward the per-minute limit); `retry` sends again on listed statuses (a read right after a create can 404 while storage catches up); 5xx replies are retried once, and a 429 with a short retry-after is waited out once. `independent` steps don't stop Run all when they fail. `cleanup` marks a delete that only tidies up, so it isn't recorded for the copy prompt.
- `previewTemplate(value, ctx, steps)` fills what's known before a run and puts stand-ins (`resp_from_step_1`, `<output items from step 1>`) where earlier replies go; FlowRunner and SchemaExplorer show requests and code that way.

## Data

- `compare.ts`: the three formats' names for the same things, the bodies a question becomes turn by turn (`compareBodies`, `responsesChain`), what the next turn sends in words (`nextTurnNote`), where a reply's text and usage are.
- `schema-parse.ts`: a schemas page's Markdown as `SchemaDef`s (fields, Type lines, references both ways, from links and from schema names written in code) and type cells as alternatives. `schema-check.ts`: a value checked against a schema, union members told apart by their `type`, `role` or `object`.
- `schema-examples.ts`: the three schemas pages' live examples and targets. `inline-md.ts` and `Markdown.tsx`: the cells' Markdown (code, bold, links) without HTML.

## Tests

`npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/protocols/__tests__/*.test.ts components/docs/playgrounds/protocols/__tests__/*.test.tsx`

`__tests__/fixtures/` holds trimmed real replies from the docs proxy (safety identifiers replaced, encrypted payloads cut).
