# Tool / function calling {#tool--function-calling}

**What you'll build**: a chat completion that calls one of your functions, runs it, and uses the result to answer — the core loop behind agents.

|                      |                                                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Section**          | [API fundamentals](https://dev.meta.ai/docs/cookbook#api-fundamentals)                                                                                   |
| **Capabilities**     | [Tool calling](https://dev.meta.ai/docs/features/tool-calling)                                                                                           |
| **Time to complete** | \~10 min                                                                                                                                                 |
| **Model**            | `muse-spark-1.3`                                                                                                                                         |
| **Language**         | Python                                                                                                                                                   |
| **Prerequisites**    | the [chat completions recipe](https://dev.meta.ai/docs/cookbook/quickstart-chat-completions), Python 3.10+, the `openai` package, and a `MODEL_API_KEY`. |

You describe your functions as tools; the model decides when one is needed and returns the call it wants, with arguments. You run the function and hand the result back, and the model finishes the answer. See the [tool calling guide](https://dev.meta.ai/docs/features/tool-calling).

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

## Define a tool and detect a call {#define-a-tool-and-detect-a-call}

A tool is a function described with a JSON schema. On Chat Completions the definition nests under `function`. When the model wants the tool, it returns `finish_reason="tool_calls"` and one or more `tool_calls`, each with arguments as a JSON string.

```python
import json


def get_weather(city):
    """A real tool would call a weather service; here we return a canned value."""
    readings = {"Paris": "18°C", "Tokyo": "24°C", "Nairobi": "26°C"}
    return readings.get(city, "unknown")


tools = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get the current temperature for a city.",
            "parameters": {
                "type": "object",
                "properties": {
                    "city": {
                        "type": "string",
                        "description": "City name, such as Paris.",
                    }
                },
                "required": ["city"],
            },
        },
    }
]

messages = [{"role": "user", "content": "What's the temperature in Paris right now?"}]
response = client.chat.completions.create(
    model="muse-spark-1.3", messages=messages, tools=tools
)
choice = response.choices[0]
print("finish_reason:", choice.finish_reason)
for tc in choice.message.tool_calls or []:
    print(f"  wants: {tc.function.name}({tc.function.arguments})")
```

## Return the result the model asked for {#return-the-result-the-model-asked-for}

`finish_reason="tool_calls"` means the model wants you to run a function and hand back the result. The conversation-structure rule: append the **full assistant message** (the one carrying `tool_calls`), then one `tool` message per call with the matching `tool_call_id`. Skip the assistant message and the API rejects the request with `HTTP 400` rather than guessing.

```python
from openai import BadRequestError

tool_call = choice.message.tool_calls[0]
result = get_weather(json.loads(tool_call.function.arguments)["city"])

# Wrong: send the tool result without first replaying the assistant tool_calls message
try:
    client.chat.completions.create(
        model="muse-spark-1.3",
        messages=[
            {"role": "user", "content": "What's the temperature in Paris right now?"},
            {"role": "tool", "tool_call_id": tool_call.id, "content": result},
        ],
        tools=tools,
    )
except BadRequestError as exc:
    print("HTTP 400:", str(exc)[:200])
```

Include the assistant message, then the `tool` message, and the model uses the result to answer:

```python
messages.append(choice.message)  # the assistant message that holds tool_calls
messages.append({"role": "tool", "tool_call_id": tool_call.id, "content": result})

final = client.chat.completions.create(
    model="muse-spark-1.3", messages=messages, tools=tools
)
print(final.choices[0].message.content)
```

## Handle multiple tool calls {#handle-multiple-tool-calls}

A single question can need several tools. The model may return several `tool_calls` in one turn (parallel), or request them across turns. Handle both the same way: every turn, run each call the model asked for, append one `tool` message per `tool_call_id`, and loop until `finish_reason` is no longer `tool_calls`.

```python
messages = [
    {
        "role": "user",
        "content": "Compare the temperature in Tokyo and Nairobi, then say which is warmer.",
    }
]

for _ in range(5):
    response = client.chat.completions.create(
        model="muse-spark-1.3", messages=messages, tools=tools
    )
    message = response.choices[0].message
    if not message.tool_calls:
        print("Answer:", message.content)
        break
    cities = [json.loads(tc.function.arguments)["city"] for tc in message.tool_calls]
    print("Tool calls this turn:", cities)
    messages.append(message)
    for tc in message.tool_calls:
        city = json.loads(tc.function.arguments)["city"]
        messages.append(
            {"role": "tool", "tool_call_id": tc.id, "content": get_weather(city)}
        )
```

## Handle tool calls in production {#handle-tool-calls-in-production}

- **Wrap the call-and-feed-back loop in a function** with a `max_turns` cap, so a tool result that triggers another call resolves without an unbounded loop. The cell above is that loop.
- **Write precise descriptions and typed parameters.** The model decides whether and how to call a tool from the `description` and the JSON-schema `parameters`. A vague description leads to wrong or skipped calls.
- **Validate arguments before executing.** Parse and check the arguments, and return an error string the model can recover from rather than raising.
- **`tool_choice` only supports `"auto"`.** `"auto"` (the default) lets the model decide whether to call a tool; `"none"`, `"required"`, and named function choices are rejected with `HTTP 400`. Design for `"auto"`: handle both a tool call and a plain-text response.
- **`web_search` is a [Responses API](https://dev.meta.ai/docs/features/responses) built-in tool**, not available on Chat Completions, which accepts only `function` tools.

## Summary {#summary}

| Pattern         | How                                                                         |
| --------------- | --------------------------------------------------------------------------- |
| Define a tool   | `tools=[{"type": "function", "function": {name, description, parameters}}]` |
| Detect a call   | `finish_reason == "tool_calls"`, read `message.tool_calls`                  |
| Return a result | append the assistant message, then a `tool` message per `tool_call_id`      |
| Parallel calls  | one turn can hold several `tool_calls`; answer each                         |
| Loop            | repeat until `finish_reason` is no longer `tool_calls`                      |
| Strategy        | `tool_choice`: only `auto` is supported (others return `HTTP 400`)          |

## Next steps {#next-steps}

- Force schema-valid JSON instead of free text: recipe [04 — Structured output](https://dev.meta.ai/docs/cookbook/structured-output).
- Stream tool-call arguments as they generate: recipe [02 — Streaming responses](https://dev.meta.ai/docs/cookbook/streaming-responses).
- Read the [tool calling guide](https://dev.meta.ai/docs/features/tool-calling) and the [API reference](https://dev.meta.ai/docs/api-reference/chat-completions).
