# Build with Meta Model API and Muse Code {#build-with-meta-model-api-and-muse-code}

Your next build starts with Muse. Meta Model API is an inference API for the latest models from Meta, including Muse Wonder and Muse Spark, and [Muse Code](https://dev.meta.ai/docs/overview#muse-code) is a coding agent built for Muse Spark. Call the API to build your own app or agent, or run Muse Code for a ready-made agent in your terminal — same models, same auth.

[Muse Wonder](https://dev.meta.ai/docs/overview#muse-wonder) is Meta's most capable model, built for complex software engineering and long-horizon agentic work. It makes changes across many files in real repositories, delegates to sub-agents, and works through long tasks with parallel tool calls and a 1M-token context window.

[Muse Spark](https://dev.meta.ai/docs/overview#muse-spark) is served through Model API, with agent-ready primitives and no extra setup: parallel tool calls, streamed tool-call arguments, reasoning that carries across turns, and a 1M-token context window.

[Muse Image](https://dev.meta.ai/docs/overview#muse-image) is served through Model API too. It generates and edits images from a text prompt and refines them across turns.

[Muse Voice Transcribe](https://dev.meta.ai/docs/overview#muse-voice-transcribe) is a speech-to-text model on Model API. It transcribes streaming and non-streaming audio, with speaker attribution and turn detection in the model.

[Segment Anything Model 3.1 (SAM 3.1)](https://dev.meta.ai/docs/overview#sam-3), an open-weight model from Meta, is also available on Model API. It finds and outlines objects in images and video from a short text prompt, returning boxes and masks.

[Muse Spark Open](https://dev.meta.ai/docs/overview#muse-spark-open) is the open-weight release of Muse Spark. Download the BF16 or NVFP4 checkpoint and serve it on your own GPUs, or call it through a hosted inference provider.

[Muse Glimmer](https://dev.meta.ai/docs/overview#muse-glimmer) is open-weight too, built for local and edge deployment: you download the weights and run it on your own hardware instead of calling it through Model API, under a permissive Apache 2.0 license.

[Muse Code](https://dev.meta.ai/docs/overview#muse-code) is a coding agent from Meta for the terminal and CI, built for Muse Spark and powered by Model API. Install it, sign in, and run it in a project. It plans, edits, and runs commands to do tasks, with approvals and an OS sandbox on from the first run.

## Build with Muse Code {#muse-code}

Install the CLI on macOS or Linux:

```bash
curl -fsSL https://dev.meta.ai/install.sh | sh
```

Or install it on Windows with PowerShell:

```powershell
irm https://dev.meta.ai/install.ps1 | iex
```

Start building:

```bash
muse   # start Muse Code; on first run, choose a browser sign-in or paste an API key
```

> **NOTE: Muse Code or the API**
>
> Muse Code and the API are two ways to use the same model. Run Muse Code for a ready-made agent at the command line or in CI; call the API directly when you build your own agent or app.

Learn more in the [Muse Code overview](https://dev.meta.ai/docs/muse-code).

## Build with Muse Wonder {#muse-wonder}

Run Muse Wonder for complex coding work and for agents that plan, delegate to sub-agents, and work through long tasks. Muse Wonder and Muse Spark take the same requests, so any example in these docs that uses Muse Spark also runs on Muse Wonder: change the model to `muse-wonder-1.0`. Muse Wonder takes on longer, more complex tasks; Muse Spark costs less and, on Model API, offers a discounted Contributor mode.

### At a glance {#muse-wonder-at-a-glance}

|                                                                                       |                                                                                                                |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Base URL**                                                                          | `https://api.meta.ai/v1`                                                                                       |
| **[Standard mode](https://dev.meta.ai/docs/pricing-rate-limits#standard-mode) model** | `muse-wonder-1.0`                                                                                              |
| **Context window**                                                                    | 1,048,576 tokens                                                                                               |
| **Auth**                                                                              | Bearer token (`MODEL_API_KEY`)                                                                                 |
| **Pricing**                                                                           | Pay-as-you-go; see [Pricing and rate limits](https://dev.meta.ai/docs/pricing-rate-limits#muse-wonder-pricing) |

### Make your first call {#muse-wonder-first-call}

Send a request to the [Responses API](https://dev.meta.ai/docs/protocols/responses) with your `MODEL_API_KEY`:

```shell
curl -X POST "https://api.meta.ai/v1/responses" \
  -H "Authorization: Bearer $MODEL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "model": "muse-wonder-1.0",
  "reasoning": {
    "effort": "high"
  },
  "input": "Plan the upgrade of a Flask app from SQLAlchemy 1.4 to 2.0: list the breaking changes to check and the order to make them in."
}'
```

For the same call in Python or TypeScript, follow the [quickstart](https://dev.meta.ai/docs/quickstart#first-call) and set the model to `muse-wonder-1.0`.

[Muse Code](https://dev.meta.ai/docs/muse-code) subscription plans can also include Muse Wonder Full and Contributor mode; see [Muse Wonder availability](https://dev.meta.ai/docs/models#muse-wonder-availability). To decide between Muse Wonder and Muse Spark, see [Choose Muse Wonder or Muse Spark](https://dev.meta.ai/docs/models#choose-muse-wonder-or-muse-spark).

Muse Wonder is in preview.

## Build with Muse Spark {#muse-spark}

Call Model API directly, run Muse Code, or connect the coding agent you already use. All three drive the same model over the same auth.

### At a glance {#at-a-glance}

Everything you need to make your first call.

|                                                                                              |                                                                                                               |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Base URL**                                                                                 | `https://api.meta.ai/v1`                                                                                      |
| **[Standard mode](https://dev.meta.ai/docs/pricing-rate-limits#standard-mode) models**       | `muse-spark-1.3`, `muse-spark-1.2`, `muse-spark-1.1`                                                          |
| **[Contributor mode](https://dev.meta.ai/docs/pricing-rate-limits#contributor-mode) models** | `muse-spark-1.3-contributor`, `muse-spark-1.2-contributor`                                                    |
| **Context window**                                                                           | 1,048,576 tokens                                                                                              |
| **Auth**                                                                                     | Bearer token (`MODEL_API_KEY`)                                                                                |
| **Pricing**                                                                                  | Pay-as-you-go; see [Pricing and rate limits](https://dev.meta.ai/docs/pricing-rate-limits#muse-spark-pricing) |

### Call the API directly {#call-the-api}

Model API is drop-in compatible with the OpenAI SDK, the Anthropic SDK, and OpenAI-compatible agent CLIs. Set your client's base URL, add your key, and keep the rest of your code.

Walk through your first call in the [quickstart](https://dev.meta.ai/docs/quickstart), or compare request formats in [Choosing an API](https://dev.meta.ai/docs/protocols).

### Connect your coding agent {#existing-stack}

Already have a coding agent? Connect it to Model API and keep working. Muse Spark drives the same agentic loop of file edits, shell commands, and tool calls over an OpenAI- or Anthropic-compatible surface.

> **NOTE: Muse Spark Open**
>
> Alongside our hosted models, you can also download [Muse Spark Open](https://dev.meta.ai/docs/overview#muse-spark-open), the open-weight release of Muse Spark, and run it on your own GPUs.

## Build with Muse Image {#muse-image}

Muse Image generates and edits images through Model API. Send a text prompt and get an image back, refine it across turns, or edit an existing image. It uses the same base URL and auth as Muse Spark.

### At a glance {#muse-image-at-a-glance}

Everything you need to make your first image request.

|                        |                                                                                                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Base URL**           | `https://api.meta.ai/v1`                                                                                                                                               |
| **Model**              | `muse-image-1.0`                                                                                                                                                       |
| **Endpoints**          | [`/v1/images/generations`](https://dev.meta.ai/docs/api-reference/images/create-image), [`/v1/images/edits`](https://dev.meta.ai/docs/api-reference/images/edit-image) |
| **Multi-turn editing** | [Responses API](https://dev.meta.ai/docs/protocols/responses)                                                                                                          |
| **Output**             | Image, as base64 or a signed URL                                                                                                                                       |
| **Auth**               | Bearer token (`MODEL_API_KEY`)                                                                                                                                         |

Generate your first image and learn multi-turn editing in the [Image generation guide](https://dev.meta.ai/docs/image-generation).

## Build with Muse Voice Transcribe {#muse-voice-transcribe}

Muse Voice Transcribe brings speech-to-text to Model API. Use it to transcribe live audio streams or supported audio files with one model that can detect speech turns, attribute speakers, and bias recognition toward your vocabulary.

### At a glance {#muse-voice-transcribe-at-a-glance}

|                       |                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Base URL**          | `https://api.meta.ai/v1`                                                                                                  |
| **Model**             | `muse-voice-transcribe-1.0`                                                                                               |
| **Realtime endpoint** | `wss://api.meta.ai/v1/asr/realtime`                                                                                       |
| **File endpoint**     | `POST /v1/asr/transcribe`                                                                                                 |
| **Input**             | Audio                                                                                                                     |
| **Output**            | Transcript text with turn-level timing and optional speaker labels                                                        |
| **Pricing**           | $0.18 per hour; see [Pricing and rate limits](https://dev.meta.ai/docs/pricing-rate-limits#muse-voice-transcribe-pricing) |

Muse Voice Transcribe is built for developers adding real-time speech to voice agents, meeting and call intelligence, live transcription, dictation, captioning, and high-volume transcription products.

It supports streaming speaker diarization, native endpointing and voice activity detection, contextual and keyword biasing, and 25 evaluated languages with code-switching. It returns turn-level timestamps, but not word-level timestamps. It is speech-to-text only; it does not synthesize speech or provide a speech-to-speech conversation API.

Start with the [Muse Voice Transcribe guide](https://dev.meta.ai/docs/speech-to-text).

## Build with Segment Anything Model {#sam-3}

SAM 3.1 segments images and video through Model API. Name an object in a short text prompt and get back a box and a pixel-accurate mask for every match, and in video follow each object across frames. It uses the same base URL and auth as Muse Spark.

### At a glance {#sam-3-at-a-glance}

Everything you need to make your first segmentation request.

|               |                                                                                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Base URL**  | `https://api.meta.ai/v1`                                                                                                                                               |
| **Model**     | `sam-3.1`                                                                                                                                                              |
| **Endpoints** | [`POST /v1/responses`](https://dev.meta.ai/docs/api-reference/responses/create-response), [`POST /v1/files`](https://dev.meta.ai/docs/api-reference/files/upload-file) |
| **Input**     | Text prompt, image, video                                                                                                                                              |
| **Output**    | Boxes and masks                                                                                                                                                        |
| **Auth**      | Bearer token (`MODEL_API_KEY`)                                                                                                                                         |

Segment your first image in the [Media segmentation guide](https://dev.meta.ai/docs/media-segmentation).

## Build with Muse Spark Open {#muse-spark-open}

Muse Spark Open is the open-weight release of Muse Spark: an 816B-parameter mixture-of-experts model with 42B active parameters that reads text, images, audio, and video and writes text. Instead of calling it over Model API, you download the BF16 or NVFP4 checkpoint and serve it on your own GPUs with a runtime such as SGLang or vLLM, or call it through a hosted inference provider.

You run Muse Spark Open yourself or through a hosted provider, not on Model API, so the API pricing and specs above don't apply. Its own documentation section covers how to get the model, prompt it, run it, and post-train it.

- **[Muse Spark Open overview](https://dev.meta.ai/docs/muse-spark-open)**: architecture, checkpoints, hardware, and launch partners.
- **[Get the model](https://dev.meta.ai/docs/muse-spark-open/get-the-model)**: download the weights and verify your setup.
- **[Run inference](https://dev.meta.ai/docs/muse-spark-open/deploy)**: self-host with a runtime or call a hosted provider.
- **[Post-training](https://dev.meta.ai/docs/muse-spark-open/post-training)**: fine-tune the model with a framework or a hosted service.

## Build locally with Muse Glimmer {#muse-glimmer}

Muse Glimmer is an open-weight multimodal model, distilled from Muse Spark and built to run on your own hardware. You run it yourself instead of calling it over Model API: download the weights and serve them through a runtime such as vLLM, SGLang, llama.cpp, or ExecuTorch.

Because Muse Glimmer is self-hosted, the API pricing and specs above don't apply. Its own documentation section covers how to get the model, prompt it, deploy it, and customize it.

- **[Muse Glimmer overview](https://dev.meta.ai/docs/muse-glimmer)**: variants, architecture, license, and launch partners.
- **[Get the model](https://dev.meta.ai/docs/muse-glimmer/get-the-model)**: download the weights and verify your setup.
- **[Run inference](https://dev.meta.ai/docs/muse-glimmer/deploy)**: pick a runtime and serve it locally.

## Explore the docs {#explore-the-docs}

Jump to the surface you need.

- [Quickstart](https://dev.meta.ai/docs/quickstart): Set your key, call the API, and read your first response.
- [Models](https://dev.meta.ai/docs/models): Muse Wonder, Muse Spark, Muse Image, Muse Voice Transcribe, SAM, Muse Spark Open, and Muse Glimmer specs, plus Standard and Contributor mode pricing.
- [SDKs and libraries](https://dev.meta.ai/docs/sdks): Call Model API with the OpenAI SDK, the Anthropic SDK, or OpenAI-compatible clients.
- [Cookbook](https://dev.meta.ai/docs/cookbook): Copy-paste recipes for primitives, agent loops, and use cases.
- [Pricing and rate limits](https://dev.meta.ai/docs/pricing-rate-limits): Per-token, per-image, per-frame, and per-hour audio pricing, plus rate limits.
- [API reference](https://dev.meta.ai/docs/api-reference): Full request and response schemas for every endpoint.

## Capabilities {#capabilities}

Muse Wonder, Muse Spark, Muse Image, Muse Voice Transcribe, and SAM ship production capabilities through Model API. Each page explains the concept, shows code, and covers constraints. For the open-weight equivalents, see the [Muse Spark Open](https://dev.meta.ai/docs/muse-spark-open/prompting) and [Muse Glimmer](https://dev.meta.ai/docs/muse-glimmer/prompting) prompting guides.

- [Speech to text](https://dev.meta.ai/docs/speech-to-text): Transcribe streaming audio and supported files with Muse Voice Transcribe.
- [Tool calling](https://dev.meta.ai/docs/tool-calling): Connect the model to your APIs with parallel, streamed tool calls.
- [Tool search](https://dev.meta.ai/docs/tool-search): Discover and load deferred tools on demand to save tokens.
- [Search grounding](https://dev.meta.ai/docs/search-grounding): Real-time answers with inline citations, no retrieval stack to build.
- [Image understanding](https://dev.meta.ai/docs/image-understanding): Read photos, charts, documents, and screenshots.
- [Image generation](https://dev.meta.ai/docs/image-generation): Generate and edit images with Muse Image, and refine them turn by turn.
- [Video understanding](https://dev.meta.ai/docs/video-understanding): Summarize clips, ask questions about footage, and transcribe speech.
- [Media segmentation](https://dev.meta.ai/docs/media-segmentation): Find and outline objects in images and video with SAM.
- [File handling](https://dev.meta.ai/docs/file-handling): Upload once and reference files by ID across requests.
- [Reasoning](https://dev.meta.ai/docs/reasoning): Dial reasoning effort up or down per request.
- [Structured output](https://dev.meta.ai/docs/structured-output): Return valid JSON that matches your schema every time.
- [Prompt caching](https://dev.meta.ai/docs/prompt-caching): Cache repeated prefixes to cut latency and cost.
- [Token counting](https://dev.meta.ai/docs/token-counting): Count input tokens before you send to estimate cost and fit context.

## Protocols {#protocols}

Pick the request format your code already speaks: same models, same auth, same cost per token. These are Model API surfaces. A self-hosted Muse Spark Open server exposes its own OpenAI-compatible endpoint through [SGLang](https://dev.meta.ai/docs/muse-spark-open/deploy#sglang) or [vLLM](https://dev.meta.ai/docs/muse-spark-open/deploy#vllm). A local Muse Glimmer server does the same through [vLLM](https://dev.meta.ai/docs/muse-glimmer/deploy#vllm) or [llama.cpp](https://dev.meta.ai/docs/muse-glimmer/deploy#llama-cpp). See [Choosing an API](https://dev.meta.ai/docs/protocols) to compare the request formats.

- [Responses API](https://dev.meta.ai/docs/protocols/responses): Agentic, multi-step workloads with reasoning replay and server-managed state.
- [Chat Completions API](https://dev.meta.ai/docs/protocols/chat-completions): The OpenAI-compatible messages-array endpoint.
- [Messages API](https://dev.meta.ai/docs/protocols/messages): The Anthropic Messages-compatible endpoint.

## Agent guides {#agent-guides}

Go deeper on building agents and integrations.

- [Coding agents](https://dev.meta.ai/docs/coding-agents): Wire Muse Wonder and Muse Spark into OpenCode, Codex, and Claude Code.
- [Agent frameworks](https://dev.meta.ai/docs/agent-frameworks): Run your own agent loop with the Claude Agent SDK or the OpenAI Codex app-server.
- [Computer use](https://dev.meta.ai/docs/computer-use): Drive a desktop from screenshots with a computer-use agent.

## Get unblocked {#get-unblocked}

Browse the [Help Center](https://dev.meta.ai/help) for accounts, API keys, billing, and rate-limit questions. For anything it doesn't cover, contact support through the Help Center.
