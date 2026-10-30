# Generate an image {#generate-an-image}

Generate one or more images from a text prompt.

## POST /images/generations {#post-imagesgenerations}

Generate one or more images from a text prompt.

### Request body {#request-body}

#### Content Type: application/json {#content-type-applicationjson}

[`CreateImageRequest`](https://dev.meta.ai/docs/api-reference/images/schemas#create-image-request)

### Response {#response}

`HTTP 200` — OK

#### Content Type: application/json {#content-type-applicationjson-1}

[`ImagesResponse`](https://dev.meta.ai/docs/api-reference/images/schemas#images-response)

#### Content Type: text/event-stream {#content-type-textevent-stream}

[`ImageGenStreamEvent`](https://dev.meta.ai/docs/api-reference/images/schemas#image-gen-stream-event)

**Python (OpenAI SDK)**

```python
import os

from openai import OpenAI

client = OpenAI(
    base_url="https://api.meta.ai/v1",
    api_key=os.environ["MODEL_API_KEY"],
)

response = client.images.generate(
    model="muse-image-1.0",
    prompt="a watercolor painting of a red fox sitting in a snowy pine forest, soft golden morning light",
    n=1,
)

print(response.model_dump_json(indent=2))
```

**Python (requests)**

```python
import json
import os

import requests

response = requests.post(
    "https://api.meta.ai/v1/images/generations",
    headers={
        "Authorization": f"Bearer {os.environ['MODEL_API_KEY']}",
        "Content-Type": "application/json",
    },
    json={
        "model": "muse-image-1.0",
        "prompt": "a watercolor painting of a red fox sitting in a snowy pine forest, soft golden morning light",
        "n": 1,
    },
)
response.raise_for_status()
print(json.dumps(response.json(), indent=2))
```

**curl**

```shell
curl -X POST "https://api.meta.ai/v1/images/generations" \
  -H "Authorization: Bearer $MODEL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "model": "muse-image-1.0",
  "prompt": "a watercolor painting of a red fox sitting in a snowy pine forest, soft golden morning light",
  "n": 1
}'
```

For prompts, sizing, and worked examples, see the [Image generation](https://dev.meta.ai/docs/image-generation) feature page.
