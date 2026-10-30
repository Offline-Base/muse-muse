# Create a message {#create-a-message}

Generate an Anthropic Messages-compatible assistant message. Requests are supplied in the Anthropic wire format and run through the same inference pipeline as the [Responses API](https://dev.meta.ai/docs/api-reference/responses). Supported tools are developer-defined (`custom`) functions and built-in `web_search`.

## POST /messages {#post-messages}

Generate an Anthropic-compatible assistant message.

### Parameters {#parameters}

#### Header parameters {#header-parameters}

| Field               | Type   | Required | Description                                                                      |
| ------------------- | ------ | -------- | -------------------------------------------------------------------------------- |
| `anthropic-version` | string | No       | Anthropic API version header. Accepted for SDK compatibility.                    |
| `x-api-key`         | string | No       | API key header used by Anthropic SDKs. `Authorization: Bearer` is also accepted. |

### Request body {#request-body}

#### Content Type: application/json {#content-type-applicationjson}

[`AnthropicMessageRequest`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-message-request)

### Response {#response}

`HTTP 200` — OK

#### Content Type: application/json {#content-type-applicationjson-1}

[`AnthropicMessage`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-message)

#### Content Type: text/event-stream {#content-type-textevent-stream}

[`AnthropicStreamEvent`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-stream-event)

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
    messages=[
        {
            "role": "user",
            "content": "What is the capital of France?",
        },
    ],
)

print(message.model_dump_json(indent=2))
```

**Python (requests)**

```python
import json
import os

import requests

response = requests.post(
    "https://api.meta.ai/v1/messages",
    headers={
        "Authorization": f"Bearer {os.environ['MODEL_API_KEY']}",
        "Content-Type": "application/json",
    },
    json={
        "model": "muse-spark-1.3",
        "max_tokens": 1024,
        "messages": [
            {
                "role": "user",
                "content": "What is the capital of France?",
            },
        ],
    },
)
response.raise_for_status()
print(json.dumps(response.json(), indent=2))
```

**curl**

```shell
curl -X POST "https://api.meta.ai/v1/messages" \
  -H "Authorization: Bearer $MODEL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "model": "muse-spark-1.3",
  "max_tokens": 1024,
  "messages": [
    {
      "role": "user",
      "content": "What is the capital of France?"
    }
  ]
}'
```

For reasoning replay, tool calling, and structured output guidance that applies to the shared inference pipeline, see the [Responses](https://dev.meta.ai/docs/protocols/responses) feature page.
