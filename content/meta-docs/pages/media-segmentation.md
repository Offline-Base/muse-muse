# Media segmentation {#media-segmentation}

Find and cut out objects in images and video from a short text prompt. Name an object such as "yellow school bus", and get back the exact pixels for every match: a box that locates each object, and a mask you can measure, crop, or composite.

[Segment Anything Model 3.1 (SAM 3.1)](https://dev.meta.ai/docs/sam/overview) powers media segmentation on Meta Model API. One model, `sam-3.1`, segments both stills and clips over the [Responses API](https://dev.meta.ai/docs/protocols/responses), so one integration covers images and video. In video, SAM 3.1 follows each match across frames, so you can track an object through a clip.

## When to use it {#when-to-use}

Use media segmentation when you need the pixel region of an object: it returns geometry — boxes and pixel-accurate masks. For a caption, an answer about a scene, or coordinates as text, use a [Muse Spark](https://dev.meta.ai/docs/models#muse-spark) model (a VLM) through [image understanding](https://dev.meta.ai/docs/image-understanding) or [video understanding](https://dev.meta.ai/docs/video-understanding). The two pair well: let Muse Spark interpret a scene and decide what to segment, then hand the concept to SAM 3.1 for the masks.

Prompt with a short noun phrase that names one concrete object, such as "delivery van" or "glasses". To segment several object types, send several requests. When you already know where an object is, from a user's click or an earlier box, mark it with [box and point prompts](https://dev.meta.ai/docs/sam/segmenting#object-prompts) instead.

## What you can build {#use-cases}

- **Image editing**: mask an object to remove, blur, or replace its background.
- **Measurement and analytics**: measure area, count instances, or pull regions out of photos, scans, or charts.
- **Video tracking**: follow an object across frames to build highlight, redaction, or effects features.

## Segment an image {#segment-an-image}

Name an object and send an image over the [Responses API](https://dev.meta.ai/docs/protocols/responses). SAM 3.1 streams back a box and a mask for every match:

**Python (OpenAI SDK)**

```python
import os

from openai import OpenAI

client = OpenAI(
    base_url="https://api.meta.ai/v1",
    api_key=os.environ["MODEL_API_KEY"],
)

with client.responses.stream(
    model="sam-3.1",
    input=[
        {
            "type": "message",
            "role": "user",
            "content": [
                {
                    "type": "input_text",
                    "text": "glasses",
                },
                {
                    "type": "input_image",
                    "image_url": "https://example.com/photo.png",
                },
            ],
        },
    ],
) as stream:
    for event in stream:
        if event.type == "response.output_text.delta":
            print(event.delta, end="", flush=True)
print()
```

**TypeScript (OpenAI SDK)**

```typescript
import OpenAI from 'openai';

const apiKey = process.env.MODEL_API_KEY;
if (!apiKey) {
  throw new Error('MODEL_API_KEY is not set');
}

const client = new OpenAI({
  baseURL: 'https://api.meta.ai/v1',
  apiKey,
});

const stream = client.responses.stream({
  model: 'sam-3.1',
  input: [
    {
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: 'glasses',
        },
        {
          type: 'input_image',
          image_url: 'https://example.com/photo.png',
        },
      ],
    },
  ],
});

for await (const event of stream) {
  if (event.type === 'response.output_text.delta') {
    process.stdout.write(event.delta);
  }
}
process.stdout.write('\n');
```

**Python (requests)**

```python
import json
import os

import requests

response = requests.post(
    "https://api.meta.ai/v1/responses",
    headers={
        "Authorization": f"Bearer {os.environ['MODEL_API_KEY']}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    },
    json={
        "model": "sam-3.1",
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": "glasses",
                    },
                    {
                        "type": "input_image",
                        "image_url": "https://example.com/photo.png",
                    },
                ],
            },
        ],
        "stream": True,
    },
    stream=True,
)
response.raise_for_status()

for raw_line in response.iter_lines(decode_unicode=False):
    if not raw_line:
        continue
    line = raw_line.decode("utf-8", errors="replace")
    if not line.startswith("data: "):
        continue
    data = line.removeprefix("data: ")
    if data == "[DONE]":
        break
    event = json.loads(data)
    if event.get("type") == "response.output_text.delta":
        delta = event.get("delta")
        if delta:
            print(delta, end="", flush=True)
print()
```

**curl**

```shell
curl -N -X POST "https://api.meta.ai/v1/responses" \
  -H "Authorization: Bearer $MODEL_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{
  "model": "sam-3.1",
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": [
        {
          "type": "input_text",
          "text": "glasses"
        },
        {
          "type": "input_image",
          "image_url": "https://example.com/photo.png"
        }
      ]
    }
  ],
  "stream": true
}'
```

The response is special-token text: one box and one mask per match. See the [SAM overview](https://dev.meta.ai/docs/sam/overview) for the request and response in full, and [reading segmentation output](https://dev.meta.ai/docs/sam/reading-segmentation) to parse it into geometry.

## Next steps {#next-steps}

The [SAM section](https://dev.meta.ai/docs/sam/overview) documents the model end to end:

- [Overview](https://dev.meta.ai/docs/sam/overview): what SAM 3.1 segments, with a first end-to-end call.
- [Segmenting with prompts](https://dev.meta.ai/docs/sam/segmenting): prompt with a noun phrase or with boxes and points, choose a tracking direction, and request confidence values.
- [Reading segmentation output](https://dev.meta.ai/docs/sam/reading-segmentation): parse the boxes and masks, and follow objects across frames.
- [Use the client libraries](https://dev.meta.ai/docs/sam/client-libraries): parse streams, decode masks, and render overlays.
