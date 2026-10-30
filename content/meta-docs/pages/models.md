# Models {#models}

Meta ships six model lines. [Muse Wonder](https://dev.meta.ai/docs/models#muse-wonder), [Muse Spark](https://dev.meta.ai/docs/models#muse-spark), [Muse Image](https://dev.meta.ai/docs/models#muse-image), [Muse Voice Transcribe](https://dev.meta.ai/docs/models#muse-voice-transcribe), and [Segment Anything Model (SAM)](https://dev.meta.ai/docs/models#sam-3) are hosted on Meta Model API; [Muse Glimmer](https://dev.meta.ai/docs/models#muse-glimmer) is open-weight and runs on your own hardware. Muse Spark also has an open-weight release, [Muse Spark Open](https://dev.meta.ai/docs/models#muse-spark-open). Pick one by what you're building, then read its section for versions and where to use them.

## Models at a glance {#model-availability}

| Use case                                                              | Model                                                                                                                | Input                              | Output               | API endpoints                                                                                                                                                                               |
| :-------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------- | :--------------------------------- | :------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agentic work, coding, and reasoning                                   | [Muse Wonder](https://dev.meta.ai/docs/models#muse-wonder), [Muse Spark](https://dev.meta.ai/docs/models#muse-spark) | Text, image, video, audio, and PDF | Text                 | [Responses](https://dev.meta.ai/docs/protocols/responses), [Chat Completions](https://dev.meta.ai/docs/protocols/chat-completions), [Messages](https://dev.meta.ai/docs/protocols/messages) |
| Image generation and editing                                          | [Muse Image](https://dev.meta.ai/docs/models#muse-image)                                                             | Text and image                     | Image                | [Responses](https://dev.meta.ai/docs/protocols/responses), [Image generation](https://dev.meta.ai/docs/image-generation)                                                                    |
| Speech to text                                                        | [Muse Voice Transcribe](https://dev.meta.ai/docs/models#muse-voice-transcribe)                                       | Audio                              | Text (transcription) | [Transcribe](https://dev.meta.ai/docs/speech-to-text)                                                                                                                                       |
| Image and video segmentation                                          | [Segment Anything Model](https://dev.meta.ai/docs/models#sam-3)                                                      | Text prompt, image, and video      | Text (geometry)      | [Responses](https://dev.meta.ai/docs/protocols/responses), [Media segmentation](https://dev.meta.ai/docs/media-segmentation)                                                                |
| Self-hosted or provider-hosted agentic and coding work; post-training | [Muse Spark Open](https://dev.meta.ai/docs/models#muse-spark-open)                                                   | Text, image, video, and audio      | Text                 | None ([self-host](https://dev.meta.ai/docs/muse-spark-open/deploy) or a [hosted provider](https://dev.meta.ai/docs/muse-spark-open/deploy#hosted-providers))                                |
| Self-hosted inference; supervised fine-tuning                         | [Muse Glimmer](https://dev.meta.ai/docs/models#muse-glimmer)                                                         | Text and image                     | Text                 | None ([self-host](https://dev.meta.ai/docs/muse-glimmer/deploy))                                                                                                                            |

> **NOTE: Availability by country**
>
> Model availability can vary by country. See the [Geographic Use Policy](https://dev.meta.ai/legal/geographic-use-policy) for country-specific restrictions.

## Muse Wonder {#muse-wonder}

Muse Wonder is Meta's most capable model, built for complex software engineering and long-horizon agentic work. It makes and verifies changes across many files in real repositories, and it plans, delegates to sub-agents, calls tools in parallel, and recovers from errors across many steps, following detailed instructions closely. Take on hard coding tasks, build personal and professional agents, and drive a desktop with [computer use](https://dev.meta.ai/docs/computer-use). Muse Wonder also handles [chat completion](https://dev.meta.ai/docs/protocols/chat-completions), [image understanding](https://dev.meta.ai/docs/image-understanding), [video and audio understanding](https://dev.meta.ai/docs/video-understanding), [tool calling](https://dev.meta.ai/docs/tool-calling), [structured output](https://dev.meta.ai/docs/structured-output), and [search grounding](https://dev.meta.ai/docs/search-grounding).

Muse Wonder takes text, image, video, audio, and PDF input, returns text, has a 1,048,576-token context window, and supports [reasoning effort](https://dev.meta.ai/docs/reasoning) levels from `"minimal"` to `"max"`.

> **NOTE: Preview**
>
> Muse Wonder is in preview. For more about the model, see the [Muse Wonder model page](https://dev.meta.ai/models/muse-wonder) and the [Muse Wonder model card](https://research.meta.ai/static/muse-wonder-model-card).

### Muse Wonder availability {#muse-wonder-availability}

Muse Wonder comes in two variants. Muse Wonder is on Model API and in [Muse Code](https://dev.meta.ai/docs/muse-code). Muse Wonder Full, the higher-capability variant, is available only in Muse Code with a subscription, so setting reasoning effort to `"max"` on Muse Wonder doesn't select it.

| Variant                         | Model API (pay-as-you-go)      | Muse Code                                                                                                                                                       |
| :------------------------------ | :----------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Muse Wonder (`muse-wonder-1.0`) | Available (Standard mode only) | Pay-as-you-go and [every plan](https://dev.meta.ai/docs/muse-code/subscriptions#about)                                                                          |
| Muse Wonder Full                | Not available                  | [Power Usage](https://dev.meta.ai/docs/muse-code/subscriptions#power-usage) and [Maximum Usage](https://dev.meta.ai/docs/muse-code/subscriptions#maximum-usage) |

With a subscription, Muse Wonder is available on every plan and Muse Wonder Full on the Power Usage and Maximum Usage plans, each in [Standard mode](https://dev.meta.ai/docs/pricing-rate-limits#standard-mode) and [Contributor mode](https://dev.meta.ai/docs/pricing-rate-limits#contributor-mode).

Muse Wonder and Muse Wonder Full aren't currently available in South Korea, on Model API or in Muse Code.

In Standard mode, your content — the prompts, code, files, and context you send, plus the model responses you get back — is not used to train Meta models. Muse Code subscribers can also use Contributor mode, which is on by default: it gives you more usage in exchange for letting Meta use your content to train future Meta models, and you can turn it off at any time in your settings. For Muse Wonder, Contributor mode isn't available on pay-as-you-go. See [Pricing and rate limits](https://dev.meta.ai/docs/pricing-rate-limits) for rates.

## Muse Spark {#muse-spark}

Muse Spark is Meta's model for agentic and coding work, such as multi-step tool loops, software engineering assistants, and long-context reasoning. Use it for [chat completion](https://dev.meta.ai/docs/protocols/chat-completions), [image understanding](https://dev.meta.ai/docs/image-understanding), [video and audio understanding](https://dev.meta.ai/docs/video-understanding), [tool calling](https://dev.meta.ai/docs/tool-calling), [structured output](https://dev.meta.ai/docs/structured-output), and [search grounding](https://dev.meta.ai/docs/search-grounding).

Muse Spark comes in three versions. All take text, image, video, audio, and PDF input, return text, and have a 1,048,576-token context window. They differ by capability:

- **Muse Spark 1.3** (`muse-spark-1.3`): the latest version, tuned for agentic workflows (multi-step tool, browser, and long-horizon tasks) with improved coding over 1.2. Supports all [reasoning effort](https://dev.meta.ai/docs/reasoning) levels, including the `"max"` level for extended reasoning (not available with `muse-spark-1.3-contributor`). **Recommended for new work.**
- **Muse Spark 1.2** (`muse-spark-1.2`): the previous version.
- **Muse Spark 1.1** (`muse-spark-1.1`): the original version.

> **NOTE: Audio input on Muse Spark 1.3**
>
> Audio understanding in Muse Spark 1.3 is not fully supported, and response quality for requests that include audio may be degraded. For audio, use Muse Spark 1.2, or [Muse Voice Transcribe](https://dev.meta.ai/docs/models#muse-voice-transcribe) for dedicated speech-to-text.

`muse-spark-1.3` is the default model in most code examples in these docs. The [coding agents](https://dev.meta.ai/docs/coding-agents), [agent frameworks](https://dev.meta.ai/docs/agent-frameworks), and [computer use](https://dev.meta.ai/docs/computer-use) guides use `muse-wonder-1.0` for long-running agentic work.

### Muse Spark availability {#muse-spark-availability}

Every Muse Spark version is available on pay-as-you-go. All versions except Muse Spark 1.1 are also available in [Muse Code](https://dev.meta.ai/docs/muse-code), on pay-as-you-go and with any subscription.

| Version                                                   | Model API (pay-as-you-go) | Muse Code                                                                              |
| :-------------------------------------------------------- | :------------------------ | :------------------------------------------------------------------------------------- |
| Muse Spark 1.3 (`muse-spark-1.3`)                         | Standard mode             | Pay-as-you-go and [every plan](https://dev.meta.ai/docs/muse-code/subscriptions#about) |
| Muse Spark 1.3 Contributor (`muse-spark-1.3-contributor`) | Contributor mode          | Pay-as-you-go and [every plan](https://dev.meta.ai/docs/muse-code/subscriptions#about) |
| Muse Spark 1.2 (`muse-spark-1.2`)                         | Standard mode             | Pay-as-you-go and [every plan](https://dev.meta.ai/docs/muse-code/subscriptions#about) |
| Muse Spark 1.2 Contributor (`muse-spark-1.2-contributor`) | Contributor mode          | Pay-as-you-go and [every plan](https://dev.meta.ai/docs/muse-code/subscriptions#about) |
| Muse Spark 1.1 (`muse-spark-1.1`)                         | Standard mode             | Not available                                                                          |

In [Standard mode](https://dev.meta.ai/docs/pricing-rate-limits#standard-mode), your content is not used to train Meta models. In [Contributor mode](https://dev.meta.ai/docs/pricing-rate-limits#contributor-mode), your content may be used to train future Meta models, in exchange for a lower price. On pay-as-you-go, switch between the two by choosing the model ID: for example, `muse-spark-1.3` for Standard mode or `muse-spark-1.3-contributor` for Contributor mode. Muse Spark 1.1 is available in Standard mode only. See [Pricing and rate limits](https://dev.meta.ai/docs/pricing-rate-limits) for rates.

## Choose Muse Wonder or Muse Spark {#choose-muse-wonder-or-muse-spark}

Muse Wonder and Muse Spark take the same requests on the same endpoints, so moving a workload between them is a model ID change. Choose by workload:

- **Muse Wonder**: long-running, complex tasks where capability matters more than cost per token, such as multi-file coding changes, multi-hour agent runs, and sub-agent orchestration.
- **Muse Spark**: high-volume, latency-sensitive, or cost-sensitive work, such as sub-agent tasks, classification, and tight tool loops. On Model API, Muse Spark also offers a discounted [Contributor mode](https://dev.meta.ai/docs/pricing-rate-limits#contributor-mode).

## Muse Image {#muse-image}

Muse Image is Meta's image generation model line. Send a text prompt (and optional reference images) and get an image back, or send an image with an instruction to edit it. One model handles both generation and editing. It's agentic, so it can search the web for visual references and current facts and run code to build layouts before it renders.

| Model ID         | Input       | Output |
| :--------------- | :---------- | :----- |
| `muse-image-1.0` | Text, image | Image  |

Reach Muse Image two ways: the [Responses API](https://dev.meta.ai/docs/protocols/responses) for conversational, multi-turn editing, or the single-shot [`/v1/images/generations`](https://dev.meta.ai/docs/api-reference/images/create-image) and [`/v1/images/edits`](https://dev.meta.ai/docs/api-reference/images/edit-image) endpoints for one-off calls. See the [Image generation](https://dev.meta.ai/docs/image-generation) guide to get started.

## Muse Voice Transcribe {#muse-voice-transcribe}

Muse Voice Transcribe is Meta's speech-to-text model on Meta Model API. Use it to transcribe live audio streams or supported audio files.

| Model ID                    | Input | Output          |
| :-------------------------- | :---- | :-------------- |
| `muse-voice-transcribe-1.0` | Audio | Text transcript |

Muse Voice Transcribe is built for real-time speech products: voice agents, meeting and call intelligence, live transcription, dictation, captioning, and high-volume transcription. It supports streaming speaker diarization, native endpointing and voice activity detection, contextual and keyword biasing, 25 evaluated languages with code-switching, and turn-level timestamps.

It returns transcript text. It does not synthesize speech or provide a speech-to-speech conversation API. It does not provide word-level timestamps, sound event detection, or emotion detection.

Reach Muse Voice Transcribe two ways: the realtime WebSocket endpoint (`wss://api.meta.ai/v1/asr/realtime`) for live audio, or the file endpoint ([`POST /v1/asr/transcribe`](https://dev.meta.ai/docs/api-reference/voice/transcribe)) for a recording you already have.

Start with the [Muse Voice Transcribe guide](https://dev.meta.ai/docs/speech-to-text). See [Pricing and rate limits](https://dev.meta.ai/docs/pricing-rate-limits#muse-voice-transcribe-pricing) for audio pricing.

## Segment Anything Model {#sam-3}

SAM 3.1 is Meta's segmentation model on Meta Model API. Give it a short noun phrase such as "yellow school bus" with an image or video, and it returns every match as a box and a pixel-accurate mask. Or mark specific objects with boxes and points to segment only those objects. One model handles both stills and clips, and in video it follows each object across frames.

| Model ID  | Input                     | Output          |
| :-------- | :------------------------ | :-------------- |
| `sam-3.1` | Text prompt, image, video | Boxes and masks |

Reach SAM 3.1 over the [Responses API](https://dev.meta.ai/docs/protocols/responses) ([`POST /v1/responses`](https://dev.meta.ai/docs/api-reference/responses/create-response)), and upload clips through the [Files API](https://dev.meta.ai/docs/file-handling) when you segment them more than once. See the [Media segmentation](https://dev.meta.ai/docs/media-segmentation) guide to get started.

## Muse Spark Open {#muse-spark-open}

Muse Spark Open is the open-weight release of Muse Spark: an 816B-parameter mixture-of-experts model with 42B active parameters. You don't call it over Model API. Download the weights and serve them through a runtime such as SGLang, vLLM, TensorRT-LLM, or llama.cpp, or call it through a hosted inference provider.

Muse Spark Open lives in the [Open-weight models](https://dev.meta.ai/docs/open-weight-models) section:

- **[Muse Spark Open overview](https://dev.meta.ai/docs/muse-spark-open)**: checkpoints, hardware, license, and launch partners.
- **[Get the model](https://dev.meta.ai/docs/muse-spark-open/get-the-model)**: download the BF16 or NVFP4 weights.
- **[Run inference](https://dev.meta.ai/docs/muse-spark-open/deploy)**: serve it on your own GPUs or call a hosted provider.
- **[Post-training](https://dev.meta.ai/docs/muse-spark-open/post-training)**: adapt it with supervised fine-tuning (SFT) or reinforcement learning (RL).

## Muse Glimmer {#muse-glimmer}

Muse Glimmer is Meta's open-weight multimodal model, distilled from Muse Spark and built to run on your own hardware. You run it yourself instead of calling it over Model API: download the weights and serve them through a runtime such as vLLM, SGLang, llama.cpp, or ExecuTorch.

Muse Glimmer lives in the [Open-weight models](https://dev.meta.ai/docs/open-weight-models) section, covering how to get, prompt, deploy, and customize the model:

- **[Muse Glimmer overview](https://dev.meta.ai/docs/muse-glimmer)**: variants, architecture, license, and launch partners.
- **[Get the model](https://dev.meta.ai/docs/muse-glimmer/get-the-model)**: download the weights and verify your setup.
- **[Run inference](https://dev.meta.ai/docs/muse-glimmer/deploy)**: pick a runtime and serve it locally.
- **[Post-training](https://dev.meta.ai/docs/muse-glimmer/post-training)**: adapt it to your domain with supervised fine-tuning (SFT) or reinforcement learning (RL).

## List models via the API {#list-models}

Query the catalog programmatically when you need to check what's enabled for your team. This returns the API-hosted models; self-hosted Muse Glimmer isn't included.

**Python (OpenAI SDK)**

```python
import os

from openai import OpenAI

client = OpenAI(
    base_url="https://api.meta.ai/v1",
    api_key=os.environ["MODEL_API_KEY"],
)

response = client.models.list()

print(response.model_dump_json(indent=2))
```

**TypeScript (OpenAI SDK)**

```typescript
import OpenAI from 'openai';

const apiKey = process.env.MODEL_API_KEY;
if (!apiKey) {
  throw new Error('MODEL_API_KEY is not set');
}

const client = new OpenAI({
  baseURL: 'https://api.meta.ai/v1',
  apiKey,
});

const models = await client.models.list();

console.log(JSON.stringify({ object: models.object, data: models.data }, null, 2));
```

**Python (requests)**

```python
import json
import os

import requests

response = requests.get(
    "https://api.meta.ai/v1/models",
    headers={"Authorization": f"Bearer {os.environ['MODEL_API_KEY']}"},
)
response.raise_for_status()
print(json.dumps(response.json(), indent=2))
```

**curl**

```shell
curl -X GET "https://api.meta.ai/v1/models" \
  -H "Authorization: Bearer $MODEL_API_KEY"
```

The response returns models sorted newest-first by creation time, with the model ID as a stable tiebreaker. Each object includes a `created` field — the Unix timestamp in seconds for when the model was added to the registry. `GET /v1/models/{model}` returns the same `created` value for a single model.

## See also {#see-also}

- [Pricing and rate limits](https://dev.meta.ai/docs/pricing-rate-limits): per-token rates for Standard and Contributor mode, and rate limits for each model
- [Subscriptions](https://dev.meta.ai/docs/muse-code/subscriptions): Muse Code plans and what each one includes
