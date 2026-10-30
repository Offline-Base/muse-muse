# Streaming responses {#streaming-responses}

**What you'll build**: a chat completion that streams tokens as they generate, so your UI shows output immediately instead of waiting for the whole response.

|                      |                                                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Section**          | [API fundamentals](https://dev.meta.ai/docs/cookbook#api-fundamentals)                                                                                   |
| **Capabilities**     | [Streaming](https://dev.meta.ai/docs/features/chat-completion#streaming)                                                                                 |
| **Time to complete** | \~10 min                                                                                                                                                 |
| **Model**            | `muse-spark-1.3`                                                                                                                                         |
| **Language**         | Python                                                                                                                                                   |
| **Prerequisites**    | the [chat completions recipe](https://dev.meta.ai/docs/cookbook/quickstart-chat-completions), Python 3.10+, the `openai` package, and a `MODEL_API_KEY`. |

Streaming delivers the response as server-sent events: a sequence of chunks you consume as they arrive. Total generation time is the same, but the user sees the first words sooner, which is what matters for chat UIs and CLIs. See the [chat completion guide](https://dev.meta.ai/docs/features/chat-completion#streaming).

## Setup {#setup}

One cell wires up the client: it reads your key from the environment and falls back to Colab secrets when you run in a notebook.

```python
import os

from openai import OpenAI

# Auth: in Colab, read the key from the secrets manager (the key icon in the
# left sidebar); otherwise read the MODEL_API_KEY environment variable.
try:
    from google.colab import userdata

    api_key = userdata.get("MODEL_API_KEY")
except Exception:
    api_key = os.environ.get("MODEL_API_KEY")

if not api_key:
    raise RuntimeError(
        "Set MODEL_API_KEY in your environment (or add it to Colab secrets)."
    )

# The OpenAI SDK does not auto-read MODEL_API_KEY, so pass it explicitly.
client = OpenAI(base_url="https://api.meta.ai/v1", api_key=api_key)

# Connectivity check: a one-line call that confirms the key and endpoint work.
ping = client.chat.completions.create(
    model="muse-spark-1.3",
    messages=[{"role": "user", "content": "Reply with the single word: ready"}],
)
print(ping.choices[0].message.content)
```

## Stream your first response {#stream-your-first-response}

Set `stream=True`. Instead of one response object, you get an iterator of chunks. Each chunk carries the next piece of text at `chunk.choices[0].delta.content`. Print each delta as it arrives.

```python
stream = client.chat.completions.create(
    model="muse-spark-1.3",
    messages=[
        {"role": "user", "content": "List three uses for a hash map, one line each."}
    ],
    stream=True,
)

for chunk in stream:
    if chunk.choices and chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
print()
```

## Accumulate the full text {#accumulate-the-full-text}

To use the streamed text after rendering it (to log it, or append it to the conversation), build a string from the deltas. The catch: the final chunk carries `finish_reason` and a `delta.content` of `None`, so a naive concatenation hits a `TypeError`.

```python
stream = client.chat.completions.create(
    model="muse-spark-1.3",
    messages=[{"role": "user", "content": "Name two sorting algorithms."}],
    stream=True,
)

text = ""
try:
    for chunk in stream:
        text += chunk.choices[0].delta.content  # fails when delta.content is None
except TypeError as exc:
    print("Crashed mid-stream:", exc)
    print("Collected before the crash:", repr(text))
```

Guard each chunk: skip any whose `choices` is empty or whose `delta.content` is `None`. The same guard handles the final chunk and any keep-alive chunks.

```python
stream = client.chat.completions.create(
    model="muse-spark-1.3",
    messages=[{"role": "user", "content": "Name two sorting algorithms."}],
    stream=True,
)

text = ""
for chunk in stream:
    if chunk.choices and chunk.choices[0].delta.content:
        text += chunk.choices[0].delta.content

print(text)
```

## Read token usage while streaming {#read-token-usage-while-streaming}

A streamed response omits the `usage` object by default. Ask for it with `stream_options={"include_usage": True}`: the stream ends with a chunk that carries `usage`. Read it from whichever chunk has `usage` set.

```python
stream = client.chat.completions.create(
    model="muse-spark-1.3",
    messages=[
        {"role": "user", "content": "Give me a one-sentence tip for code review."}
    ],
    stream=True,
    stream_options={"include_usage": True},
)

text = ""
usage = None
for chunk in stream:
    if chunk.choices and chunk.choices[0].delta.content:
        text += chunk.choices[0].delta.content
    if chunk.usage:
        usage = chunk.usage

print(text)
print("usage:", usage)
```

## Stream reliably in production {#stream-reliably-in-production}

- **Render incrementally, keep the full text.** Send each delta to the client, and accumulate the string for logging or the next turn.
- **Guard every chunk.** `delta.content` is `None` on the final chunk, and `choices` can be empty on a usage-only chunk. Check both before indexing.
- **Handle a slow or dropped stream.** A stream is a long-lived HTTP read: set a timeout and catch `APITimeoutError` and `APIConnectionError`. On a break you keep the text accumulated so far; retrying restarts the stream from the beginning.
- **Reasoning happens before the first visible delta.** Muse Spark reasons internally, so a reasoning-heavy prompt can pause before content streams. The deltas carry the answer text, not the reasoning (see recipe [06 — Reasoning tokens](https://dev.meta.ai/docs/cookbook/reasoning-thinking-tokens)).

```python
from openai import APIConnectionError, APITimeoutError


def stream_completion(messages, **kwargs):
    """Stream a completion, render deltas live, and return the full text."""
    parts = []
    try:
        stream = client.chat.completions.create(
            model="muse-spark-1.3", messages=messages, stream=True, **kwargs
        )
        for chunk in stream:
            if chunk.choices and chunk.choices[0].delta.content:
                piece = chunk.choices[0].delta.content
                parts.append(piece)
                print(piece, end="", flush=True)
    except (APITimeoutError, APIConnectionError) as exc:
        print(f"\n[stream interrupted: {type(exc).__name__}; keeping partial text]")
    print()
    return "".join(parts)


full = stream_completion(
    [{"role": "user", "content": "In two sentences, why use streaming in a chat UI?"}]
)
print("---")
print("characters streamed:", len(full))
```

## Summary {#summary}

| Pattern           | How                                                                               |
| ----------------- | --------------------------------------------------------------------------------- |
| Enable streaming  | `stream=True` on `chat.completions.create(...)`                                   |
| Read a delta      | `chunk.choices[0].delta.content` (can be `None`)                                  |
| Accumulate safely | skip chunks where `choices` is empty or `delta.content` is `None`                 |
| Get usage         | `stream_options={"include_usage": True}`, then read `chunk.usage`                 |
| Detect the end    | `chunk.choices[0].finish_reason` on the final chunk                               |
| Resilience        | set a timeout; on `APITimeoutError` / `APIConnectionError`, keep the partial text |

## Next steps {#next-steps}

- Stream a tool-calling loop: tool-call arguments arrive as deltas too. Recipe [03 — Tool calling](https://dev.meta.ai/docs/cookbook/tool-function-calling).
- Control reasoning effort and read the chain-of-thought: recipe [06 — Reasoning tokens](https://dev.meta.ai/docs/cookbook/reasoning-thinking-tokens).
- Read the [chat completion guide](https://dev.meta.ai/docs/features/chat-completion#streaming) and the [API reference](https://dev.meta.ai/docs/api-reference/chat-completions).
