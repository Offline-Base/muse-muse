# Meta model catalog

Everything Muse Muse can build with, checked on Oct 24, 2026. The machine-readable version is `catalog/meta-models.json`, which the brief writer reads. Rows marked *verify* need a check on day one.

## Connecting

| Item | Value |
|---|---|
| Base URL | `https://api.meta.ai/v1` (Messages-style clients use `https://api.meta.ai`) |
| Auth | `Authorization: Bearer <key>` |
| Key variable | `MODEL_API_KEY` in Meta's API docs, `META_API_KEY` for Muse Code |
| SDK | The OpenAI SDK works with `baseURL` set to Meta's. Pass the key explicitly, because the SDK doesn't read `MODEL_API_KEY` |
| Files | `POST /v1/files` with `purpose` set to `user_data`, then pass the `file_id` |
| Hackathon credits | $150 per participant |

## Hosted models

| Model ID | Use it for | Endpoints | In, then out | Price |
|---|---|---|---|---|
| `muse-spark-1.3` | Default reasoning, vision, video, coding | Responses, Chat Completions, Messages | Text, image, PDF, video, then text. 1M context, 131k max output | About $1.25 in and $4.25 out per million tokens, $0.15 cached (1.2 price, reported unchanged, *verify*) |
| `muse-spark-1.3-contributor` | Test builds only | Same | Same | Much cheaper. Meta may train on your prompts |
| `muse-wonder-1.0` | Long multi-step tasks, audio input, web search | Same as Spark | Text, image, video, audio, PDF, then text. 1M context | About $4 in and $20 out per million (preview, *verify*) |
| `muse-image-1.0` | Generate, edit and compose images | `/v1/images/generations`, `/v1/images/edits`, Responses for multi-turn | Text and up to 10 images, then images as base64 or a signed URL | $0.01 per returned image |
| `sam-3.1` | Find, outline and track objects | Responses (stream), Files for video | A short noun phrase or box/point tokens, plus an image or video, then boxes and masks | Video billed per frame, 50-frame minimum |
| `muse-voice-transcribe-1.0` | Speech to text with turns and speakers | `POST /v1/asr/transcribe` (*verify*), `wss://api.meta.ai/v1/asr/realtime` | Audio, then turn-level transcript | $0.18 per audio hour |

## Rules that trip people up

- **Muse Image** has no mask support. To change one region, find it with SAM 3.1, crop it, edit the crop and composite it back. Unknown JSON fields return 400, and so does setting `moderation`.
- **SAM 3.1** takes one short noun phrase per call. Comma lists return nothing. Box and point tokens must carry the media's displayed width and height or the call fails with 400. Video tracks at most 16 objects, runs up to 15,000 frames (about 10 minutes), and must be MP4 or MOV in H.264, H.265 or MPEG-4.
- **Muse Wonder** is in preview. Keep it for briefs that need it.
- **Voice** realtime needs a WebSocket, which Vercel Functions don't hold well. Products use file transcription in v1.

## Not on the Model API yet (Oct 26)

| Missing | Status | Workaround in products |
|---|---|---|
| Text-to-speech | Muse Voice Transcribe is speech-to-text only | Browser speech synthesis |
| Video generation | Muse Video was previewed July 7 and hasn't shipped | Image sequences from Muse Image |
| Embeddings | No embeddings model listed | Spark 1.3's 1M-token context for small document sets |
| Realtime speech-to-speech | Muse Realtime Avatar was announced Sep 23 and isn't available | Record, transcribe, reply in text |

## Usage on OpenRouter (checked Oct 26)

| Model | Tokens processed since release |
|---|---|
| Muse Spark 1.3 Contributor | 2.92T |
| Muse Wonder | 132B |
| Muse Spark 1.3 | 90.9B |
| Muse Spark Open | 90.2B |
| Muse Glimmer 30B | 13.1B |

For scale, DeepSeek V4.1 Flash processed 123T in the last 30 days. Meta isn't among the top nine authors by share for the week of Oct 19.

## Open weights, not on the Model API

| Model | Facts | How Muse Muse uses it |
|---|---|---|
| Muse Glimmer | 30B dense, Apache 2.0, multimodal per Meta's docs, under 20 GB quantized. Runs on vLLM, SGLang, llama.cpp, ExecuTorch | Optional. Only when a brief asks for local or offline use, through an endpoint you host |
| Muse Spark Open | 816B total, 42B active MoE. Text, images, audio and video in. SGLang or vLLM | Not in v1 |

## Muse Code

| Item | Value |
|---|---|
| Install | `curl -fsSL https://dev.meta.ai/install.sh \| sh` |
| Headless | `muse exec --json --prompt-file brief.md --max-model-steps 200` |
| Resume | `muse exec --session-id <uuid> "..."` |
| Attach an image | `--image <path>`, listed by a third-party guide but not in Meta's docs (*verify*) |
| Transcript | `muse export --session <uuid> --out run.json` |
| Auth order | `META_API_KEY`, then a stored key, then a browser session |
| Project rules | `AGENTS.md` (also reads `CLAUDE.md`, `.agents/AGENTS.md`, `.claude/CLAUDE.md`) |
| Project skills | `.agents/skills/<id>/SKILL.md` |
| Settings | `~/.config/muse/settings.json` with `"schema_version": 1`. MCP servers go under `mcp_servers` |
| Default model | `muse-spark-1.2`, so always pass `--model` |
| Exit codes | 0 completed, 1 failed or hit max steps, 2 usage error. Gate on your own tests too |
| Linux note | Its own sandbox needs bubblewrap. Inside a disposable microVM, use `--yolo` |

## Muse app

The agent runs on its own cloud VM. You add custom connectors by asking Muse to create one. Remote MCP servers over HTTP work, and servers on your laptop are not reachable. The app is US-only and adults-only at launch.

## Sources

- https://dev.meta.ai/docs/overview
- https://dev.meta.ai/docs/quickstart
- https://dev.meta.ai/docs/image-generation
- https://dev.meta.ai/docs/sam/segmenting
- https://dev.meta.ai/docs/sam/client-libraries
- https://dev.meta.ai/docs/muse-code/configuration
- https://dev.meta.ai/docs/muse-code/extending
- https://dev.meta.ai/docs/muse-code/auth
- https://www.eesel.ai/es/blog/meta-muse-wonder (Wonder pricing and limits)
- https://tbreak.com/meta-muse-code-muse-spark-1-2/ (Spark 1.2 pricing)
- https://docs.litellm.ai/docs/providers/meta.md (realtime voice format)
- https://campustechnology.com/articles/2026/08/26/meta-releases-muse-glimmer-an-open-weight-ai-model-designed-to-run-on-consumer-hardware.aspx?p=1
- https://parallel.ai/articles/meta-muse-custom-integrations
- https://openrouter.ai/meta and https://openrouter.ai/rankings (usage)
- https://www.orcarouter.ai/blog/meta-muse (what's shipped and what's only announced)
