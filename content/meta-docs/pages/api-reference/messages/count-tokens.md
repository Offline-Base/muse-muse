# Count tokens {#count-tokens}

Count the number of input tokens an Anthropic-format Messages request would consume, without generating a message.

## POST /messages/count\_tokens {#post-messagescount_tokens}

Count input tokens for an Anthropic-compatible Messages request.

### Parameters {#parameters}

#### Header parameters {#header-parameters}

| Field               | Type   | Required | Description                                                                      |
| ------------------- | ------ | -------- | -------------------------------------------------------------------------------- |
| `anthropic-version` | string | No       | Anthropic API version header. Accepted for SDK compatibility.                    |
| `x-api-key`         | string | No       | API key header used by Anthropic SDKs. `Authorization: Bearer` is also accepted. |

### Request body {#request-body}

#### Content Type: application/json {#content-type-applicationjson}

[`AnthropicCountTokensRequest`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-count-tokens-request)

### Response {#response}

`HTTP 200` — Success

#### Content Type: application/json {#content-type-applicationjson-1}

[`AnthropicCountTokensResponse`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-count-tokens-response)

**Python (Anthropic SDK)**

```python
import os

from anthropic import Anthropic

client = Anthropic(
    base_url="https://api.meta.ai",
    auth_token=os.environ["MODEL_API_KEY"],
)

message = client.messages.count_tokens(
    model="muse-spark-1.3",
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
    "https://api.meta.ai/v1/messages/count_tokens",
    headers={
        "Authorization": f"Bearer {os.environ['MODEL_API_KEY']}",
        "Content-Type": "application/json",
    },
    json={
        "model": "muse-spark-1.3",
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
curl -X POST "https://api.meta.ai/v1/messages/count_tokens" \
  -H "Authorization: Bearer $MODEL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "model": "muse-spark-1.3",
  "messages": [
    {
      "role": "user",
      "content": "What is the capital of France?"
    }
  ]
}'
```

For usage examples and rate-limit guidance that applies to the shared inference pipeline, see the [Responses](https://dev.meta.ai/docs/protocols/responses) feature page.
