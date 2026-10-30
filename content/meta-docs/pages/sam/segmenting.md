# Segmenting with prompts {#segmenting-with-prompts}

Segment Anything Model 3.1 (SAM 3.1) segments by concept or by location. Give it a short noun phrase naming one thing — `"yellow school bus"`, `"glasses"`, `"red hat"` — and it returns a box and a mask for every match. Or mark specific objects with boxes and points, and it segments those objects and follows them through a video.

A request names what to segment in its `input_text` part in one of two ways, never both:

- **A concept prompt**: a short noun phrase. SAM 3.1 detects every instance of the concept. See [Write the concept prompt](https://dev.meta.ai/docs/sam/segmenting#prompting).
- **Box and point prompts**: a box or points on each object you want, under an object id you choose. SAM 3.1 segments those objects and reports each one under your id. See [Prompt with boxes and points](https://dev.meta.ai/docs/sam/segmenting#object-prompts).

One [Responses API](https://dev.meta.ai/docs/protocols/responses) call on `sam-3.1` carries the prompt and the media, an image or a video, and streams a box and a mask per object. The prompt is the part that decides what you get back, so start there.

## Write the concept prompt {#prompting}

The prompt goes in an `input_text` part as a short noun phrase. SAM 3.1 matches the concept you name, so concrete wording controls the result.

- **Name one concept with a noun phrase**: `"yellow school bus"`, `"red hat"`, or `"glasses"`. Commands (`"segment the bus"`) and questions (`"where is the bus?"`) are unreliable and often return nothing. Name the object; don't instruct the model.
- **One concept per request**: there is no multi-concept syntax. Comma, semicolon, and plus lists (`"bus, bicycle"`) return zero matches; an `"and"`, a newline, or a second `input_text` part segments only one of the concepts. To segment several concepts, send one request each.
- **Add attributes to narrow**: `"square"` matches every square; `"red square"` matches only the red ones. Color, type, and other concrete attributes filter predictably, down to zero when nothing matches.
- **Formatting is ignored**: plurals (`"red squares"`), case, trailing punctuation, and extra whitespace don't change what the prompt matches. Styling carries no meaning.
- **Skip negation, boolean OR, and spatial phrasing**: `"person not wearing a hat"` and `"cat or dog"` return inconsistent results, and `"person on the left"` is only partially honored. Segment the plain concept, then filter by position or attribute in your app using the returned box coordinates.
- **Keep it short**: a concise noun phrase works as well as a long description. Extra words give no benefit, and padding a prompt with filler degrades matching.

SAM 3.1 locates the objects you name; it doesn't answer questions or reason about a scene. For scene understanding, use the [Muse Spark](https://dev.meta.ai/docs/models#muse-spark) model line, or a combination: use Muse Spark to caption, answer questions, or identify scene activity via [image understanding](https://dev.meta.ai/docs/image-understanding) or [video understanding](https://dev.meta.ai/docs/video-understanding), then pass the concept to SAM 3.1 for the segmentation work.

Attributes change the match set predictably. On an image of six squares, `"square"` returns six matches, `"red square"` returns three, and `"yellow square"` returns none. Each match comes back as one box and one mask; see [Segment an image](https://dev.meta.ai/docs/sam/segmenting#segment-an-image) for the wire records and [read segmentation output](https://dev.meta.ai/docs/sam/reading-segmentation) to parse them.

A concept that isn't present returns zero matches: the stream completes with `response.completed` and an empty `output_text`. Treat it as a normal result, not an error.

## Prompt with boxes and points {#object-prompts}

Use box and point prompts when you already know where an object is: a user clicked it, another model found it, or an earlier response returned its box. You give each object an id, and the response reports the object under that id.

The prompt goes in the same `input_text` part, written in the same token grammar as the [segmentation output](https://dev.meta.ai/docs/sam/reading-segmentation). This prompt names two objects on an 1800×1200 image:

```text
<0f>1<|box;x1=444;y1=626;x2=675;y2=849;w=1800;h=1200|>,2<|point;x=1430;y=700;w=1800;h=1200|>-<|point;x=1300;y=450;w=1800;h=1200|>
```

Object 1 is marked with a box. Object 2 is marked with a point on the object and a negative point on a region that isn't part of it. The rules:

- **Frame marker**: `<Nf>` opens the prompts for source frame `N`, up to the next marker. An image uses `<0f>` only.
- **Objects**: after the marker come comma-separated objects, each an object id followed by one or more tokens. An id appears at most once per frame.
- **Box**: `<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..|>` marks the whole object. `x2` and `y2` are inclusive, as in output boxes. An object takes at most one box per frame.
- **Positive point**: `<|point;x=..;y=..;w=..;h=..|>` marks a pixel that is part of the object.
- **Negative point**: a `-` before a point marks a region that isn't part of the object. Only points can be negative.
- **Size**: every token carries the same `w` and `h`, the media's own pixel size. See [Convert coordinates to media pixels](https://dev.meta.ai/docs/sam/segmenting#coordinates).
- **One kind of prompt**: the text holds either a noun phrase or box and point prompts, never both. Don't send mask tokens as prompts.

To build this text in code instead of by hand, use `buildObjectPrompt` in TypeScript or `build_object_prompt` in Python. See [Build box and point prompts](https://dev.meta.ai/docs/sam/client-libraries#build-prompts).

Send the prompt with the image as in any other request:

```json
{
  "model": "sam-3.1",
  "input": [
    { "type": "message", "role": "user", "content": [
        { "type": "input_text", "text": "<0f>1<|box;x1=444;y1=626;x2=675;y2=849;w=1800;h=1200|>,2<|point;x=1430;y=700;w=1800;h=1200|>-<|point;x=1300;y=450;w=1800;h=1200|>" },
        { "type": "input_image", "image_url": "https://example.com/truck.jpg" }
    ]}
  ],
  "stream": true
}
```

The response carries one record per prompted object, under the ids from the request. Representative output, with object 2 and the mask payload elided:

```text
<0f>1<|box;x1=444;y1=625;x2=679;y2=850;w=1800;h=1200|><|mask;x=0;y=0;data=226,236,!...|>,2<|box;...|><|mask;...|>
```

### Convert coordinates to media pixels {#coordinates}

Set `w` and `h` to the media's width and height in pixels as displayed, after any rotation the file specifies, such as a photo's EXIF orientation or a video's rotation flag. These are the same `w` and `h` that the response reports. A video stored as 960×540 frames with a 90° rotation flag displays as 540×960, so its prompts use `w=540;h=960`.

> **WARNING: Scale coordinates before you send them**
>
> Send every coordinate in the media's own pixels, with `w` and `h` set to the media's size. Coordinates copied from a preview without conversion land in the wrong place, and a `w` and `h` whose aspect ratio differs from the media's return a `400`.

When a user draws on a preview, convert each coordinate before you build the prompt:

1. Subtract the position where the media starts in your view.
2. Multiply by the size of the media region shown, divided by its size on screen.
3. Add the position where that region starts in the media. Without a crop, the region is the whole media and starts at (0, 0).
4. Round down to whole pixels, and keep each coordinate inside the media.

A click at (100, 50) on a 640×360 preview of a 1920×1080 video gives x = 100 × 1920 / 640 = 300 and y = 50 × 1080 / 360 = 150, sent as `<|point;x=300;y=150;w=1920;h=1080|>`.

## Build the request {#build-the-request}

A request pairs the prompt with one media part inside a single user message. Send the prompt in an `input_text` part and the media in an `input_image` or `input_video` part:

- **`input_text`**: the prompt, either a short noun phrase for one concept (see [Write the concept prompt](https://dev.meta.ai/docs/sam/segmenting#prompting)) or box and point prompts (see [Prompt with boxes and points](https://dev.meta.ai/docs/sam/segmenting#object-prompts)).
- **`input_image`**: a still as `image_url`.
- **`input_video`**: a clip as `video_url`, or as `file_id` for a video uploaded through the [Files API](https://dev.meta.ai/docs/file-handling).
- **`image_url` / `video_url`**: a public URL or a base64 data URL (`data:image/png;base64,...`).

The same model serves both images and video. Swap the media part and keep the rest of the request identical. A concept prompt names one concept per request: to segment several object types, send one request each, or mark each object with box and point prompts in a single request.

## Segment an image {#segment-an-image}

Send an `input_image` part and stream the response to `response.completed`:

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

An image returns on a single line: one record per match, comma-separated, each record a box then a mask. Here `w` and `h` are the source image dimensions, repeated on every record:

```text
<0f>0<|box;x1=181;y1=365;x2=556;y2=486;w=1516;h=1600|><|mask;x=0;y=0;data=122,376,~...|>
```

`<0f>` is the frame, the leading integer is the object ordinal, then one box then one mask; `~` marks a lossless mask payload. Full grammar in [reading segmentation output](https://dev.meta.ai/docs/sam/reading-segmentation).

## Segment a video {#segment-a-video}

Swap in an `input_video` part with a `video_url`. Start with a hosted clip to tune the prompt before uploading anything:

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
                    "text": "red bicycle",
                },
                {
                    "type": "input_video",
                    "video_url": "https://example.com/clip.mp4",
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
          text: 'red bicycle',
        },
        {
          type: 'input_video',
          video_url: 'https://example.com/clip.mp4',
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
                        "text": "red bicycle",
                    },
                    {
                        "type": "input_video",
                        "video_url": "https://example.com/clip.mp4",
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
          "text": "red bicycle"
        },
        {
          "type": "input_video",
          "video_url": "https://example.com/clip.mp4"
        }
      ]
    }
  ],
  "stream": true
}'
```

A video returns one line per frame, each in its own `response.output_text.delta`. For a concept prompt, lines arrive in ascending frame order. Box and point prompts can return frames out of order (see [Choose a tracking direction](https://dev.meta.ai/docs/sam/segmenting#tracking-direction)), so always read the frame marker on each line. Frame 0 of a clip with two matches:

```text
<0f>0<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334|><|mask;x=0;y=0;data=27,60,~...|>,1<|box;x1=155;y1=228;x2=202;y2=254;w=320;h=334|><|mask;x=0;y=0;data=27,48,~...|>
```

## Upload once, reference by ID {#upload-once}

For a clip you segment more than once, upload it with `POST /v1/files` and set `purpose` to `user_data`. Upload is synchronous: a `200` means the file is ready to use in the next request.

**Python (OpenAI SDK)**

```python
import os

from openai import OpenAI

client = OpenAI(
    base_url="https://api.meta.ai/v1",
    api_key=os.environ["MODEL_API_KEY"],
)

with open("/path/to/clip.mp4", "rb") as f:
    file = client.files.create(
        purpose="user_data",
        file=f,
    )

print(file.model_dump_json(indent=2))
```

**TypeScript (OpenAI SDK)**

```typescript
import fs from 'fs';
import OpenAI from 'openai';

const apiKey = process.env.MODEL_API_KEY;
if (!apiKey) {
  throw new Error('MODEL_API_KEY is not set');
}

const client = new OpenAI({
  baseURL: 'https://api.meta.ai/v1',
  apiKey,
});

const file = await client.files.create({
  purpose: 'user_data',
  file: fs.createReadStream('/path/to/clip.mp4'),
});

console.log(JSON.stringify(file, null, 2));
```

**Python (requests)**

```python
import json
import os

import requests

with open("/path/to/clip.mp4", "rb") as f:
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
  -F "file=@/path/to/clip.mp4"
```

### Example upload response {#example-upload-response}

```json
{
  "id": "file-842549258569145",
  "object": "file",
  "bytes": 245832,
  "created_at": 1714502400,
  "filename": "clip.mp4",
  "purpose": "user_data",
  "status": "uploaded"
}
```

Pass the returned ID in the `file_id` field of the `input_video` part:

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
                    "text": "delivery van",
                },
                {
                    "type": "input_video",
                    "file_id": "file-abc123",
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
          text: 'delivery van',
        },
        {
          type: 'input_video',
          file_id: 'file-abc123',
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
                        "text": "delivery van",
                    },
                    {
                        "type": "input_video",
                        "file_id": "file-abc123",
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
          "text": "delivery van"
        },
        {
          "type": "input_video",
          "file_id": "file-abc123"
        }
      ]
    }
  ],
  "stream": true
}'
```

See [file handling](https://dev.meta.ai/docs/file-handling) for expiration, listing, and deletion.

**MP4 faststart.** An MP4 stores an index (the `moov` atom) that players read before they can decode or seek; for streaming, that index should sit at the front of the file ("faststart"). When you upload an MP4, the service checks for this, and if the index is at the end it remuxes the file losslessly — a stream copy, with no re-encoding — to move the index to the front. Frames and timestamps are unchanged, so boxes and masks map exactly onto your original video, and the remuxed file isn't returned.

> **TIP: Skip the remux**
>
> Export with faststart already enabled so your upload passes through unchanged: `ffmpeg -i input.mp4 -c copy -movflags +faststart output.mp4`.

## Prompt several video frames {#multi-frame}

In a video, box and point prompts can go on any frames. Each `<Nf>` marker opens the prompts for that frame. Repeat an object's id on a later frame to prompt the same object again; a new id starts a new object.

This request prompts two objects across four frames of a 200-frame, 960×540 clip. Object 1 gets a point on frame 30 and a box on frame 120. Object 2 gets a box on frame 75, then a positive and a negative point on frame 160:

```json
{
  "model": "sam-3.1",
  "input": [
    { "type": "message", "role": "user", "content": [
        { "type": "input_text", "text": "<30f>1<|point;x=585;y=366;w=960;h=540|><75f>2<|box;x1=405;y1=337;x2=516;y2=420;w=960;h=540|><120f>1<|box;x1=493;y1=320;x2=641;y2=444;w=960;h=540|><160f>2<|point;x=533;y=403;w=960;h=540|>-<|point;x=482;y=405;w=960;h=540|>" },
        { "type": "input_video", "file_id": "file-abc123" }
    ]}
  ],
  "stream": true,
  "metadata": { "propagation_direction": "forward" }
}
```

SAM 3.1 tracks both objects from frame 30, the earliest prompt frame, to the end of the clip: the response carries frames 30 through 199, with objects 1 and 2 on each frame where they're visible.

## Choose a tracking direction {#tracking-direction}

For box and point prompts in video, `metadata.propagation_direction` sets which frames SAM 3.1 tracks the prompted objects over. Each direction is measured from the earliest prompt frame:

| `propagation_direction` | Frames tracked                                                                                  | Prompts on frames 30 and 120 of a 200-frame clip |
| :---------------------- | :---------------------------------------------------------------------------------------------- | :----------------------------------------------- |
| `both` (default)        | From the earliest prompt frame to the last frame, then from the frame before it back to frame 0 | 30 to 199, then 29 to 0                          |
| `forward`               | From the earliest prompt frame to the last frame                                                | 30 to 199                                        |
| `backward`              | From the earliest prompt frame back to frame 0                                                  | 30 to 0                                          |

Omit the key for `both`. `backward` needs a prompt on a frame after frame 0. Tracking fewer frames costs less: video is [billed per frame](https://dev.meta.ai/docs/pricing-rate-limits#sam-pricing), with a minimum of 50 frames per request. With `both`, the frames before the earliest prompt arrive last, in descending order, so key your results by the frame marker rather than by line position (see [frame markers](https://dev.meta.ai/docs/sam/reading-segmentation#structure)).

## Stream the response {#stream}

Streaming is the recommended path for segmentation, especially for video: set `stream` to `true`, as the examples above do, and read the server-sent events to `response.completed`. Each frame arrives as its own `response.output_text.delta`, so partial progress renders while the rest of the clip is still segmenting.

Streaming is not required. A non-streaming request (`stream` omitted or `false`) runs the same segmentation and returns the complete result in one response, in the same format. Results can vary slightly between runs of the same request, streamed or not: box coordinates, mask edges, and occasionally which objects are found on a frame. Prefer streaming for long clips so frames render as they arrive instead of waiting for the whole response.

## Request confidence {#confidence}

Set `metadata.include_confidence` to `"true"` to get the model's confidence for each record. Metadata values are strings, so send `"true"` rather than a JSON boolean:

```json
{
  "model": "sam-3.1",
  "input": [
    { "type": "message", "role": "user", "content": [
        { "type": "input_text",  "text": "glasses" },
        { "type": "input_image", "image_url": "https://example.com/photo.png" }
    ]}
  ],
  "stream": true,
  "metadata": { "include_confidence": "true" }
}
```

Every box and every mask then carries a `c` field, a number from 0 through 1, on every frame. It works with concept prompts and with box and point prompts, in every tracking direction. The box and the mask of one record carry the same value, and the same object can carry a different value on each frame. One record with confidence, mask payload elided:

```text
<0f>1<|box;x1=444;y1=625;x2=679;y2=850;w=1800;h=1200;c=0.9609375|><|mask;x=0;y=0;c=0.9609375;data=226,236,!...|>
```

Omit the key, or send `"false"`, for output without `c`. The field's place in each token is in [read segmentation output](https://dev.meta.ai/docs/sam/reading-segmentation#record-layout).

> **WARNING: Upgrade the parser before you opt in**
>
> Use `@meta-sam/parser` 0.0.13 or later, or `meta-sam-parser` 0.0.6 or later, to read responses that carry `c`. Earlier versions return no records for those responses. See [client libraries](https://dev.meta.ai/docs/sam/client-libraries#confidence).

## Choose a mask encoding {#mask-encoding}

Masks arrive in the `lossless` encoding by default. Set the top-level `metadata.mask_encoding` field to switch:

- Omit `metadata`, or send `"mask_encoding": "lossless"`: default `lossless` masks (the `~` marker on the wire).
- Send `"mask_encoding": "one_bit"`: compact `one_bit` masks (the `!` marker). The payload is several times smaller than `lossless`, so masks stream faster and use less bandwidth — worth choosing for video or many-object results.

```jsonc
{
  "model": "sam-3.1",
  "input": [
    { "type": "message", "role": "user", "content": [
        { "type": "input_text",  "text": "yellow school bus" },
        { "type": "input_image", "image_url": "https://example.com/street.png" }
    ]}
  ],
  "stream": true,
  "metadata": { "mask_encoding": "one_bit" }
}
```

Box and point prompts always return `one_bit` masks, whatever `mask_encoding` is set to. Read the marker on each mask rather than assuming the encoding you requested.

`decodeMaskToRaster` turns a mask into a binary raster, so request `one_bit` for the smallest payloads when you decode with the client library. See [read segmentation output](https://dev.meta.ai/docs/sam/reading-segmentation) for the encoding markers and how to decode a mask.

## Limits {#limits}

- **Formats**: MP4 or MOV containers with H.264, H.265, or MPEG-4 video. VP9 and WebM are not accepted.
- **Clip length**: up to 15,000 frames (about 10 minutes) per request.
- **Objects**: image requests return every matching instance. Video tracks up to 16 objects per frame.
- **Prompted objects**: box and point prompts name up to 16 objects.

## Handle errors {#handle-errors}

A prompt or metadata value that breaks the rules above returns `400`, with a message that names the problem and quotes the values from your request:

| Request                                                        | Message                                                                                                |
| :------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------- |
| A noun phrase together with box and point prompts              | `invalid prompt: object prompts cannot be combined with a phrase`                                      |
| A negative box                                                 | `invalid prompt: a box names the object; it cannot be negative`                                        |
| Two boxes for one object on one frame                          | `invalid prompt: object 1 carries more than one box`                                                   |
| The same object id twice on one frame                          | `invalid prompt: object id 1 is used more than once on frame 0`                                        |
| Tokens with different `w` and `h`                              | `invalid prompt: every prompt token must declare the same w/h; got 900x600, 1800x1200`                 |
| A point outside the media                                      | `invalid prompt: point (1900.0, 100.0) lies outside the 1800x1200 frame`                               |
| An image prompt on a frame other than 0                        | `an image prompt must be on frame 0, got <5f>`                                                         |
| More than 16 prompted objects                                  | `invalid prompt: 17 objects exceed this model's limit of 16`                                           |
| An `include_confidence` value other than `"true"` or `"false"` | `metadata["include_confidence"] must be "true" or "false"`                                             |
| An unknown `propagation_direction`                             | `metadata["propagation_direction"] must be one of ['both', 'forward', 'backward']`                     |
| `backward` with the earliest prompt on frame 0                 | `backward propagation needs an object prompt on a frame after the first`                               |
| `w` and `h` with a different aspect ratio from the media       | `prompt coordinates are given in a 960x600 frame, whose aspect ratio does not match the 960x540 media` |

**Fix:** correct the prompt or the metadata value and resend. A `400` is permanent for that request, so don't retry it unchanged.

An unknown or inaccessible model returns `404`. A team without model access gets the same envelope, carrying `code: model_not_found`:

```json
{
  "error": {
    "code": "model_not_found",
    "message": "The requested model was not found.",
    "param": null,
    "type": "invalid_request_error"
  }
}
```

**Fix:** verify the model ID and confirm your account has access. See [error handling](https://dev.meta.ai/docs/error-handling#404).

## Next steps {#next-steps}

With a working prompt and request, handle what comes back:

- Parse boxes and masks with [read segmentation output](https://dev.meta.ai/docs/sam/reading-segmentation).
- Render overlays and play segmented video with the [client libraries](https://dev.meta.ai/docs/sam/client-libraries).
- Place this call in the full workflow with the [SAM overview](https://dev.meta.ai/docs/sam/overview).
