# Retrieve a file {#retrieve-a-file}

Retrieve metadata for a previously uploaded file by its ID.

## GET /files/{file\_id} {#get-filesfile_id}

Retrieve metadata for an uploaded file.

### Parameters {#parameters}

#### Path parameters {#path-parameters}

| Field     | Type   | Required | Description                       |
| --------- | ------ | -------- | --------------------------------- |
| `file_id` | string | Yes      | Identifier of the file to act on. |

### Response {#response}

`HTTP 200` — OK

#### Content Type: application/json {#content-type-applicationjson}

[`FileObject`](https://dev.meta.ai/docs/api-reference/files/schemas#file-object)

**Python (OpenAI SDK)**

```python
import os

from openai import OpenAI

client = OpenAI(
    base_url="https://api.meta.ai/v1",
    api_key=os.environ["MODEL_API_KEY"],
)

response = client.files.retrieve("file_abc123")

print(response.model_dump_json(indent=2))
```

**Python (requests)**

```python
import json
import os

import requests

response = requests.get(
    "https://api.meta.ai/v1/files/file_abc123",
    headers={"Authorization": f"Bearer {os.environ['MODEL_API_KEY']}"},
)
response.raise_for_status()
print(json.dumps(response.json(), indent=2))
```

**curl**

```shell
curl -X GET "https://api.meta.ai/v1/files/file_abc123" \
  -H "Authorization: Bearer $MODEL_API_KEY"
```

To download the file's contents, see [Retrieve file content](https://dev.meta.ai/docs/api-reference/files/retrieve-file-content).
