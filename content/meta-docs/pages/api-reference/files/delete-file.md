# Delete a file {#delete-a-file}

Delete a previously uploaded file by its ID.

## DELETE /files/{file\_id} {#delete-filesfile_id}

Delete an uploaded file.

### Parameters {#parameters}

#### Path parameters {#path-parameters}

| Field     | Type   | Required | Description                       |
| --------- | ------ | -------- | --------------------------------- |
| `file_id` | string | Yes      | Identifier of the file to act on. |

### Response {#response}

`HTTP 200` — OK

#### Content Type: application/json {#content-type-applicationjson}

[`DeleteFileResponse`](https://dev.meta.ai/docs/api-reference/files/schemas#delete-file-response)

**Python (OpenAI SDK)**

```python
import os

from openai import OpenAI

client = OpenAI(
    base_url="https://api.meta.ai/v1",
    api_key=os.environ["MODEL_API_KEY"],
)

response = client.files.delete("file_abc123")

print(response.model_dump_json(indent=2))
```

**Python (requests)**

```python
import json
import os

import requests

response = requests.delete(
    "https://api.meta.ai/v1/files/file_abc123",
    headers={"Authorization": f"Bearer {os.environ['MODEL_API_KEY']}"},
)
response.raise_for_status()
print(json.dumps(response.json(), indent=2))
```

**curl**

```shell
curl -X DELETE "https://api.meta.ai/v1/files/file_abc123" \
  -H "Authorization: Bearer $MODEL_API_KEY"
```

For supported file types and how to reference files in requests, see the [Files](https://dev.meta.ai/docs/file-handling) feature page.
