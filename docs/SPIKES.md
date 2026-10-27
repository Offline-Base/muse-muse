# Day-one spike results

Run Oct 27, 2026 against the live Meta Model API and Vercel Sandbox. These results replace every *verify* note in DESIGN.md, META_CATALOG.md and the template skills. Code must follow this file where it disagrees with older docs.

## Spike 3: Meta Model API

Base URL `https://api.meta.ai/v1`, `Authorization: Bearer <key>`. `GET /v1/models` lists `muse-wonder-1.0`, `sam-3.1`, `muse-spark-1.3`, `muse-spark-1.3-contributor`, `muse-voice-transcribe-1.0`, `muse-image-1.0`, plus older Spark 1.1 and 1.2.

### Responses API (Spark 1.3)

- Response and usage shapes match OpenAI's Responses API. `usage.input_tokens` includes `input_tokens_details.cached_tokens`, and `usage.output_tokens` includes `output_tokens_details.reasoning_tokens`. `res.output_text` works in the OpenAI SDK.
- **Structured output works natively.** `text: { format: { type: "json_schema", name, strict: true, schema } }` returns JSON that matches the schema in `output_text`. Strict mode needs `additionalProperties: false` and every property listed in `required`, as in OpenAI strict mode.
- `reasoning: { effort: "low" }` is accepted. Even trivial answers use 150 to 400 reasoning tokens at low effort.
- **Images.** `{ type: "input_image", image_url, detail: "auto" }` works with a base64 data URL. The `detail` field is accepted, so `imagePart` keeps it.
- **PDFs** work two ways: `{ type: "input_file", file_id }` after `POST /v1/files` (multipart, `purpose=user_data`), or inline as `{ type: "input_file", filename, file_data: "data:application/pdf;base64,..." }`.
- **Video** works two ways: `{ type: "input_video", file_id }` after `POST /v1/files`, or `{ type: "input_video", video_url: "data:video/mp4;base64,..." }`. A 3-second clip cost about 800 input tokens.
- `POST /v1/files` returns `{ id: "file-...", bytes, filename, purpose, status: "uploaded", expires_at: null }`.
- **Public https URLs are fetched by Meta.** A remote MP4 as `input_video.video_url` worked for Spark 1.3 and for SAM 3.1 (non-streamed too). So products and the platform can pass public Vercel Blob URLs straight through. When the origin refuses Meta's fetcher, the call fails with HTTP 400 `media_url_origin_error` ("failed to download media at input[0].content[1]: origin returned HTTP 400"); Wikimedia did this for an image. Fall back to a data URL or `POST /v1/files` when that happens.

### Muse Image

- `POST /v1/images/generations` with `{ model: "muse-image-1.0", prompt, n, size, output_format }` returns `{ created, output_format, background, usage: { input_tokens, output_tokens, total_tokens }, data: [{ b64_json }] }`. No `url` unless asked.
- `size` sets only the aspect ratio. `1024x768` came back as 1792×1344.
- Billing is per returned image ($0.01). Ignore the token counts in its `usage` for cost.

### SAM 3.1

- `POST /v1/responses` with `stream: true`, `metadata: { mask_encoding: "one_bit", include_confidence: "true" }`, and a user message holding `{ type: "input_text", text: "bird" }` plus an `input_image` returned three birds.
- The stream is standard Responses SSE (`response.created`, `response.output_text.delta`, `response.output_text.done`, `response.completed`). The result is in the output text as tokens such as `<0f>0<|box;x1=510;y1=265;x2=674;y2=408;w=800;h=600;c=0.96|><|mask;x=0;y=0;c=0.96;data=144,165,...|>,1<|box;...`. `@meta-sam/parser` parses it.
- `response.completed` carries `usage: { images_processed: 1, input_tokens: 0, output_tokens: 0 }`. Meter SAM by `images_processed` (and video frames for video).

### Voice Transcribe

- `POST /v1/asr/transcribe` takes **multipart/form-data with two parts**: `request`, a JSON string such as `{"model":"muse-voice-transcribe-1.0","audioEncoding":"WAV"}`, and `audio`, the file.
- **The only accepted audio is mono 16-bit PCM WAV at 16 or 24 kHz**, with `audioEncoding: "WAV"`. MP3, M4A, AAC, FLAC, OGG, Opus and WebM are rejected, under any `audioEncoding` value. Products and the platform must convert audio to 16 kHz mono WAV in the browser (decode with Web Audio, resample with `OfflineAudioContext`, write a WAV header) before upload.
- Reply: `{ sessionId, transcript, audioDurationMs, turns: [] }`. `transcript` can end with a zero-width space (U+200B), so trim it.
- **`turns` stayed empty**, even for two different voices and with `diarization: true`. Don't promise speaker labels. Unknown request fields are ignored, not rejected.
- Errors are `{ sessionId, error: { type: "invalid_request_error", param, message } }` with HTTP 400.
- Bill by `audioDurationMs` at $0.18 per hour.

## Spike 1: Muse Code headless in Vercel Sandbox

