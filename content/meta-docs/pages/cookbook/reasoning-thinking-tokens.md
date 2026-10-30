# Reasoning / thinking tokens {#reasoning--thinking-tokens}

**What you'll build**: control how much Muse Spark thinks before answering, account for the tokens that thinking costs, and carry reasoning across turns with the Responses API.

|                      |                                                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Section**          | [API fundamentals](https://dev.meta.ai/docs/cookbook#api-fundamentals)                                                                                   |
| **Capabilities**     | [Reasoning](https://dev.meta.ai/docs/features/reasoning)                                                                                                 |
| **Time to complete** | \~10 min                                                                                                                                                 |
| **Model**            | `muse-spark-1.3`                                                                                                                                         |
| **Language**         | Python                                                                                                                                                   |
| **Prerequisites**    | the [chat completions recipe](https://dev.meta.ai/docs/cookbook/quickstart-chat-completions), Python 3.10+, the `openai` package, and a `MODEL_API_KEY`. |

Muse Spark is a reasoning model: it works through a problem internally before producing an answer. You set the depth with `reasoning_effort`, and the thinking shows up in `usage` as `reasoning_tokens`. See the [chat completion guide](https://dev.meta.ai/docs/features/chat-completion) and the [Responses API guide](https://dev.meta.ai/docs/features/responses).

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

## Control how much the model thinks {#control-how-much-the-model-thinks}

`reasoning_effort` sets how much internal reasoning the model does before answering. Values run from `minimal` through `low`, `medium`, up to `high`: higher means more reasoning tokens and usually better answers on hard problems. Watch `reasoning_tokens` climb with the effort. (`xhigh` is accepted, but it maps to the same reasoning strength as `high`, so `high` is effectively the maximum.)

```python
question = (
    "A farmer has 17 sheep. All but 9 run away. He then buys 3 times as many as "
    "he has left. How many sheep does he have? Answer with just the number."
)

for effort in ("minimal", "low", "medium", "high"):
    response = client.chat.completions.create(
        model="muse-spark-1.3",
        messages=[{"role": "user", "content": question}],
        reasoning_effort=effort,
    )
    reasoning_tokens = response.usage.completion_tokens_details.reasoning_tokens
    answer = response.choices[0].message.content.strip()
    print(f"{effort:>8}: {reasoning_tokens:>4} reasoning tokens -> {answer[:20]}")
```

## Reasoning tokens are output tokens {#reasoning-tokens-are-output-tokens}

`reasoning_tokens` are part of `completion_tokens`: you pay for them as output and they count against your output-token budget, even though they never appear in the response text. Two things to know:

- The **default effort** (when you omit `reasoning_effort`) is still being finalized, so this recipe doesn't assert a specific level. Set the parameter when the depth matters.
- To spend the fewest reasoning tokens, set a low effort such as `minimal`. The full spectrum is `none` < `minimal` < `low` < `medium` < `high`, and `xhigh` maps to the same reasoning strength as `high` (so `high` is the effective maximum). The API defines the string `"none"` to switch reasoning off — that's the string, not Python `None`, which leaves the parameter unset — but it isn't reliably available yet on the public endpoint, so verify before relying on it.

## Match effort to the task {#match-effort-to-the-task}

High effort on a simple task burns reasoning tokens for no benefit. Compare `high` and `minimal` on a trivial question: the answer is the same, the token bill is not.

```python
trivial = "What is 12 * 8? Reply with just the number."

for effort in ("high", "minimal"):
    response = client.chat.completions.create(
        model="muse-spark-1.3",
        messages=[{"role": "user", "content": trivial}],
        reasoning_effort=effort,
    )
    reasoning_tokens = response.usage.completion_tokens_details.reasoning_tokens
    answer = response.choices[0].message.content.strip()
    print(f"{effort:>8}: {reasoning_tokens:>4} reasoning tokens -> {answer}")
```

Same answer either way. Reserve `high` — the effective maximum — for genuinely hard problems and keep simple calls at `minimal` or `low`.

## Reasoning is internal {#reasoning-is-internal}

The chain-of-thought is not returned as text on Chat Completions: the non-standard `reasoning_content` field is empty today on the public endpoint, so don't build on reading it here. You still see how much thinking happened through `reasoning_tokens`.

```python
response = client.chat.completions.create(
    model="muse-spark-1.3",
    messages=[{"role": "user", "content": "Name a prime number between 10 and 20."}],
    reasoning_effort="low",
)
message = response.choices[0].message
print("answer:", message.content)
print("reasoning_content:", (message.model_extra or {}).get("reasoning_content"))
print("reasoning_tokens:", response.usage.completion_tokens_details.reasoning_tokens)
```

## Get at the reasoning on the Responses API {#get-at-the-reasoning-on-the-responses-api}

The [Responses API](https://dev.meta.ai/docs/features/responses) returns a `reasoning` output item. Its content is **encrypted** — you can replay it across turns, not read it — and the human-readable `summary` is empty for Muse Spark today. Request it with `store=False` and `include=["reasoning.encrypted_content"]`.

```python
resp = client.responses.create(
    model="muse-spark-1.3",
    input="In one sentence, why is the sky blue?",
    reasoning={"effort": "low"},
    include=["reasoning.encrypted_content"],
    store=False,
)

print("output items:", [item.type for item in resp.output])
for item in resp.output:
    if item.type == "reasoning":
        print("reasoning id:", item.id)
        print("summary:", item.summary)
        print(
            "encrypted_content present:", bool(getattr(item, "encrypted_content", None))
        )
print("answer:", resp.output_text)
```

## Carry reasoning across turns {#carry-reasoning-across-turns}

In a multi-step flow the model needs its earlier reasoning to stay consistent. The simplest way is to let the server keep it: pass `previous_response_id` and the server replays the stored reasoning and history for you. (A stateless client that holds its own history replays the encrypted `reasoning` item instead — see the [Responses API guide](https://dev.meta.ai/docs/features/responses).)

```python
first = client.responses.create(
    model="muse-spark-1.3",
    input="I'm planning a 3-day trip to Lisbon. Suggest one neighborhood to stay in.",
)
print("Turn 1:", first.output_text[:100], "...")

followup = client.responses.create(
    model="muse-spark-1.3",
    input="Why that one over the alternatives?",
    previous_response_id=first.id,
)
print("Turn 2:", followup.output_text[:160])
```

## Summary {#summary}

| Pattern            | How                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| Control depth      | `reasoning_effort`: `none` < `minimal` < `low` < `medium` < `high` (`xhigh` = same strength as `high`) |
| Cost               | `reasoning_tokens` are output tokens (`usage.completion_tokens_details.reasoning_tokens`)              |
| Match effort       | `minimal`/`low` for simple tasks, `high` for hard ones                                                 |
| Inspect            | `reasoning_content` is empty on Chat today; Responses returns an encrypted `reasoning` item            |
| Carry across turns | `previous_response_id` (server-managed), or replay the encrypted reasoning item                        |

## Next steps {#next-steps}

- Stream the answer while the model reasons first: recipe [02 — Streaming responses](https://dev.meta.ai/docs/cookbook/streaming-responses).
- Manage long agentic histories within the context window: recipe [08 — Long context](https://dev.meta.ai/docs/cookbook/long-context).
- Read the [chat completion guide](https://dev.meta.ai/docs/features/chat-completion) and the [Responses API guide](https://dev.meta.ai/docs/features/responses).
