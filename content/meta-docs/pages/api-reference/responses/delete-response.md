# Delete a response {#delete-a-response}

Delete a previously created response by its ID.

## DELETE /responses/{response\_id} {#delete-responsesresponse_id}

Delete a stored model response by ID.

### Parameters {#parameters}

#### Path parameters {#path-parameters}

| Field         | Type   | Required | Description                       |
| ------------- | ------ | -------- | --------------------------------- |
| `response_id` | string | Yes      | The ID of the response to delete. |

### Response {#response}

`HTTP 200` — OK

#### Content Type: application/json {#content-type-applicationjson}

[`DeleteResponseResponse`](https://dev.meta.ai/docs/api-reference/responses/schemas#delete-response-response)

**Python (OpenAI SDK)**

```python
import os

from openai import OpenAI

client = OpenAI(
    base_url="https://api.meta.ai/v1",
    api_key=os.environ["MODEL_API_KEY"],
)

response = client.responses.delete("resp_abc123")

print(response.model_dump_json(indent=2))
```

**Python (requests)**

```python
import json
import os

import requests

response = requests.delete(
    "https://api.meta.ai/v1/responses/resp_abc123",
    headers={"Authorization": f"Bearer {os.environ['MODEL_API_KEY']}"},
)
response.raise_for_status()
print(json.dumps(response.json(), indent=2))
```

**curl**

```shell
curl -X DELETE "https://api.meta.ai/v1/responses/resp_abc123" \
  -H "Authorization: Bearer $MODEL_API_KEY"
```

For usage examples and guidance on managing server-side conversation state, see the [Responses](https://dev.meta.ai/docs/protocols/responses) feature page.