- Sandbox image `vercel/sandbox/universal`: Ubuntu 26.04, Node 24.22, npm 11, user `ubuntu`, working directory `/vercel`, passwordless `sudo`, `apt-get`, 64 GB disk. No ffmpeg and no usable bubblewrap. 2 vCPUs give 4 GB of memory, and 4 vCPUs give 8 GB.
- **Auth.** The SDK reads `VERCEL_OIDC_TOKEN` (from `vercel env pull`, valid 12 hours) or takes `{ teamId, projectId, token }`.
- **Install.** `curl -fsSL https://dev.meta.ai/install.sh | MUSE_NO_MODIFY_PATH=1 MUSE_LOGIN=0 bash` installs `~/.local/bin/muse` in about 7 seconds. The installer pulls a launcher from `api.meta.ai` and the binary from `lookaside.facebook.com`. Version 1.4.13 on Oct 27.
- **Runtime env.** `PATH=$HOME/.local/bin:$PATH META_API_KEY=<placeholder> MUSE_NO_AUTO_UPDATE=1 MUSE_LOGIN=0`. Without the last two, the launcher tries to self-update from a host the build firewall blocks and may try a device sign-in. (Spike 1 used the literal placeholder `brokered` with a blanket transform. Since the review fixes, the placeholder is per sandbox and only `POST /v1/responses`, `GET|POST /muse-code/models`, `POST /v1/files` and `GET /v1/models` are brokered; everything else on `api.meta.ai` gets the firewall's 403. The firewall's path match ignores the query string.)
- **Credential brokering works.** `sandbox.updateNetworkPolicy({ allow: { "api.meta.ai": [{ transform: [{ headers: { Authorization: "Bearer <real key>" } }] }], "registry.npmjs.org": [] } })` replaces the header on the way out. With the placeholder key, `muse exec` and plain `curl` to `api.meta.ai` both succeed, and other hosts fail DNS (`example.com` could not resolve). The real key never enters the VM.
- **`muse exec --json --yolo --model muse-spark-1.3 ...` exits 0** and edits files. Muse Code prints a bubblewrap warning to stderr, which is expected under `--yolo`.
- **`--image <path>` works** and is repeatable. Muse Code described the attached photo correctly.
- **Sessions.** `--session-id <uuid>` sets the session id. Pass a fresh UUID on the first run, then the same id later to resume: the second run remembered the first run's edit.
- **Transcript.** `muse export --session <uuid> --out file.json` writes the full session (about 650 KB for a tiny run). Use `--redacted` for anything shown publicly.
- Other useful flags: `--output-schema <file>` for a structured final answer, `--disable-web-tools`, `--max-tool-output-bytes`, `--no-session-log`.
- Usage: a two-line edit used about 89k input tokens (46k cached) and 226 output tokens across 3 model calls. Muse Code front-loads a large system prompt.

### JSONL stream (`--json`)

One JSON object per line. A real sample is in `docs/spikes/muse-exec-sample.jsonl`.

```json
{"schema_version":1,"id":"...","stream":{"kind":"session","id":"<session uuid>"},"sequence":38,"recorded_at":1793078780984244,"record_type":"event","durability":"durable","payload_type":"run.terminal.completed","payload":{...}}
```

| `payload_type` | Useful payload fields | Show in the build room as |
|---|---|---|
| `run.lifecycle.started` | `prompt` | "Started" |
| `tool.result` | `correlation_facts.tool_name`, `correlation_facts.outcome`, `text` (first line is a summary such as "Read text file `app/page.tsx`.") | One log line per tool call |
| `task.lifecycle.tool_output_ref` | `event.output_ref.kind == "tool_patch"`, `event.output_ref.patch_summary { added, removed, files }` | "Edited N files (+a −r)" |
| `task.lifecycle.status` | `event.message` | Skip most. They are retry and stream notices |
| `run.output.delta` | `text` | Stream the assistant's words |
| `run.usage` (stream kind `exec.usage`) | `models: [{ model, input_tokens, cached_tokens, output_tokens, reasoning_tokens, calls }]` | Cost |
| `run.terminal.completed` | `terminal` (`completed` or other), `text` (final message) | "Done" plus the final text |

Skip `task.lifecycle.proposed/accepted/scheduled/started/completed/rejected/side_effect_intent`, `task.stream.linked`, `session.run.linked` and `runtime.command.accepted`. They are bookkeeping, mostly for Muse Code's reminder subagents.

## Spike 2: template preview in a sandbox

- Writing the 35 template files with `sandbox.writeFiles` took under a second. `npm ci` took 6 seconds.
- `npm run dev` (`next dev -H 0.0.0.0 -p 3000`) answered 200 on localhost within 2 seconds, and `sandbox.domain(3000)` (`https://sb-<id>.vercel.run`) served the page publicly with Muse Code's edit and the footer.
- `sudo -n npx -y playwright@1.64.1 install-deps chromium` took about 20 seconds, then `npx playwright install chromium` 7 seconds (Chrome Headless Shell 156).
- `sudo -n apt-get install -y -q ffmpeg` took about 15 seconds (ffmpeg 8.0.1).

All of that happens once, at snapshot time.

## Still open

- Spike 4 (publish to Vercel) needs a `VERCEL_TOKEN` with access to the `ethan-6436s-projects` team.
- Spike 5 (snapshot) is part of `scripts/make-builder-snapshot.ts`.
