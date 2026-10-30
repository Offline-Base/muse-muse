# Upload a file {#upload-a-file}

Upload a file for use in inference requests.

## POST /files {#post-files}

Upload a file for batch or user-data use.

### Request body {#request-body}

#### Content Type: multipart/form-data {#content-type-multipartform-data}

[`CreateFileRequest`](https://dev.meta.ai/docs/api-reference/files/schemas#create-file-request)

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

with open("/path/to/image.png", "rb") as f:
    file = client.files.create(
        purpose="user_data",
        file=f,
    )

print(file.model_dump_json(indent=2))
```

**Python (requests)**

```python
import json
import os

import requests

with open("/path/to/image.png", "rb") as f:
    response = requests.post(
        "https://api.meta.ai/v1/files",
        headers={"Authorization": f"Bearer {os.environ['MODEL_API_KEY']}"},
        data={
            "purpose": "user_data",
        },
        files={"file": f},
    )
response.raise_for_status()
print(json.dumps(response.json(), indent=2))
```

**curl**

```shell
curl -X POST "https://api.meta.ai/v1/files" \
  -H "Authorization: Bearer $MODEL_API_KEY" \
  -F "purpose=user_data" \
  -F "file=@/path/to/image.png"
```

For supported file types, upload examples, and how to reference files in requests, see the [Files](https://dev.meta.ai/docs/file-handling) feature page.
