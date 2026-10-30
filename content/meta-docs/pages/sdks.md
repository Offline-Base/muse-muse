# SDKs and libraries {#sdks-and-libraries}

Build with the clients you already run. Meta Model API doesn't need a client of its own: use the OpenAI SDK for the [Responses API](https://dev.meta.ai/docs/protocols/responses) and [Chat Completions API](https://dev.meta.ai/docs/protocols/chat-completions), the Anthropic SDK for the [Messages API](https://dev.meta.ai/docs/protocols/messages), or any OpenAI-compatible client, such as LangChain, LlamaIndex, the Vercel AI SDK, or LiteLLM. Set the client's base URL, pass your Model API key, and keep the rest of your code.

## Supported features {#supported-features}

Through the OpenAI SDK you can call:

- [Responses API](https://dev.meta.ai/docs/protocols/responses) (`client.responses.create()`)
- [Chat completions](https://dev.meta.ai/docs/protocols/chat-completions) (`client.chat.completions.create()`)
- [Search grounding](https://dev.meta.ai/docs/search-grounding) (via Responses API)
- [Image understanding](https://dev.meta.ai/docs/image-understanding) (vision)
- [Video and audio understanding](https://dev.meta.ai/docs/video-understanding) (Responses API and Chat Completions)
- [Structured output](https://dev.meta.ai/docs/structured-output) (`response_format`)
- [Tool calling](https://dev.meta.ai/docs/tool-calling)
- [File uploads](https://dev.meta.ai/docs/file-handling) (`client.files.create()`)
- [Streaming](https://dev.meta.ai/docs/protocols/chat-completions#streaming)
- [Temperature and sampling parameters](https://dev.meta.ai/docs/protocols/chat-completions#parameters)
- [Model selection](https://dev.meta.ai/docs/protocols/chat-completions#parameters)

## Python {#python}

Install the package:

```shell
pip install openai
```

Send a request:

**Python (OpenAI SDK)**

```python
import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["MODEL_API_KEY"],
    base_url="https://api.meta.ai/v1",
)

response = client.responses.create(
    model="muse-spark-1.3",
    input="Explain mixture-of-experts in two sentences.",
)
print(response.output_text)
```

## TypeScript {#typescript}

Install the package:

```shell
npm install openai
```

Send a request:

**TypeScript (OpenAI SDK)**

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.MODEL_API_KEY,
  baseURL: "https://api.meta.ai/v1",
});

const response = await client.responses.create({
  model: "muse-spark-1.3",
  input: "Explain mixture-of-experts in two sentences.",
});
console.log(response.output_text);
```

## Anthropic SDK {#anthropic}

Use the Anthropic SDK for the Model API [Messages API](https://dev.meta.ai/docs/protocols/messages). Set `base_url` to `https://api.meta.ai` (the SDK appends `/v1/messages`), and pass your Model API key as `auth_token`, which the SDK sends as a bearer token.

A response's `content` starts with a `redacted_thinking` block that carries the model's encrypted reasoning, so read the `text` blocks instead of indexing `content[0]`:

**Python (Anthropic SDK)**

```python
import os
from anthropic import Anthropic

client = Anthropic(
    base_url="https://api.meta.ai",
    auth_token=os.environ["MODEL_API_KEY"],
)

message = client.messages.create(
    model="muse-spark-1.3",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Explain mixture-of-experts in two sentences."}],
)
print("".join(block.text for block in message.content if block.type == "text"))
```

See the [Messages API guide](https://dev.meta.ai/docs/protocols/messages) for the full request and response shape.

## OpenAI-compatible clients {#openai-compatible}

Any client or framework that speaks the OpenAI API and accepts a custom base URL works with Model API, including LangChain, LlamaIndex, the Vercel AI SDK, and LiteLLM. Most ask for three values: the base URL `https://api.meta.ai/v1`, your Model API key, and a model ID such as `muse-spark-1.3`.

LiteLLM reaches Model API through its OpenAI provider, so prefix the model ID with `openai/`:

```shell
pip install litellm
```

**Python (LiteLLM)**

```python
import os
import litellm

response = litellm.completion(
    model="openai/muse-spark-1.3",
    api_base="https://api.meta.ai/v1",
    api_key=os.environ["MODEL_API_KEY"],
    messages=[{"role": "user", "content": "Explain mixture-of-experts in two sentences."}],
)
print(response.choices[0].message.content)
```

## Segment Anything Model client libraries {#sam-client-libraries}

[Segment Anything Model 3.1 (SAM 3.1)](https://dev.meta.ai/docs/models#sam-3) returns its boxes and masks as a token grammar in the Responses output text. The Meta-SAM client libraries decode it for you. `@meta-sam/parser` (TypeScript) and `meta_sam_parser` (Python) turn the stream into typed segmentation snapshots and decode masks. The optional `@meta-sam/graphics`, `@meta-sam/video`, and `@meta-sam/react` packages draw overlays and play segmented video.

Install them and parse your first stream with the [Segment Anything Model client libraries guide](https://dev.meta.ai/docs/sam/client-libraries).

## Authentication {#authentication}

None of these clients reads `MODEL_API_KEY` on its own. The OpenAI SDK looks for `OPENAI_API_KEY` and the Anthropic SDK looks for `ANTHROPIC_API_KEY`, so pass your Model API key explicitly when you create the client:

**Python (OpenAI SDK)**

```python
import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["MODEL_API_KEY"],
    base_url="https://api.meta.ai/v1",
)
```

See [Authentication](https://dev.meta.ai/docs/authentication) for details on creating and managing API keys.
