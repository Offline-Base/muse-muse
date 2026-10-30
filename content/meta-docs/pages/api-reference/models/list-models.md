# List models {#list-models}

List the models available through the Meta Model API.

## GET /models {#get-models}

List the available models.

### Parameters {#parameters}

#### Query parameters {#query-parameters}

| Field    | Type   | Required | Description                                  |
| -------- | ------ | -------- | -------------------------------------------- |
| `client` | string | No       | Optional client-specific model catalog view. |

### Response {#response}

`HTTP 200` — OK

#### Content Type: application/json {#content-type-applicationjson}

[`ListModelsResponse`](https://dev.meta.ai/docs/api-reference/models/schemas#list-models-response)

**Python (OpenAI SDK)**

```python
import os

from openai import OpenAI

client = OpenAI(
    base_url="https://api.meta.ai/v1",
    api_key=os.environ["MODEL_API_KEY"],
)

response = client.models.list()

print(response.model_dump_json(indent=2))
```

**Python (requests)**

```python
import json
import os

import requests

response = requests.get(
    "https://api.meta.ai/v1/models",
    headers={"Authorization": f"Bearer {os.environ['MODEL_API_KEY']}"},
)
response.raise_for_status()
print(json.dumps(response.json(), indent=2))
```

**curl**

```shell
curl -X GET "https://api.meta.ai/v1/models" \
  -H "Authorization: Bearer $MODEL_API_KEY"
```

For a catalog of available models, capabilities, and context windows, see the [Models](https://dev.meta.ai/docs/models) page.
