# Chat completions: your first Muse Spark call {#chat-completions-your-first-muse-spark-call}

**What you'll build**: a working chat completion against Muse Spark with the OpenAI Python SDK. Then you add instruction messages, temperature control, and multi-turn conversations.

|                      |                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Section**          | [API fundamentals](https://dev.meta.ai/docs/cookbook#api-fundamentals)                                                     |
| **Capabilities**     | [Text generation](https://dev.meta.ai/docs/features/chat-completion)                                                       |
| **Time to complete** | \~10 min                                                                                                                   |
| **Model**            | `muse-spark-1.3`                                                                                                           |
| **Language**         | Python                                                                                                                     |
| **Prerequisites**    | Python 3.10+, the `openai` package, and a `MODEL_API_KEY` (create one in the [Model API dashboard](https://dev.meta.ai/)). |

Model API exposes two request formats. [**Chat Completions**](https://dev.meta.ai/docs/features/chat-completion) is the messages-array endpoint this recipe uses: it is stateless, so you send the conversation on every request, and it covers most text generation, [tool calling](https://dev.meta.ai/docs/features/tool-calling), [structured output](https://dev.meta.ai/docs/features/structured-output), and image input. The [**Responses API**](https://dev.meta.ai/docs/features/responses) manages conversation state for you and adds built-in tools such as web search; a later recipe covers it.

The Model API is OpenAI-compatible: point the OpenAI SDK at the Model API base URL and set the model to `muse-spark-1.3`, and your existing code runs. It accepts most OpenAI Chat Completions parameters. Because `muse-spark-1.3` is a reasoning model, a few parameters (such as `stop`, `logit_bias`, and `logprobs` without `reasoning_effort="none"`) are not supported and return `HTTP 400`. The [chat completion guide](https://dev.meta.ai/docs/features/chat-completion#openai-compatibility) lists them all.

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

## Your first completion {#your-first-completion}

A minimal request needs two things: a `model` and a `messages` array. Each message has a `role` and `content`. The model reads the array and returns a response that continues the conversation.

```python
response = client.chat.completions.create(
    model="muse-spark-1.3",
    messages=[
        {"role": "user", "content": "In two sentences, what is the Meta Model API?"},
    ],
)

print(response.choices[0].message.content)
print()
print("finish_reason:", response.choices[0].finish_reason)
print("usage:", response.usage)
```

The response object follows the OpenAI chat completion shape:

- `response.choices[0].message.content`: the generated text.
- `response.choices[0].finish_reason`: why generation stopped. `stop` is a natural end, `length` means it hit the token cap, and `tool_calls` means the model wants to call a tool.
- `response.usage`: token counts. Track tokens to stay inside your team's [rate limits](https://dev.meta.ai/docs/getting-started/pricing-rate-limits).

Every parameter and response field is documented in the [Chat completions API reference](https://dev.meta.ai/docs/api-reference/chat-completions).

> **NOTE: Reasoning tokens count as output**
>
> Muse Spark is a reasoning model: it thinks before it answers. Those thinking tokens show up in `usage` as `reasoning_tokens` and count as output tokens, which is why a one-word reply can report dozens of completion tokens. You control the effort with `reasoning_effort`. See recipe [06 — Reasoning tokens](https://dev.meta.ai/docs/cookbook/reasoning-thinking-tokens).

## Steer behavior with a developer message {#steer-behavior-with-a-developer-message}

Add a `developer` message to set tone, format, or standing rules. It is the highest-precedence role you can set, and it overrides conflicting `user` instructions.

Muse Spark accepts a `system` role for OpenAI compatibility, but it applies that content at the `developer` level rather than overriding the model's own system prompt. Prefer `developer`. The [chat completion guide](https://dev.meta.ai/docs/features/chat-completion#system-messages) explains the full instruction hierarchy.

```python
response = client.chat.completions.create(
    model="muse-spark-1.3",
    messages=[
        {
            "role": "developer",
            "content": "You are a terse assistant. Answer in exactly one sentence, with no preamble.",
        },
        {"role": "user", "content": "Why do reasoning models use chain-of-thought?"},
    ],
)

print(response.choices[0].message.content)
```

> **TIP: Try it: change the persona**
>
> **Try it**: replace the `developer` content with `"Answer as a pirate."` and rerun. The persona holds for the whole conversation, not just the next turn.

## Tune randomness with temperature {#tune-randomness-with-temperature}

`temperature` controls variety, on a scale of 0–2. Lower values make output more focused and repeatable; higher values make it more varied. Muse Spark is tuned to run at the **default of `1.0`** and performs best there, so leave it unset for most workloads — the example below varies it only to show the effect. When you want more focused output, prefer clearer instructions over lowering `temperature`. Set `temperature` or `top_p`, not both.

```python
prompt = "Suggest a name for a Python logging library."

for temp in (0.2, 1.5):
    response = client.chat.completions.create(
        model="muse-spark-1.3",
        messages=[{"role": "user", "content": prompt}],
        temperature=temp,
    )
    print(f"temperature={temp}: {response.choices[0].message.content}")
```

## Statelessness is by design {#statelessness-is-by-design}

Chat Completions is stateless: each request is answered using only the `messages` you send, with no memory of earlier calls. That is intentional: you control exactly what context the model sees. If you want the server to remember earlier turns for you, the [Responses API](https://dev.meta.ai/docs/features/responses) keeps state with `previous_response_id`.

So a follow-up that refers back to an earlier turn fails unless you include that turn in the request. Ask an opinionated question, then ask the model to expand its previous answer in a fresh request:

```python
# Turn 1: an opinionated question
opinion = client.chat.completions.create(
    model="muse-spark-1.3",
    messages=[
        {
            "role": "user",
            "content": "In one sentence, name the most underrated module in the Python standard library.",
        }
    ],
)
print("Turn 1:", opinion.choices[0].message.content)

# Turn 2, sent on its own: ask the model to expand the answer it just gave
followup = client.chat.completions.create(
    model="muse-spark-1.3",
    messages=[
        {
            "role": "user",
            "content": "Expand your previous answer into a short paragraph with an example.",
        }
    ],
)
print("\nTurn 2 (no history):", followup.choices[0].message.content)
```

Turn 2 has no previous answer to expand: the model never saw turn 1, so it asks what you mean or picks something at random.

Send the conversation history so the second request can build on the first. Append the assistant's reply and the new user message, then send the full array:

```python
messages = [
    {
        "role": "user",
        "content": "In one sentence, name the most underrated module in the Python standard library.",
    },
]

opinion = client.chat.completions.create(model="muse-spark-1.3", messages=messages)
messages.append({"role": "assistant", "content": opinion.choices[0].message.content})

# Turn 2, with history: now "your previous answer" has a referent
messages.append(
    {
        "role": "user",
        "content": "Expand your previous answer into a short paragraph with an example.",
    }
)
expanded = client.chat.completions.create(model="muse-spark-1.3", messages=messages)
print("Turn 2 (with history):", expanded.choices[0].message.content)
```

> **NOTE: You manage conversation history**
>
> You own the `messages` array, so you decide what context to keep. The context window is 1,048,576 tokens; trim or summarize older turns as conversations grow (recipe [08 — Long context](https://dev.meta.ai/docs/cookbook/long-context)). To let the server manage history for you instead, use the [Responses API](https://dev.meta.ai/docs/features/responses) with `previous_response_id`.

## Handle common error responses {#handle-common-error-responses}

Two failure classes are worth handling: `429 Too Many Requests` (you exceeded the per-team rate limit) and 5xx or timeouts (transient server or network errors). Retry both with exponential backoff and jitter. Do not retry `400` errors: they mean the request is malformed, so fix it instead of resending.

```python
import random
import time

from openai import APIStatusError, APITimeoutError, RateLimitError


def complete_with_retry(messages, *, max_retries=5, **kwargs):
    """Call chat completions, retrying transient 429/5xx/timeout errors."""
    delay = 0.5
    for attempt in range(max_retries):
        try:
            return client.chat.completions.create(
                model="muse-spark-1.3", messages=messages, **kwargs
            )
        except (RateLimitError, APITimeoutError) as exc:
            if attempt == max_retries - 1:
                raise
            sleep_for = delay * (2**attempt) + random.uniform(0, 0.5)
            print(
                f"Transient error ({type(exc).__name__}); retrying in {sleep_for:.1f}s"
            )
            time.sleep(sleep_for)
        except APIStatusError as exc:
            # Retry server errors; re-raise client errors (such as 400) unchanged.
            if exc.status_code >= 500 and attempt < max_retries - 1:
                time.sleep(delay * (2**attempt) + random.uniform(0, 0.5))
                continue
            raise


response = complete_with_retry(
    [{"role": "user", "content": "Give me one tip for handling API rate limits."}]
)
print(response.choices[0].message.content)
```

## Summary {#summary}

| Pattern            | How                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| First call         | `client.chat.completions.create(model="muse-spark-1.3", messages=[...])`                                            |
| Read output        | `response.choices[0].message.content`                                                                               |
| Track tokens       | `response.usage` (`prompt_tokens`, `completion_tokens`, `total_tokens`)                                             |
| Steer behavior     | a `developer` message (prefer it over `system`)                                                                     |
| Control randomness | `temperature` (0–2, default `1.0` — leave unset; prefer clearer instructions over lowering it) or `top_p`, not both |
| Multi-turn         | append assistant + user messages, then resend the full array                                                        |
| Resilience         | retry 429 / 5xx with exponential backoff and jitter; never retry 400                                                |

**Production checklist:**

- Read `MODEL_API_KEY` from the environment, never hard-code it.
- Set a `developer` message for any non-trivial behavior.
- Handle `429` and 5xx with backoff; surface `400` to the caller.
- Watch `usage` and the `x-ratelimit-remaining-*` response headers to throttle before you hit a limit.

## Next steps {#next-steps}

- Stream tokens as they generate for responsive UIs: recipe [02 — Streaming responses](https://dev.meta.ai/docs/cookbook/streaming-responses).
- Let the model call your functions: recipe [03 — Tool calling](https://dev.meta.ai/docs/cookbook/tool-function-calling).
- Force valid JSON out of the model: recipe [04 — Structured output](https://dev.meta.ai/docs/cookbook/structured-output).
- Control thinking effort and read `reasoning_content`: recipe [06 — Reasoning tokens](https://dev.meta.ai/docs/cookbook/reasoning-thinking-tokens).
- Go deeper in the [chat completion guide](https://dev.meta.ai/docs/features/chat-completion) and the [API reference](https://dev.meta.ai/docs/api-reference/chat-completions).
