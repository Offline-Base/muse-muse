# Count input tokens {#count-input-tokens}

Count the tokens in the fully rendered input for a Responses request, without generating or storing a response. The count includes resolved `previous_response_id` history, current instructions and tools, media, and server-injected prompt scaffolding. Conversation resources are not supported.

## POST /responses/input\_tokens {#post-responsesinput_tokens}

Count tokens in the fully rendered input for a Responses request without generating or storing a response.

### Request body {#request-body}

#### Content Type: application/json {#content-type-applicationjson}

[`TokenCountsBody`](https://dev.meta.ai/docs/api-reference/responses/schemas#token-counts-body)

### Response {#response}

`HTTP 200` — Success

#### Content Type: application/json {#content-type-applicationjson-1}

[`TokenCountsResource`](https://dev.meta.ai/docs/api-reference/responses/schemas#token-counts-resource)

**Python (requests)**

```python
import json
import os

import requests

response = requests.post(
    "https://api.meta.ai/v1/responses/input_tokens",
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
curl -X POST "https://api.meta.ai/v1/responses/input_tokens" \
  -H "Authorization: Bearer $MODEL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "model": "muse-spark-1.3",
  "input": "What is the capital of France?"
}'
```

For usage examples and rate-limit guidance, see the [Responses](https://dev.meta.ai/docs/protocols/responses) feature page.
