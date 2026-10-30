# Structured output (JSON mode) {#structured-output-json-mode}

**What you'll build**: a call that returns JSON guaranteed to match your schema, so you can parse it directly instead of writing defensive cleanup around freeform text.

|                      |                                                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Section**          | [API fundamentals](https://dev.meta.ai/docs/cookbook#api-fundamentals)                                                                                   |
| **Capabilities**     | [Structured output](https://dev.meta.ai/docs/features/structured-output)                                                                                 |
| **Time to complete** | \~10 min                                                                                                                                                 |
| **Model**            | `muse-spark-1.3`                                                                                                                                         |
| **Language**         | Python                                                                                                                                                   |
| **Prerequisites**    | the [chat completions recipe](https://dev.meta.ai/docs/cookbook/quickstart-chat-completions), Python 3.10+, the `openai` package, and a `MODEL_API_KEY`. |

Pass a JSON schema in `response_format` and the model's output is constrained to conform. That turns "parse the model's prose and hope" into "load a known shape." See the [structured output guide](https://dev.meta.ai/docs/features/structured-output).

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

## Ask for JSON the naive way {#ask-for-json-the-naive-way}

A common first attempt is to ask for JSON in the prompt and parse the reply. The problem: the reply is freeform text. The model often adds a sentence of preamble or wraps the JSON in a markdown fence, and `json.loads()` chokes on anything that isn't pure JSON.

```python
import json

response = client.chat.completions.create(
    model="muse-spark-1.3",
    messages=[
        {
            "role": "user",
            "content": (
                "Describe the Keychron K2 in one sentence, then give its specs as JSON "
                "with keys name, price_usd, and in_stock."
            ),
        }
    ],
)

content = response.choices[0].message.content
print("Raw output:\n", content[:240], "...\n")

try:
    data = json.loads(content)
    print("Parsed — but only because this reply happened to be clean:", data)
except json.JSONDecodeError as exc:
    print("json.loads failed:", exc)
```

## Constrain the output with a schema {#constrain-the-output-with-a-schema}

Pass `response_format` with `type: "json_schema"` and a schema. Constrained decoding guarantees the output conforms, so `json.loads()` always succeeds. Set `additionalProperties: false` and list `required` keys to lock the shape down.

```python
schema = {
    "type": "json_schema",
    "json_schema": {
        "name": "product",
        "schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "price_usd": {"type": "number"},
                "in_stock": {"type": "boolean"},
            },
            "required": ["name", "price_usd", "in_stock"],
            "additionalProperties": False,
        },
    },
}

response = client.chat.completions.create(
    model="muse-spark-1.3",
    messages=[
        {
            "role": "user",
            "content": (
                "Describe the Keychron K2 in one sentence, then give its specs as JSON "
                "with keys name, price_usd, and in_stock."
            ),
        }
    ],
    response_format=schema,
)

data = json.loads(response.choices[0].message.content)
print(data)
```

## Parse straight into a typed object with Pydantic {#parse-straight-into-a-typed-object-with-pydantic}

`client.beta.chat.completions.parse()` takes a Pydantic model as `response_format` and returns the typed object on `message.parsed`. The schema comes from your model definition, so there is one source of truth for the shape.

```python
from pydantic import BaseModel


class Product(BaseModel):
    name: str
    price_usd: float
    in_stock: bool


completion = client.beta.chat.completions.parse(
    model="muse-spark-1.3",
    messages=[
        {"role": "user", "content": "Product: Logitech MX Master 3S, $99, sold out."}
    ],
    response_format=Product,
)

product = completion.choices[0].message.parsed
print(type(product).__name__, "->", product)
print("in_stock:", product.in_stock)
```

## Validate structured output in production {#validate-structured-output-in-production}

- **Lock the shape.** Set `additionalProperties: false` and mark every field you depend on as `required`; use `enum` for closed value sets.
- **Prefer the Pydantic path** when you already model the data in Python: one definition drives both the request and the parsed type.
- **Recursive schemas are rejected.** A self-referencing `$ref` returns `HTTP 400` on both endpoints; flatten it or cap the depth.
- **On the Responses API the parameter is `text.format`, not `response_format`.** Sending `response_format` there returns `HTTP 400`. See the [structured output guide](https://dev.meta.ai/docs/features/structured-output).
- **Structured output vs tool calling.** Use structured output when you want one JSON object back; use [tool calling](https://dev.meta.ai/docs/cookbook/tool-function-calling) when the model should choose to invoke your code.

## Summary {#summary}

| Pattern        | How                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------- |
| Guarantee JSON | `response_format={"type": "json_schema", "json_schema": {...}}`                             |
| Lock the shape | `additionalProperties: false` + `required` + `enum`                                         |
| Typed object   | `client.beta.chat.completions.parse(..., response_format=PydanticModel)` → `message.parsed` |
| Read it        | `json.loads(response.choices[0].message.content)` always parses                             |
| Responses API  | use `text.format`, not `response_format`                                                    |

## Next steps {#next-steps}

- Let the model call your code instead of returning data: recipe [03 — Tool calling](https://dev.meta.ai/docs/cookbook/tool-function-calling).
- Stream a structured response as it generates: recipe [02 — Streaming responses](https://dev.meta.ai/docs/cookbook/streaming-responses).
- Read the [structured output guide](https://dev.meta.ai/docs/features/structured-output) and the [API reference](https://dev.meta.ai/docs/api-reference/chat-completions).
