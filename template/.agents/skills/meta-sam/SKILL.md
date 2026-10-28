---
name: meta-sam
description: Use to find, outline, count, measure or track objects in a photo or video with SAM 3.1 (sam-3.1), and to draw masks and boxes over them.
---

# SAM 3.1

All calls run on the server. Parse and draw results with Meta's client libraries, which are already installed.

## Photo with a text concept

This mirrors Meta's own example.

```ts
import { metaClient } from "@/lib/meta/client";
import { imagePart } from "@/lib/meta/parts";
import { parseImageStream, recordsOfKind, decodeMaskToSVGPath } from "@meta-sam/parser";

const meta = metaClient(request); // the route handler's incoming request
const events = await meta.responses.create({
  model: "sam-3.1",
  input: [
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "wall" },
        imagePart(photoUrlOrDataUrl),
      ],
    },
  ],
  stream: true,
  metadata: { mask_encoding: "one_bit", include_confidence: "true" },
});

const result = await parseImageStream(events).finalResult;
if (result.outcome.status !== "completed") throw new Error("Segmentation ended early");
const masks = recordsOfKind(result.records, "mask"); // one per instance; boxes via recordsOfKind(result.records, "box")
const count = masks.length;
```

### What comes back

- Always pass `stream: true`. The stream is standard Responses SSE (`response.created`, `response.output_text.delta`, `response.output_text.done`, `response.completed`). The OpenAI SDK's stream goes straight into `parseImageStream` or `parseVideoStream`.
- The result is packed into the output text as tokens, like `<0f>0<|box;x1=510;y1=265;x2=674;y2=408;w=800;h=600;c=0.96|><|mask;...|>,1<|box;...`. Never parse that by hand. Each record has `objectId`, `bounds` and, with `include_confidence`, `confidence` (0 to 1).
- `response.completed` carries `usage: { images_processed: 1, input_tokens: 0, output_tokens: 0 }`. SAM is billed per image or video frame processed, not by tokens.
- If you need the stream for something else too, collect the events into an array first, then parse from it.

### Prompt rules

- Use one short noun phrase per call, like "wall", "yellow school bus" or "dog".
- Lists don't work, and "cats, dogs" returns nothing. Commands, questions and negation don't work either.
- For several things, make one call per concept and run them in parallel.
- Photos return every matching instance.

## Boxes and points (when the user taps or drags)

- Build prompts with `buildObjectPrompt` from `@meta-sam/parser` instead of writing tokens by hand.
- A box token looks like `<|box;x1=444;y1=626;x2=675;y2=849;w=1800;h=1200|>`, with `x2` and `y2` inclusive. A point looks like `<|point;x=..;y=..;w=..;h=..|>`, and a leading `-` marks a negative point. Photos use the frame marker `<0f>`.
- `w` and `h` must be the pixel size of the media you sent. A different aspect ratio returns 400.
- You can prompt at most 16 objects.

## Video

1. In the browser, upload the clip with `uploadMedia` (product-ui skill). Function bodies can't carry video.
2. On the server, send a concept and `videoPart({ url })` from `@/lib/meta/parts`. Meta downloads public https URLs itself. If that fails with `media_url_origin_error`, upload the bytes with `meta.files.create` and use `videoPart({ fileId })`.
3. Stream the results and parse them with `parseVideoStream`. Each frame comes back on its own line. With concept prompts, frames arrive in order. With box or point prompts they can arrive out of order, so use `frameIndexOf` rather than arrival order.

```ts
import { videoPart } from "@/lib/meta/parts";
import { parseVideoStream } from "@meta-sam/parser";

const events = await meta.responses.create({
  model: "sam-3.1",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "bird" }, videoPart({ url: clipUrl })] }],
  stream: true,
} as any); // the OpenAI SDK types don't include input_video
const video = parseVideoStream(events as any);
```

Video limits:

| Limit | Value |
|---|---|
| Containers | MP4 or MOV |
| Codecs | H.264, H.265 or MPEG-4. VP9 and WebM are rejected, so don't record with MediaRecorder |
| Length | Up to 15,000 frames, about 10 minutes |
| Objects | Up to 16 tracked per frame |
| Cost | Billed per frame, with a 50-frame minimum. Keep demo clips to 5 to 20 seconds |

For box and point prompts, `metadata.propagation_direction` can be `both` (the default), `forward` or `backward`.

## Drawing results

- `SegmentationRenderer` from `@meta-sam/graphics` draws masks and boxes on a canvas. Its default colors aren't the theme's: pass an `objectColor` option that maps each object to one of `--cherry`, `--grape`, `--lemon`, `--lime`, `--pink` and `--teal`. A canvas can't read `var()`, so read each once with `getComputedStyle(document.documentElement).getPropertyValue("--teal").trim()`. Leave `boxLabels` off: it prints object ids and confidence decimals. Say the result in a caption instead ("Found 3 birds").
- `@meta-sam/video` and `@meta-sam/react` (`Video`, `useMediaPlayer`) give frame-accurate playback under overlays.
- `decodeMaskToSVGPath` works well for SVG overlays. `decodeMaskToRaster` returns a row-major 0/1 `Uint8Array` for pixel math. `decodeMaskToRLE` returns COCO RLE.

## Counting and measuring

- **Count.** In a photo, count mask records for the concept. In a video, count distinct object ids across frames.
- **Size.** Size needs a reference object of known size in the same photo. A sheet of US letter paper is 8.5 by 11 inches. Segment the reference, get pixels per inch from its box, then measure the target. Label the result as an estimate in the UI.

## Errors

| Status | Meaning |
|---|---|
| 400 | Invalid prompt or metadata. The message names the problem. Fix it before retrying |
| 400 `media_url_origin_error` | Meta couldn't download your media URL. Send a data URL (photos) or a file id instead |
| 404 `model_not_found` | Wrong model id, or this product isn't allowed to use SAM |

An empty result is not an error: zero masks means SAM found nothing for that phrase. Say so in the UI ("No birds found. Try a closer photo.").
