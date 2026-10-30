# Segmentation with Segment Anything Model {#segmentation-with-segment-anything-model}

Segment Anything Model (SAM) is Meta's segmentation model family, originally released as [open-weight research models](https://ai.meta.com/blog/segment-anything-model-3/). Its latest version, SAM 3.1, is now available on Meta Model API. Detect, segment, and follow any object in images or video. Send media and a short noun phrase such as "yellow school bus", and the model returns every match as a box and a mask. Or mark specific objects with boxes and points, and the model segments those objects and tracks them forward, backward, or both ways through a video. The box locates the object; the mask gives you the pixel region to measure or cut out.

One model handles both images and video, so you build measurement, editing, and tracking features on top of a single API. The `sam-3.1` model — the latest SAM version — segments stills and clips over `POST /v1/responses` on `https://api.meta.ai/v1`, using the same Bearer key as the rest of the API.

## Anatomy of a request {#anatomy-of-a-request}

Segmentation happens over the [Responses API](https://dev.meta.ai/docs/protocols/responses), the same OpenAI-compatible format supported by our [Muse Spark](https://dev.meta.ai/docs/models#muse-spark) model line. Send one user message: a short `input_text` phrase naming the object, plus one media part. Streaming is the recommended path for video: set `stream` to `true` and read the server-sent events through `response.completed` (see [segmenting with prompts](https://dev.meta.ai/docs/sam/segmenting#stream)), so each frame renders as it is segmented. Streaming is not required — a non-streaming request returns the complete result in a single response.

Write the prompt as a short noun phrase that names one object, such as "yellow school bus" or "red bicycle". Concrete nouns match best. Name one concept per request; to segment several object types, send several requests. To segment objects you've already located, send [box and point prompts](https://dev.meta.ai/docs/sam/segmenting#object-prompts) instead of a phrase. See [segmenting with prompts](https://dev.meta.ai/docs/sam/segmenting) for prompt tuning and the full request shape.

Attach an image with an `input_image` part or a clip with an `input_video` part. Video accepts MP4 and MOV containers encoded with H.264, H.265, or MPEG-4.

**TypeScript**

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://api.meta.ai/v1",
  apiKey: process.env.MODEL_API_KEY,
});

const stream = await client.responses.create({
  model: "sam-3.1",
  input: [
    { type: "message", role: "user", content: [
        { type: "input_text", text: "yellow school bus" },
        { type: "input_image", image_url: "https://example.com/street.png" },
    ]},
  ],
  stream: true,
});

let outputText = "";
for await (const event of stream) {
  if (event.type === "response.output_text.delta") {
    outputText += event.delta;
  }
}
console.log(outputText);
```

## Anatomy of a response {#anatomy-of-a-response}

The result streams back in the `output_text` lane (the text channel of the Responses stream) as special-token text: one line for an image, one line per frame for video. Each line carries a box and a mask for every object found. The stream terminates on `response.completed`, which delivers the final message.

Representative response for the call above, with mask payloads truncated:

```text
<0f>0<|box;x1=353;y1=382;x2=453;y2=427;w=537;h=561|><|mask;x=0;y=0;data=46,101,~...|>,1<|box;x1=260;y1=382;x2=340;y2=427;w=537;h=561|><|mask;x=0;y=0;data=46,81,~...|>
```

`<0f>` is the frame, the leading integer is the object ordinal, then one box then one mask; `~` marks a lossless mask payload. Full grammar in [reading segmentation output](https://dev.meta.ai/docs/sam/reading-segmentation).

The [`@meta-sam/parser`](https://dev.meta.ai/docs/sam/client-libraries) library turns this text into typed records, so you don't parse the grammar by hand. Pass the stream to `parseImageStream`, then decode each mask into a binary raster with `decodeMaskToRaster`:

**TypeScript**

```typescript
import OpenAI from "openai";
import { parseImageStream, recordsOfKind, decodeMaskToRaster } from "@meta-sam/parser";

const client = new OpenAI({
  baseURL: "https://api.meta.ai/v1",
  apiKey: process.env.MODEL_API_KEY,
});

const events = await client.responses.create({
  model: "sam-3.1",
  input: [
    { type: "message", role: "user", content: [
        { type: "input_text", text: "yellow school bus" },
        { type: "input_image", image_url: "https://example.com/street.png" },
    ]},
  ],
  stream: true,
  metadata: { mask_encoding: "one_bit" },
});

const result = await parseImageStream(events).finalResult;

for (const record of recordsOfKind(result.records, "mask")) {
  const raster = decodeMaskToRaster(record.mask); // Uint8Array of 0 or 1, length W * H
  console.log(raster.length);
}
```

Each box arrives in source pixels and each mask as a binary raster. For the grammar behind the wire format, see [read segmentation output](https://dev.meta.ai/docs/sam/reading-segmentation).

Each object keeps a stable identity across frames, so you follow an object through a clip. See [track objects across frames](https://dev.meta.ai/docs/sam/reading-segmentation#object-identity) for detail.

Zero matches is a valid outcome. When nothing matches the prompt, the stream completes with an empty `output_text`, so branch on it.

## Next steps {#next-steps}

- [Segmenting with prompts](https://dev.meta.ai/docs/sam/segmenting) to tune prompts, upload clips once, and switch mask encodings.
- [Read segmentation output](https://dev.meta.ai/docs/sam/reading-segmentation) to parse boxes and masks and follow objects across frames.
- [Use the client libraries](https://dev.meta.ai/docs/sam/client-libraries) to parse streams, decode masks, and render overlays.
