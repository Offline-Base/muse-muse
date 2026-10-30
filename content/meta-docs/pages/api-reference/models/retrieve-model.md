# Retrieve a model {#retrieve-a-model}

Retrieve metadata for a single model by its ID.

## GET /models/{model} {#get-modelsmodel}

Retrieve metadata for a model.

### Parameters {#parameters}

#### Path parameters {#path-parameters}

| Field   | Type   | Required | Description                      |
| ------- | ------ | -------- | -------------------------------- |
| `model` | string | Yes      | The ID of the model to retrieve. |

### Response {#response}

`HTTP 200` — OK

#### Content Type: application/json {#content-type-applicationjson}

[`Model`](https://dev.meta.ai/docs/api-reference/models/schemas#model)

**Python (OpenAI SDK)**

```python
import os

from openai import OpenAI

client = OpenAI(
    base_url="https://api.meta.ai/v1",
    api_key=os.environ["MODEL_API_KEY"],
)

response = client.models.retrieve("muse-spark-1.3")

print(response.model_dump_json(indent=2))
```

**Python (requests)**

```python
import json
import os

import requests

response = requests.get(
    "https://api.meta.ai/v1/models/muse-spark-1.3",
    headers={"Authorization": f"Bearer {os.environ['MODEL_API_KEY']}"},
)
response.raise_for_status()
print(json.dumps(response.json(), indent=2))
```

**curl**

```shell
curl -X GET "https://api.meta.ai/v1/models/muse-spark-1.3" \
  -H "Authorization: Bearer $MODEL_API_KEY"
```

For a catalog of available models, capabilities, and context windows, see the [Models](https://dev.meta.ai/docs/models) page.
