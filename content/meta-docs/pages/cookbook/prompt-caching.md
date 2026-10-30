# Prompt caching {#prompt-caching}

**What you'll build**: a request that reuses a long, stable prompt prefix from cache, so repeated calls skip recomputing the tokens that never change.

|                      |                                                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Section**          | [API fundamentals](https://dev.meta.ai/docs/cookbook#api-fundamentals)                                                                                   |
| **Capabilities**     | [Prompt caching](https://dev.meta.ai/docs/features/prompt-caching)                                                                                       |
| **Time to complete** | \~10 min                                                                                                                                                 |
| **Model**            | `muse-spark-1.3`                                                                                                                                         |
| **Language**         | Python                                                                                                                                                   |
| **Prerequisites**    | the [chat completions recipe](https://dev.meta.ai/docs/cookbook/quickstart-chat-completions), Python 3.10+, the `openai` package, and a `MODEL_API_KEY`. |

When many requests share the same leading tokens (a system prompt, few-shot examples, a knowledge base), the server stores the computed state for that prefix and reuses it. **This happens automatically** — there is no flag to turn on and no cache key to manage. The one lever you control is prompt structure: put stable content first so the unchanging prefix is as long as possible, then read the result from `usage.prompt_tokens_details.cached_tokens`. (At scale you can *optionally* add a `prompt_cache_key` to raise your hit rate — see the production section.) See the [prompt caching guide](https://dev.meta.ai/docs/features/prompt-caching).

## Setup {#setup}

One cell wires up the client: it reads your key from the environment and falls back to Colab secrets when you run in a notebook.

```python
import os
import uuid

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

## Build a stable prefix and reuse it {#build-a-stable-prefix-and-reuse-it}

What makes a cache hit is an **identical leading token sequence**: the server matches from the start of your tokenized prompt and reuses the longest prefix it has seen recently. The first request with a new prefix is a miss (`cached_tokens` is 0); a later request that repeats that prefix reads those tokens from cache.

Caching needs no key. Here we *optionally* pass a `prompt_cache_key`: at scale it routes same-prefix requests to the same backend and raises the hit rate (see the production notes). We randomize it per run only so each run of this notebook starts from a cold cache for illustration — in production you use one **stable** key per shared prefix.

```python
# A long, stable instruction block — the kind of thing you send on every request.
sentence = (
    "You are a support agent for the Acme Cloud platform. Be concise, cite the "
    "relevant runbook section, never invent product names, and escalate billing "
    "disputes to tier 2. "
)
DEVELOPER_PROMPT = "ACME SUPPORT KNOWLEDGE BASE\n" + sentence * 120

CACHE_KEY = f"acme-support-{uuid.uuid4().hex[:8]}"


def ask(question, prefix, cache_key):
    response = client.chat.completions.create(
        model="muse-spark-1.3",
        messages=[
            {"role": "developer", "content": prefix},
            {"role": "user", "content": question},
        ],
        prompt_cache_key=cache_key,
    )
    usage = response.usage
    details = usage.prompt_tokens_details
    cached = details.cached_tokens if details else 0
    return usage.prompt_tokens, cached


prompt_tokens, cached = ask("How do I reset a password?", DEVELOPER_PROMPT, CACHE_KEY)
print(f"Call 1 (cold): {prompt_tokens} prompt tokens, {cached} cached")

prompt_tokens, cached = ask("How do I add a teammate?", DEVELOPER_PROMPT, CACHE_KEY)
print(f"Call 2 (warm): {prompt_tokens} prompt tokens, {cached} cached")
```

Call 2 repeats the leading tokens, so almost the entire prefix comes back as `cached_tokens` and only the new user message needed full computation. (Sharing the `prompt_cache_key` just kept both calls on the same backend; the hit itself comes from the identical prefix.) `cached_tokens` is the number to watch: the closer it is to `prompt_tokens`, the more you are reusing.

## Volatile content at the top breaks the cache {#volatile-content-at-the-top-breaks-the-cache}

The cache matches from the **start of the prompt forward**, so the first token that differs ends the match. Putting anything that changes per request — a timestamp, a request ID, the user's question — ahead of the stable instructions breaks the prefix every time, and `cached_tokens` stays at 0.

```python
bad_key = f"acme-bad-{uuid.uuid4().hex[:8]}"


def ask_volatile_first(question):
    # A per-request ID placed BEFORE the stable instructions changes the prefix every call.
    prefix = f"Request ID: {uuid.uuid4()}\n" + DEVELOPER_PROMPT
    return ask(question, prefix, bad_key)


_, cached1 = ask_volatile_first("How do I reset a password?")
_, cached2 = ask_volatile_first("How do I add a teammate?")
print(f"Call 1 cached: {cached1}")
print(f"Call 2 cached: {cached2}  <- still cold; the changing prefix defeats the cache")
```

## Put stable content first, volatile content last {#put-stable-content-first-volatile-content-last}

Keep the prefix byte-for-byte identical and move anything per-request to the end (the user message is naturally last). Now the long prefix is cached and only the tail is recomputed.

```python
good_key = f"acme-good-{uuid.uuid4().hex[:8]}"


def ask_volatile_last(question):
    # Stable instructions first; the per-request ID rides along in the user message (the tail).
    response = client.chat.completions.create(
        model="muse-spark-1.3",
        messages=[
            {"role": "developer", "content": DEVELOPER_PROMPT},
            {"role": "user", "content": f"{question} (request {uuid.uuid4()})"},
        ],
        prompt_cache_key=good_key,
    )
    details = response.usage.prompt_tokens_details
    return details.cached_tokens if details else 0


print(f"Call 1 cached: {ask_volatile_last('How do I reset a password?')}")
print(
    f"Call 2 cached: {ask_volatile_last('How do I add a teammate?')}  <- prefix served from cache"
)
```

## Cache prompts in production {#cache-prompts-in-production}

- **Put stable content first.** System or developer instructions, few-shot examples, and reference material go before anything that changes per request.
- **Caching is automatic; the `prompt_cache_key` is optional.** Caching works with no key. At high volume, add a *stable* key that names the shared prefix, such as `"customer-support-v2"`, to route same-prefix requests together and raise the hit rate. Reuse it across requests that share that prefix.
- **Don't over-partition.** A unique key per user or session sends each request to a different server and lowers your hit rate. Share a key across requests with the same prefix.
- **Set retention for bursty traffic.** `prompt_cache_retention="24h"` keeps the cache warm across idle gaps; `"in_memory"` is the default fast path. It is a hint, not a guarantee.
- **Monitor the ratio.** Track `cached_tokens / prompt_tokens` over time to confirm your prefix is actually being reused. See the [prompt caching guide](https://dev.meta.ai/docs/features/prompt-caching).

## Summary {#summary}

| Pattern         | How                                                                  |
| --------------- | -------------------------------------------------------------------- |
| Enable caching  | automatic — no flag or key needed                                    |
| Optional key    | stable `prompt_cache_key` per shared prefix raises hit rate at scale |
| Maximize hits   | keep the leading tokens identical; put volatile content last         |
| Read the result | `usage.prompt_tokens_details.cached_tokens`                          |
| Cold vs warm    | first request with a new prefix is a miss (0); later calls reuse it  |
| Retention hint  | `prompt_cache_retention`: `"in_memory"` or `"24h"`                   |

## Next steps {#next-steps}

- Reuse a cached system prompt across a tool-calling agent: recipe [03 — Tool calling](https://dev.meta.ai/docs/cookbook/tool-function-calling).
- Manage a growing prefix as conversations get long: recipe [08 — Long context](https://dev.meta.ai/docs/cookbook/long-context).
- Read the [prompt caching guide](https://dev.meta.ai/docs/features/prompt-caching) and the [API reference](https://dev.meta.ai/docs/api-reference/chat-completions).
