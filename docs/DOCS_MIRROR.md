# Docs: a live mirror of Meta's Model API docs

Ethan's ask (Oct 29, 2026): a **Docs** page in the sidebar that is a near clone of https://dev.meta.ai/docs, with **every page** mirrored, an **interactive way to try what each page lists** on the real API, and a **button to copy a custom prompt for your coding agent**. UI references: the four screenshots in `/private/tmp/claude-501/-Users-ethancastro/fe5f77e3-8ea1-43b7-b033-a8419e6a5382/images/` (`1.png` overview top, `2.png` code blocks and the callout, `3.png` the "Explore the docs" cards, `4.png` a long JSON block and a callout). Read them before touching the UI.

Branch `docs` in `~/muse-muse-builds`. This file is the contract every part is built against. If the code and this file disagree, fix one of them in the same change.

## Rules that apply to every part

- **The key never leaves the server.** Demos call `/api/docs/...` on our own origin. The proxy adds `DOCS_MODEL_API_KEY` on the server (local runs fall back to `MODEL_API_KEY`; on Vercel the demos pause without it). Never put a key in client code, `NEXT_PUBLIC_*` vars, logs, error messages, response headers, test fixtures, sample files or commit messages. Never print `.env.local`. Users are never asked for a key (docs/DESIGN.md, "Never ask for keys").
- **Never call `muse-spark-1.3`.** The proxy rewrites it to `muse-spark-1.3-contributor` (lib/meta/spark.ts) and says so in `x-docs-model`. Mirrored text keeps Meta's `muse-spark-1.3`; demos, generated code (Show code) and copy prompts use `muse-spark-1.3-contributor`, with a note that Contributor mode lets Meta train on what's sent and that dropping `-contributor` gives Standard mode.
- **Contributor mode is disclosed.** Meta may train on what's sent to a `-contributor` model (pricing-rate-limits page). Whenever a demo is about to send to one, show the kit's `ContributorNotice` ("Runs on Muse Spark 1.3 Contributor: Meta may use what you send to train future models. Don't send anything private.") and offer `muse-spark-1.2` or `muse-wonder-1.0` (Standard mode) in the model menu.
- **No em dashes in anything we write**: UI copy, prompts, comments shown to users, the copy-prompt text. The renderer also swaps em dashes in Meta's prose (not in code) for ", " (": " in headings).
- **Branding** (docs/DESIGN.md "Dashboard-native UI"): Meta's layout, type scale, colors and pill shapes are fine and wanted. No Meta logo or wordmark, no "Meta" in our product header, no Meta font files. The sidebar keeps the Muse Muse brand and Concept tag; every docs page ends with the mirror credit.
- **This Next.js (16.4) differs from your training data.** Read the relevant guide in `node_modules/next/dist/docs/` before using a Next API (route handlers, params as Promises, `after`, metadata, `redirect`, `notFound`, config keys).
- **Code style**: match the repo. TypeScript strict, small pure modules with doc comments that say why, no new lint config. Tests use node:test: `npx tsx --test --experimental-test-module-mocks <files>`. Nothing in a test calls Meta, Neon or the network.
- **Machine load**: typecheck with `npx tsc --noEmit --incremental false` (about 7 s). Don't run `next build` unless your part says so. Don't start a dev server unless your part says so; port 3001 is the docs dev server, never use port 5037 or 9333. Don't `npm install` unless your part says so.
- **Only touch the files your part owns** (below). A genuine bug in a shared file may get a small Edit (never a Write over someone else's file); list it in your report.
- **Paid calls**: only where your part says so, cheapest settings, and report what you spent. Never put the key in a command line: read it inside the process from `.env.local`.

## Pieces and owners

| Part | Owns |
|---|---|
| Sync (done) | `scripts/docs/sync-meta-docs.ts`, `lib/docs/mirror-parse.ts`, `content/meta-docs/**` (`npm run docs:sync`) |
| Contracts (done) | `lib/docs/pages.ts`, `lib/docs/client/api.ts`, `lib/docs/demos/types.ts`, `lib/docs/demos/index.ts`, `components/docs/kit/DocsPageContext.tsx` |
| F1 Pages and UI | `app/docs/**` (except `app/docs/**/route.ts` under `app/api`), `lib/docs/markdown*.ts(x)`, `lib/docs/highlight.ts`, `lib/docs/curl.ts`, `lib/docs/agent-prompt.ts`, `lib/docs/search.ts`, `components/docs/page/**`, `components/shell/**` (the sidebar switch), `next.config.ts`, `package.json` (adds `marked`, `shiki`) |
| F2 Proxy | `app/api/docs/**`, `lib/docs/proxy/**`, `lib/env.ts` (docs getters), `lib/usage.ts` and `lib/db/schema.ts` (the `"docs"` source, the `docs_objects` table), `drizzle/0009_*`, `app/api/cron/cleanup` (docs cleanup step) |
| F3a Core kit | `components/docs/kit/**` (except DocsPageContext), `components/docs/playgrounds/common/**` (text playgrounds), `lib/docs/client/**` (except api.ts) |
| F3b Media kit | `components/docs/media/**`, `lib/docs/media/**`, `public/docs-samples/**` |
| G* Page groups | `lib/docs/demos/<group>.ts`, `components/docs/playgrounds/<group>/**` |

## Content

`content/meta-docs/pages/<slug>.md` is Meta's Markdown for `https://dev.meta.ai/docs/<slug>` (from `<slug>.md`), with each heading's live anchor appended as `{#id}`. `pages.json` holds titles and descriptions, `nav.json` the sidebar, `source.json` the sync time. `lib/docs/pages.ts` reads them: `DOCS_PAGES`, `docsPage(slug)`, `docsMarkdown(slug)` (fs, memoized), `docsHref(href)` (maps dev.meta.ai links to `/docs/...`, `/platform` to `/dashboard`), `docsNav()`.

Markdown conventions in the mirror (the renderer handles each):

- Code tabs: a paragraph that is only bold text (`**Python (OpenAI SDK)**`, `**curl**`) directly before a fenced block is that block's tab label; consecutive pairs are one tab group.
- Callouts: a blockquote whose first line is `> **NOTE: Title**` (also TIP, WARNING, IMPORTANT, CAUTION).
- Cards: a list where every item is `[Title](url): description` renders as the card grid in `3.png`.
- Tables, images (`https://dev.meta.ai/docs-assets/...`, hotlinked, lazy), `diagram`/`text` fences (plain preformatted).
- Raw HTML in the Markdown is shown as text, never injected.

## Routes

| Route | What |
|---|---|
| `/docs` | Redirects to `/docs/overview` |
| `/docs/<slug>` | One mirrored page, for every slug in `pages.json`; unknown slugs 404 with `app/docs/not-found.tsx`, inside the docs layout so the docs sidebar keeps its styles |
| `/docs/search.json` | Search index: title, nav label, description, headings with anchors, section |
| `/docs/md/<slug>` | The page's Markdown for **Copy page**, fetched on click: `{#id}` anchors removed, links absolute, built at build time |
| `POST /api/docs/v1/<meta path>` and GET/DELETE | The proxy (below) |
| `POST /api/docs/ask` | "Ask about this page" chat, grounded in the page's Markdown |
| `POST /api/docs/asr-realtime` | Realtime transcription relay (WebSocket upstream, SSE down) |
| `GET /api/docs/limits` | What the UI shows about limits: `{ live, models, maxBodyBytes, perIpDailyUsd, ipSpentUsd, docsDailyCapUsd, docsSpentUsd, perIpRequestsPerMinute, perIpRequestsPerDay, perIpInFlight, resetsAt }`. It also sets the visitor cookie, so the docs layout calls it once per tab (`DocsVisitor`) before any demo runs |

## Page layout (F1)

The sidebar becomes the docs sidebar on `/docs/*` (like dev.meta.ai, where the docs sidebar replaces the dashboard's): brand, a **Search** box (opens the palette, also Cmd/Ctrl+K), a **Dashboard** row back to `/dashboard`, then the sections from `docsNav()` with their uppercase titles, links and collapsible groups (open when they hold the current page), and the usual account chip and disclaimer at the bottom. Elsewhere the platform sidebar gains a **Docs** row (`/docs`, icon `doc`) in place of the external "Model API docs" link. The mobile drawer follows the same switch.

Each page: the content column (white surface, Meta's type scale as measured on dev.meta.ai's computed styles: H1 29/36 at weight 600, H2 20/28, H3 17/24, body 16/24; blue underlined links), and on wide screens the right **On this page** list (H2 and H3, scrollspy, the active one bold with a dark left bar, kept near the middle of its column on long pages). At 1200 px and below the list sits behind a **Table of contents** pill under the actions row, as on dev.meta.ai, and opens in place. In the content, in order:

1. The H1, then an actions row: **Copy prompt for your coding agent** (blue pill; its chevron opens options: agent Claude Code, Codex, Cursor, OpenCode, Muse Code or Other; language Python, TypeScript or curl; "Include what I just ran"), **Copy page** (the Markdown with absolute links, from `/docs/md/<slug>`), **View on dev.meta.ai**.
2. The lead paragraphs (everything before the first H2).
3. The **Try it live** card: the page's DemoSpec component (title, blurb), and a second tab **Ask about this page** (F3a's `AskPagePanel`). A page without a DemoSpec shows the Ask tab only.
4. The rest of the page. Every code block or tab group that contains a request to `https://api.meta.ai/v1/...` (curl, an HTTP request line, or an OpenAI or Anthropic SDK call, `requests` or `fetch` with literal arguments: lib/docs/sdk-request.ts) gets a **Run** button in its header. It opens an inline panel under the block: the parsed request with an editable JSON body, file pickers for placeholders (`@file`, `$(base64 ...)`, `<BASE64>`, `file-...` ids), and Send through the proxy, with F3a's response viewer. Each Run records the request in DocsPageContext.
5. Previous and next page (sidebar order), then the credit: "Mirrored from dev.meta.ai/docs/<slug> (synced <date>). Text and examples © Meta. Live demos run on Muse Muse's key." with the link.

Light and dark themes both, using the CSS variables in `app/globals.css`. Docs CSS goes in `app/docs/docs.css`; the kit's in `components/docs/kit/kit.css`; both imported by `app/docs/layout.tsx`. Page-group components use CSS Modules.

**Ask Muse Muse to build** sits under Try it live in the actions, and in the Try it live panel's footer. It opens `components/docs/page/BuildWithThis`: the same `Composer` as the Make page (uploads, limits, sign-in), three ideas from `buildIdeas`, and a fold showing what the page adds. `buildContext` in `lib/docs/build-note.ts` (pure, tested) writes that part: the feature, how to use it, its facts, the docs link and the call the reader just tried, but never what they typed into a demo. It goes through `POST /api/inspirations` after the reader's words, so a build from the docs is a normal build under the normal quota. An empty box is allowed: Muse Muse picks the idea. The build room folds the page's part (`splitBuildNote`). A `#build` link opens the dialog, which is how a reader returns after signing in.

The copy-prompt text comes from `buildAgentPrompt` in `lib/docs/agent-prompt.ts` (pure, tested): the page's `agentPrompt` (task, facts, checklist, snippets) or a fallback fit to the kind of page (a guide or recipe, the cookbook index, an API reference endpoint or schemas page, a Muse Code page, the changelog, an open-weight page), the page's Markdown URL for the agent to read, the setup facts (base URL `https://api.meta.ai/v1`, `Authorization: Bearer $MODEL_API_KEY` from the environment, the model), the last request the reader ran when they asked for it, the snippet for the chosen language, and "done when" checks. The model it names for the reader's code is `muse-spark-1.3-contributor` wherever Meta's examples say `muse-spark-1.3` (Ethan's rule: Spark 1.3 only ever runs in Contributor mode), with the Contributor note; the kit's `CodeView` writes code the same way. Plain text, no em dashes, short enough to paste (aim under 4,000 characters; trim the body of the last request).

**Layout change (Oct 30, from Ethan's side-by-side screenshots).** The reading column is Meta's page as it is. The H1 is followed directly by the text. "Try it live" is no longer a card in the column: it is a side panel (860 px, `components/docs/page/TryItLive.tsx`, also opened by a `#try-it-live` link), and the demo mounts on first open. The actions (Try it live, Copy agent prompt, Copy page, View on dev.meta.ai) and the disclaimer sit under "On this page" on wide screens, and in a row under the H1 at 1200 px and below. The typeface is Figtree (`app/docs/font.ts`), the closest free match to Meta's Optimistic, which we don't ship. The panel opens in a simple view: the demo's title, what to ask, Run and the result, with the Contributor notice. The kit marks controls that only tune a request `pg-advanced` (model menu, reasoning, streaming, protocol switch, Show code and similar, in `components/docs/kit/Field.tsx` and `ModelSelect.tsx`), and they stay hidden until the reader turns on Options, which is remembered across pages. New demos get this by using the kit's controls. Where this section says otherwise, this note wins.

## Proxy (F2)

`/api/docs/v1/<path>` mirrors `https://api.meta.ai/v1/<path>` for these, and nothing else (404 `unknown_endpoint`):

| Method | Path | Notes |
|---|---|---|
| GET | `status` | Upstream needs no key |
| GET | `models`, `models/{id}` | |
| POST | `responses` | JSON; `stream` allowed; `background` (a boolean) on text models with `store` on, held at its worst case and settled when it finishes (below) |
| GET, DELETE | `responses/{id}` | Only ids this visitor created |
| POST | `responses/{id}/cancel` | Only this visitor's |
| POST | `responses/input_tokens` | |
| POST | `chat/completions` | JSON; `stream` allowed |
| POST | `messages`, `messages/count_tokens` | Anthropic-style bodies; the proxy sends Meta's auth |
| POST | `files` | multipart, purpose `user_data`; the proxy sets `expires_after` to an hour |
| GET | `files` | Lists only this visitor's files (the newest 20) |
| GET, DELETE | `files/{id}`, GET `files/{id}/content` | Only this visitor's |
| POST | `images/generations`, `images/edits` | `n` at most 2 |
| POST | `asr/transcribe` | multipart (`request` JSON part + `audio`), WAV only (docs/SPIKES.md) |

- **Models.** Text endpoints take `muse-wonder-1.0`, `muse-spark-1.3-contributor`, `muse-spark-1.2`, `muse-spark-1.2-contributor`, `muse-spark-1.1` (and `muse-spark-1.3`, rewritten). `responses` also takes `muse-image-1.0` and `sam-3.1`; images take `muse-image-1.0`; asr takes `muse-voice-transcribe-1.0`. Anything else: 404 `model_not_found` listing what's allowed.
- **Clamps.** Output tokens (`max_output_tokens`, `max_tokens`, `max_completion_tokens`; set when missing): Wonder 4,096; Spark Standard 8,192; Spark Contributor 16,384. A limit that isn't a number from 1 to the cap (null, a string, `1e400`, which JSON.parse reads as Infinity and JSON.stringify sends as null) becomes the cap rather than Meta's maximum. Images' `n` ends up 1 or 2 (null is dropped). `max_tool_calls` is set to 5 when a built-in tool (`web_search`, `tool_search`) is on. Multipart fields the proxy checks (`model`, `n`, `request`, `purpose`, `file`, `audio`, `expires_after`) may appear once. Say what changed in `x-docs-note`.
- **Limits.** Same-origin only for POST and DELETE (a cross-site `Origin` or `Sec-Fetch-Site: cross-site` gets 403). Per IP (Vercel's `x-forwarded-for`/`x-real-ip`, IPv6 by /64 via `clientIpKey`): 20 requests a minute and 400 a day across the proxy, ask and realtime; 4 in flight (`DOCS_IP_REQUESTS_PER_MINUTE`, `DOCS_IP_REQUESTS_PER_DAY` and `DOCS_IP_IN_FLIGHT` override these, for a local test server); `DOCS_IP_DAILY_USD` (default 2) a day. Every reader together, since Meta limits per team and per model, not per key (429 `model_busy` and `uploads_busy`): runs a minute per model (50 on Spark Contributor and Muse Image, whose team limit is 150 and shared with live products; 300 on the other text models and SAM; 60 on voice) and 1,000 uploads an hour. All docs: `DOCS_DAILY_SPEND_CAP_USD` (default 25) a day, and the platform's `DAILY_SPEND_CAP_USD` still applies; both totals are read after the call's own reservation is written, so calls arriving together can't all pass. A dollar cap of 0 pauses the paid calls (503 `paid_paused`) and keeps the free ones. Bodies over 4.5 MB: 413 (the demos keep uploads under 3 MB). `DOCS_LIVE=off` pauses every live call with 503 `docs_paused`.
- **Metering.** Reuse the gateway's pieces (lib/gateway: `estimateCost`, `meterBody`, `reserveSpend`/`settleSpend`, `hitRateLimits`, `acquireInFlight`), and add chat completions and messages usage (plain and streamed). Usage rows get `source: "docs"`. Per-IP spend lives in `rate_limits` rows keyed `docs-usd:<ip>` for the UTC day, counting micro-dollars. A reply that doesn't show all it used keeps its estimate rather than settling lower: a stream cut off before its final usage (the estimate counted the input, which only the final usage reports), or a JSON reply without usage. Background responses (lib/docs/proxy/background.ts) hold their worst case (the model's whole context window on every pass, the output cap, every search), which keeps Muse Wonder out of the background at $2 a reader; the hold waits in the response's `docs_objects.hold` and is settled from Meta's usage when the reader retrieves (JSON or streamed), cancels or deletes the finished response, or in the hourly sweep. Background is read from the reply too (`background: true`, or status queued or in progress).
- **Ownership.** A `mm_docs` cookie (random id, httpOnly, SameSite=Lax, Secure on https, 30 days, path `/api/docs`) names the visitor. Files and responses created through the proxy are recorded in `docs_objects (id, kind, visitor, created_at)`; reads, deletes and cancels of other ids get 404. Ids inside a body count too: `previous_response_id` and every `file_id` (at most 64 per request) must be the visitor's, and stored conversations, prompt templates and `item_reference` are refused (400 `unsupported_reference`). `GET files` looks up the visitor's own files one by one instead of listing the account (the newest 20). A multipart field named like a `file_id` (`images[0][file_id]`) is checked too. Uploads must use purpose `user_data`, and expire at Meta an hour after upload. The hourly cleanup cron settles finished background responses, then deletes docs files over an hour old and stored docs responses over a day old, upstream and in the table, in batches until it is caught up or near its time limit.
- **Safety identifier.** When a request carries none, the proxy adds a hashed per-visitor id (`safety_identifier`; `metadata.user_id` on Messages; `user` on images), so Meta can act on one visitor rather than on the whole key.
- **Headers back**: the upstream content type, `retry-after`, request ids, plus `x-docs-model` (the model actually called) and `x-docs-note`. Never upstream auth or cookies. SSE passes through unbuffered.
- **Errors**: `{ error: { type, code, message } }` like the gateway, with messages written for a docs reader ("Live demos are limited to 20 runs a minute. Try again in 12 s."). Meta's own errors pass through, except a 401, which is replaced with the docs' message so nothing about the key reaches the browser. PUT and PATCH are routed only to answer 404 `unknown_endpoint`.
- **Ask**: `POST /api/docs/ask { slug, messages: [{ role: "user" | "assistant", content }], model? }` streams a Responses call on `muse-spark-1.3-contributor` (or a Standard model when asked), low reasoning, 2,000 output tokens, with instructions holding the page's Markdown and "answer from this page, say when it doesn't cover something, cite the section". Same limits.
- **Realtime**: `POST /api/docs/asr-realtime?model=&mode=&diarization=` with an `audio/wav` body (mono 16-bit, 16 or 24 kHz, at most 60 s) opens `wss://api.meta.ai/v1/asr/realtime`, sends the handshake with the key (the credential travels in the first frame, see `api-reference/voice/realtime`), streams the PCM in 80 ms frames at real-time pace, ends with `{"type":"endStream"}`, and relays each server frame as server-sent events: `event: handshake` first (the acknowledgement), then each frame under its own `type` (`event: transcript`, `event: speechComplete`, ...), `event: error` on a failure, and `event: done` last with `{ ok, sessionId, code, audioMs, processedMs }`. An error frame about auth or the credential, and a 1008 close before the acknowledgement, become the docs' own key message (as the HTTP proxy replaces a 401), and a close before the acknowledgement never relays its reason. Billed by audio duration.

## Kit (F3a, F3b)

Every demo is built from the kit so they look and behave alike. F3a, core (`components/docs/kit/`, `components/docs/playgrounds/common/`, `lib/docs/client/`):

- `useDocsRun()`: runs `docsCall`/`docsStream`, tracks idle/running/done/error, elapsed time, abort, and records the request in DocsPageContext.
- UI: `Field`, `ModelSelect` (per endpoint kind, with the contributor notice), `RunButton`, `JsonEditor` (validates, formats), `ResponseView` (status, model, latency, tokens and cost; Output, JSON and Headers tabs), `StreamView` (text as it arrives, reasoning summary, event log), `UsageLine` (cost from lib/meta/pricing), `ErrorBox` (rate limit and budget errors explained), `ContributorNotice`, `CodeView` (the current request as curl, Python and TypeScript, from `lib/docs/client/codegen.ts`).
- Playgrounds configured by JSON props: `ChatPlayground` (Responses, Chat Completions or Messages; model, system, reasoning effort, streaming, multi-turn, presets, `extraBody` merged into the request), `AskPagePanel`, `ApiConsole` (any allowlisted method and path with an editable body; the Run panel and the API reference pages use it), `StructuredOutputPlayground` (schema presets, validates the reply), `ToolLoopPlayground` (tool definitions plus built-in mock tools by name, steps through call, local result, final answer; parallel calls; Responses or Chat Completions).
- Client helpers: Responses, Chat Completions and Messages stream readers that collect text, reasoning, tool calls, citations, images, usage and the response id.

F3b, media (`components/docs/media/`, `lib/docs/media/`, `public/docs-samples/`):

- Helpers: file to data URL, image downscale (longest side and quality so a data URL stays under about 1.5 MB), audio to 16 kHz mono 16-bit WAV (Web Audio decodes anything that isn't WAV already, a windowed-sinc filter resamples, then the WAV header), microphone recording to WAV, video size check, SAM output parser (the wire format on `sam/reading-segmentation`, envelope checked) and mask pixels through a pluggable decoder (`setMaskRasterDecoder` in `lib/docs/media/sam-mask.ts`). Meta documents the mask payload's envelope but not its coder, so until a decoder is registered the overlays draw exact boxes and say masks are pending (see Open items).
- UI: `FilePicker` (drop, choose, or pick a sample), `AudioRecorder`, `ImageOutput`, `MaskOverlay` (boxes, masks, labels, confidence on a canvas over the image or video frame).
- Playgrounds: `VisionPlayground`, `ImageGenPlayground` (Responses multi-turn with `previous_response_id`, or images/generations and images/edits), `VideoPlayground`, `TranscribePlayground` (file and microphone, realtime via `/api/docs/asr-realtime`), `SegmentPlayground` (text, box and point prompts; image and short video), `FilesPlayground` (upload, list, retrieve, content, delete, then use the id in a Responses call).
- Samples in `public/docs-samples/` with a `README.md` saying where each came from and its license. Demos fetch samples from our origin and send them inline, so they work on localhost too.

## Page groups (G*)

Every page gets a DemoSpec in its group file: a demo that exercises what the page teaches, on the real API where the page is about the API, and the page's `agentPrompt`. Pages about things a browser can't run (Muse Code CLI features, self-hosting open weights, training) get an interactive builder or explorer instead (a command, config or settings builder, a calculator, a filterable explorer), plus a live call where it fits (for example the same prompt on hosted Muse Spark). The groups and their slugs are in `lib/docs/demos/index.ts` (`DEMO_GROUPS`).

## Defaults

| Setting | Default |
|---|---|
| `DOCS_MODEL_API_KEY` | Local runs fall back to `MODEL_API_KEY`. On Vercel, unset pauses the demos (503 `docs_paused`) |
| `DOCS_LIVE` | on |
| `DOCS_DAILY_SPEND_CAP_USD` | 25 (0 pauses paid calls) |
| `DOCS_IP_DAILY_USD` | 2 (0 pauses paid calls) |
| Demo text model | `muse-spark-1.3-contributor` |

## Kit contract

These signatures are fixed so the parts can be built at the same time. F3a implements the first block, F3b the samples catalog's contents; everyone else imports them. Each kit folder also gets a short `README.md` listing every export and its props, for the page groups.

```ts
// components/docs/kit/useDocsRun.ts  (F3a)
import type { CallInit, DocsError, DocsResult, SseEvent } from "@/lib/docs/client/api";
import type { RecordedRequest } from "@/components/docs/kit/DocsPageContext";
export type RunState = "idle" | "running" | "done" | "error";
export interface RunOptions extends CallInit {
  /** Read the reply as server-sent events, calling onEvent for each. */
  stream?: boolean;
  onEvent?: (e: SseEvent) => void;
  /** What to record for the copy-prompt ("Include what I just ran"); false records nothing. */
  record?: Partial<RecordedRequest> | false;
}
export function useDocsRun(): {
  state: RunState;
  result: DocsResult | null;
  error: DocsError | null;
  elapsedMs: number;
  run(path: string, init?: RunOptions): Promise<DocsResult>;
  abort(): void;
  reset(): void;
};

// components/docs/kit/index.ts re-exports these (F3a):
export function ModelSelect(p: { kind: "text" | "vision" | "image" | "sam" | "voice"; value: string; onChange(model: string): void; allow?: string[] }): JSX.Element;
export function RunButton(p: { running: boolean; onRun(): void; onStop?(): void; label?: string; disabled?: boolean }): JSX.Element;
export function ResponseView(p: { result: DocsResult | null; text?: string; children?: ReactNode }): JSX.Element | null;
export function ErrorBox(p: { error: DocsError | null }): JSX.Element | null;
export function ContributorNotice(p: { model: string }): JSX.Element | null; // renders only for -contributor models
export function CodeView(p: { method: "GET" | "POST" | "DELETE"; path: string; body?: unknown; form?: FormSpec[] }): JSX.Element;
export function UsageLine(p: { model: string | null; usage: unknown }): JSX.Element | null;
export const DEFAULT_TEXT_MODEL = "muse-spark-1.3-contributor";

// components/docs/playgrounds/common/ApiConsole.tsx (F3a). The Run panel on code blocks renders this.
export interface FormSpec { name: string; value?: string; file?: FileSlotSpec }
export interface FileSlot {
  /** A JSON Pointer (RFC 6901) into `body`, or a multipart field name when target is "form". */
  pointer: string;
  target?: "body" | "form";
  label: string;
  accept?: string;
  /** "dataUrl" puts data:<mime>;base64,... at the pointer, "base64" the bare base64, "file" the File (multipart). */
  as?: "dataUrl" | "base64" | "file";
}
export type FileSlotSpec = Omit<FileSlot, "pointer" | "target">;
export interface ApiConsoleProps {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  form?: FormSpec[];
  fileSlots?: FileSlot[];
  /** Read the reply as SSE. Defaults to body.stream === true. */
  stream?: boolean;
  title?: string;
  /** Drop the console's "upload a file first" line for an example id in the path, when the host offers the upload (the Run panel). */
  hideIdHint?: boolean;
}

// components/docs/playgrounds/common/AskPagePanel.tsx (F3a): export function AskPagePanel(p: { slug: string }): JSX.Element;

// lib/docs/media/samples.ts (F3b fills DOCS_SAMPLES; the types and helpers are already there).
```

File pickers anywhere in the kit offer `samplesOf(kind)` for the slot's `accept` type.

## Open items

- **SAM mask pixels.** Drawing masks needs Meta's decoder: `npm install @meta-sam/parser@0.1.0` (the version `template/` uses; SAM License), then once in client code `setMaskRasterDecoder((mask) => decodeMaskToRaster(mask))` with `decodeMaskToRaster` from `@meta-sam/parser`. Not installed yet, since parts don't add packages on their own.
- **Page groups.** Every `lib/docs/demos/<group>.ts` map is empty until the G* parts land, so each page shows the Ask tab only.
