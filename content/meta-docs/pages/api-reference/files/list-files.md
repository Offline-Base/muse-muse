# List files {#list-files}

List previously uploaded files.

## GET /files {#get-files}

List uploaded files.

### Parameters {#parameters}

#### Query parameters {#query-parameters}

| Field     | Type                 | Required | Description                                                                                                                                                                                                |
| --------- | -------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `purpose` | string               | No       | Return only files with this purpose.                                                                                                                                                                       |
| `limit`   | integer              | No       | Maximum number of files to return, from 1 to 10,000. Defaults to 10,000.                                                                                                                                   |
| `order`   | enum ('asc', 'desc') | No       | Sort direction: `asc` for oldest first, `desc` for newest first. Files are ordered by when each was added, which can differ from `created_at`, so neighboring `created_at` values are not always in order. |
| `after`   | string               | No       | A cursor for use in pagination. `after` is a file ID that defines your place in the list.                                                                                                                  |

### Response {#response}

`HTTP 200` — OK

#### Content Type: application/json {#content-type-applicationjson}

[`ListFilesResponse`](https://dev.meta.ai/docs/api-reference/files/schemas#list-files-response)

**Python (OpenAI SDK)**

```python
import os

from openai import OpenAI

client = OpenAI(
    base_url="https://api.meta.ai/v1",
    api_key=os.environ["MODEL_API_KEY"],
)

response = client.files.list()

print(response.model_dump_json(indent=2))
```

**Python (requests)**

```python
import json
import os

import requests

response = requests.get(
    "https://api.meta.ai/v1/files",
    headers={"Authorization": f"Bearer {os.environ['MODEL_API_KEY']}"},
)
response.raise_for_status()
print(json.dumps(response.json(), indent=2))
```

**curl**

```shell
curl -X GET "https://api.meta.ai/v1/files" \
  -H "Authorization: Bearer $MODEL_API_KEY"
```

For supported file types and how to reference files in requests, see the [Files](https://dev.meta.ai/docs/file-handling) feature page.
