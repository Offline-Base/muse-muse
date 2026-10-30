# Create a response {#create-a-response}

Create a model response. Optionally reference a previous response by ID to continue a multi-turn conversation with server-managed state, instead of resending the full message history.

## POST /responses {#post-responses}

Generate a model response.

### Request body {#request-body}

#### Content Type: application/json {#content-type-applicationjson}

[`CreateResponse`](https://dev.meta.ai/docs/api-reference/responses/schemas#create-response)

### Response {#response}

`HTTP 200` — OK

#### Content Type: application/json {#content-type-applicationjson-1}

[`Response`](https://dev.meta.ai/docs/api-reference/responses/schemas#response)

#### Content Type: text/event-stream {#content-type-textevent-stream}

[`ResponseStreamWireEvent`](https://dev.meta.ai/docs/api-reference/responses/schemas#response-stream-wire-event)

**Python (OpenAI SDK)**

```python
import os

from openai import OpenAI

client = OpenAI(
    base_url="https://api.meta.ai/v1",
    api_key=os.environ["MODEL_API_KEY"],
)

response = client.responses.create(
    model="muse-spark-1.3",
    input="What is the capital of France?",
)

print(response.model_dump_json(indent=2))
```

**Python (requests)**

```python
import json
import os

import requests

response = requests.post(
    "https://api.meta.ai/v1/responses",
    headers={
        "Authorization": f"Bearer {os.environ['MODEL_API_KEY']}",
        "Content-Type": "application/json",
    },
    json={
        "model": "muse-spark-1.3",
        "input": "What is the capital of France?",
    },
)
response.raise_for_status()
print(json.dumps(response.json(), indent=2))
```

**curl**

```shell
curl -X POST "https://api.meta.ai/v1/responses" \
  -H "Authorization: Bearer $MODEL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "model": "muse-spark-1.3",
  "input": "What is the capital of France?"
}'
```

For usage examples, `previous_response_id` patterns, and guidance on when to use the Responses API versus Chat Completions, see the [Responses](https://dev.meta.ai/docs/protocols/responses) feature page.
