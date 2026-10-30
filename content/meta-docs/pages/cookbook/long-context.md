# Long context (1M) {#long-context-1m}

**What you'll build**: measure how many tokens a request uses, fit large inputs inside Muse Spark's 1,048,576-token window, and keep long conversations under budget.

|                      |                                                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Section**          | [API fundamentals](https://dev.meta.ai/docs/cookbook#api-fundamentals)                                                                                   |
| **Capabilities**     | [Long context](https://dev.meta.ai/docs/getting-started/models)                                                                                          |
| **Time to complete** | \~10 min                                                                                                                                                 |
| **Model**            | `muse-spark-1.3`                                                                                                                                         |
| **Language**         | Python                                                                                                                                                   |
| **Prerequisites**    | the [chat completions recipe](https://dev.meta.ai/docs/cookbook/quickstart-chat-completions), Python 3.10+, the `openai` package, and a `MODEL_API_KEY`. |

Muse Spark has a **1,048,576-token** context window, big enough for whole files or repo-level context. Input and the requested output share that one budget, so the skill is measuring and structuring what you send. See [models](https://dev.meta.ai/docs/getting-started/models).

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

## Measure before you send {#measure-before-you-send}

`POST /v1/responses/input_tokens` returns the exact input-token count for a request without generating anything. Use it to check a payload against the window before you spend a call.

```python
WINDOW = 1_048_576


def count_input_tokens(text):
    result = client.post(
        "/responses/input_tokens",
        body={"model": "muse-spark-1.3", "input": text},
        cast_to=object,
    )
    return result["input_tokens"]


question = "Summarize the key architecture decisions."
# Stand in for a large file by repeating a paragraph.
document = "The service uses a sharded datastore with async replication. " * 800

print("context window:", WINDOW)
print("short prompt:", count_input_tokens(question), "tokens")
print("document:", count_input_tokens(document), "tokens")
```

## Full files or summaries? {#full-files-or-summaries}

Two ways to give the model context: paste the full text, or summarize it first. Full text preserves every detail (use it when the model must reason over exact wording, such as code); a summary costs a fraction of the tokens (use it when the gist is enough). Count both and decide.

```python
full_file = document
summary = (
    "Summary: the service uses a sharded datastore with async replication; "
    "key decisions are shard-by-tenant, eventual consistency, and read replicas."
)

print("full file:", count_input_tokens(full_file), "tokens")
print("summary:  ", count_input_tokens(summary), "tokens")
```

## Over-stuffing the window returns a 400 {#over-stuffing-the-window-returns-a-400}

Input tokens plus the tokens you ask the model to generate must fit in 1,048,576. Push the input past the window and the request is rejected with `HTTP 400` — there is no server-side truncation to save you.

```python
from openai import BadRequestError

# Far more than the 1,048,576-token window
oversized = "The service uses a sharded datastore with async replication. " * 120000

try:
    client.chat.completions.create(
        model="muse-spark-1.3",
        messages=[{"role": "user", "content": oversized}],
    )
except BadRequestError as exc:
    print("HTTP", exc.status_code, "-", str(exc)[:150])
```

The detailed form of this error reports your input tokens, the requested output tokens, and the 1,048,576-token limit so you can see how far over you are. Either way, the fix is the same: measure first, and keep input plus planned output under the window by trimming or summarizing.

## Keep a long conversation under budget {#keep-a-long-conversation-under-budget}

A multi-turn conversation grows every turn. A **sliding window** caps it: always keep the instruction messages, and drop the oldest turns. (Summarize older turns instead when their content still matters — trimming simply forgets them.)

```python
def trim_history(messages, max_messages=8):
    """Keep instruction messages, drop the oldest turns beyond the window."""
    instructions = [m for m in messages if m["role"] in ("developer", "system")]
    turns = [m for m in messages if m["role"] not in ("developer", "system")]
    keep = max(0, max_messages - len(instructions))
    return instructions + turns[-keep:]


history = [{"role": "developer", "content": "You are a concise assistant."}]
for i in range(20):
    history.append(
        {"role": "user", "content": f"Tell me one fact about the number {i}."}
    )
    history.append({"role": "assistant", "content": f"A fact about {i}."})
history.append({"role": "user", "content": "Give me one fact about the number 19."})

trimmed = trim_history(history, max_messages=8)
print(f"trimmed {len(history)} messages down to {len(trimmed)}")

response = client.chat.completions.create(model="muse-spark-1.3", messages=trimmed)
print(response.choices[0].message.content[:160])
```

## Manage long context in production {#manage-long-context-in-production}

- **Measure, don't guess.** Call `/v1/responses/input_tokens` before large or variable requests; input and output share the 1,048,576-token budget.
- **Match the form to the task.** Full files when exact wording matters (code, contracts); summaries when the gist is enough (long chat history).
- **Cap conversation growth.** A sliding window keeps instructions plus recent turns; summarization preserves older context in fewer tokens.
- **There is no server-side truncation.** `truncation: "auto"` is rejected and over-window requests return `HTTP 400`, so compact client-side. See [error handling](https://dev.meta.ai/docs/getting-started/error-handling).

## Summary {#summary}

| Pattern         | How                                                                          |
| --------------- | ---------------------------------------------------------------------------- |
| Window          | 1,048,576 tokens, shared by input and output                                 |
| Measure         | `POST /v1/responses/input_tokens` returns the input count without generating |
| Full vs summary | full text for exact reasoning; summary to save tokens                        |
| Cap growth      | sliding window (keep instructions + recent turns) or summarize               |
| Over budget     | returns `HTTP 400`; no server-side truncation — compact client-side          |

## Next steps {#next-steps}

- Reuse a long, stable prefix cheaply across calls: recipe [05 — Prompt caching](https://dev.meta.ai/docs/cookbook/prompt-caching).
- Let the server manage growing history for you: the [Responses API](https://dev.meta.ai/docs/features/responses) with `previous_response_id`.
- Read [models](https://dev.meta.ai/docs/getting-started/models) and [error handling](https://dev.meta.ai/docs/getting-started/error-handling).
