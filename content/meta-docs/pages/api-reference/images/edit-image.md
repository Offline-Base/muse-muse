# Edit an image {#edit-an-image}

Edit, transform, or compose one or more input images, guided by a text prompt.

With the OpenAI SDK, upload the input image(s) as `multipart/form-data` — `client.images.edit(image=..., prompt=..., model=...)`, passing a list of files to compose several inputs. Over raw HTTP you can instead send a JSON body with an `images` array of `image_url`/`file_id` items (shown below); the OpenAI SDK does not send this JSON shape.

## POST /images/edits {#post-imagesedits}

Edit one or more input images from a text prompt.

### Request body {#request-body}

#### Content Type: application/json {#content-type-applicationjson}

[`EditImageBodyJsonParam`](https://dev.meta.ai/docs/api-reference/images/schemas#edit-image-body-json-param)

#### Content Type: multipart/form-data {#content-type-multipartform-data}

[`CreateImageEditRequest`](https://dev.meta.ai/docs/api-reference/images/schemas#create-image-edit-request)

### Response {#response}

`HTTP 200` — OK

#### Content Type: application/json {#content-type-applicationjson-1}

[`ImagesResponse`](https://dev.meta.ai/docs/api-reference/images/schemas#images-response)

#### Content Type: text/event-stream {#content-type-textevent-stream}

[`ImageEditStreamEvent`](https://dev.meta.ai/docs/api-reference/images/schemas#image-edit-stream-event)

**Python (requests)**

```python
import json
import os

import requests

response = requests.post(
    "https://api.meta.ai/v1/images/edits",
    headers={
        "Authorization": f"Bearer {os.environ['MODEL_API_KEY']}",
        "Content-Type": "application/json",
    },
    json={
        "model": "muse-image-1.0",
        "prompt": "add a small red wool hat on the fox's head, keep the snowy forest background",
        "images": [
            {
                "image_url": "data:image/webp;base64,UklGR...",
            },
        ],
        "n": 1,
    },
)
response.raise_for_status()
print(json.dumps(response.json(), indent=2))
```

**curl**

```shell
curl -X POST "https://api.meta.ai/v1/images/edits" \
  -H "Authorization: Bearer $MODEL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "model": "muse-image-1.0",
  "prompt": "add a small red wool hat on the fox'\''s head, keep the snowy forest background",
  "images": [
    {
      "image_url": "data:image/webp;base64,UklGR..."
    }
  ],
  "n": 1
}'
```

For reference images, multi-image composition, and worked examples, see the [Image generation](https://dev.meta.ai/docs/image-generation) feature page.
