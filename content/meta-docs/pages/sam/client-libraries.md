# Segment Anything Model client libraries {#segment-anything-model-client-libraries}

Segment Anything Model 3.1 (SAM 3.1) returns segmentation as a custom special-token grammar in the [Responses](https://dev.meta.ai/docs/protocols/responses) output-text lane. The Meta-SAM packages are optional convenience libraries that decode that grammar for you: `@meta-sam/parser` is the core piece — it consumes the streamed output, builds typed, immutable snapshots, and decodes masks — while the graphics, video, and react packages add opinionated render and playback utilities for canvas overlays and frame-accurate video. If you prefer, write your own parsing against the [documented grammar](https://dev.meta.ai/docs/sam/reading-segmentation) and skip these packages. The graphics, video, and react packages are TypeScript; the parser ships in both TypeScript (`@meta-sam/parser`) and Python (`meta_sam_parser`).

- **`@meta-sam/parser`**: The core library. Consume streamed Responses events and build typed image or video segmentation snapshots, decode masks, and build box and point prompts. Zero runtime dependencies.
- **`meta_sam_parser`** (Python): The parser as a native Python port against the same contract. Parse Responses output, decode or convert masks, and build box and point prompts. Python ≥ 3.10, zero dependencies, typed.
- **`@meta-sam/graphics`**: Optional. Retain masks and boxes from parser views and draw Canvas 2D overlays.
- **`@meta-sam/video`**: Optional. Decode video into a caller canvas with packet-exact frame metadata and audio support.
- **`@meta-sam/react`**: Optional. Bind the player and renderer to React through `Video` or `useMediaPlayer`.

## Install packages {#install}

Install the packages you need from npm:

```shell
npm install @meta-sam/parser
npm install @meta-sam/graphics @meta-sam/video
npm install @meta-sam/react
```

Install the parser alone when you only consume segmentation output. Add graphics and video for overlays and playback. Add react for the React bindings, alongside `react` and `react-dom` (`>=18.2 <20`), which are peer dependencies. The dependency chain is `react` on `graphics`, `video`, and `parser`; `graphics` on `parser`. Take only what you need: the parser alone decodes masks.

The packages ship ESM only, so use `import`. They support Node.js `^20.17.0` or `>=22.9.0`. Import from the package root only; deep imports are unsupported.

## Build box and point prompts {#build-prompts}

To [prompt with boxes and points](https://dev.meta.ai/docs/sam/segmenting#object-prompts), build the `input_text` with `buildObjectPrompt` from `@meta-sam/parser` 0.1.0 or later. Pass the media's pixel size and the objects to segment, each with an id and its prompts:

**TypeScript**

```typescript
import OpenAI from "openai";
import { buildObjectPrompt, parseImageStream, recordsOfKind } from "@meta-sam/parser";

const client = new OpenAI({
  baseURL: "https://api.meta.ai/v1",
  apiKey: process.env.MODEL_API_KEY,
});

const text = buildObjectPrompt({
  size: { width: 1800, height: 1200 }, // the image's pixel size, as displayed
  objects: [
    { id: 1, prompts: [{ box: { left: 444, top: 626, right: 676, bottom: 850 } }] },
    { id: 2, prompts: [{ points: [{ x: 1430, y: 700 }, { x: 1300, y: 450, label: "negative" }] }] },
  ],
});
// <0f>1<|box;x1=444;y1=626;x2=675;y2=849;w=1800;h=1200|>,2<|point;x=1430;y=700;w=1800;h=1200|>-<|point;x=1300;y=450;w=1800;h=1200|>

const events = await client.responses.create({
  model: "sam-3.1",
  input: [
    { type: "message", role: "user", content: [
        { type: "input_text", text },
        { type: "input_image", image_url: "https://example.com/truck.jpg" },
    ]},
  ],
  stream: true,
});

const result = await parseImageStream(events).finalResult;
for (const box of recordsOfKind(result.records, "box")) {
  console.log(box.objectId, box.left, box.top, box.right, box.bottom);
}
```

For video, give each prompt a `frame`. In Python, `build_object_prompt` in `meta-sam-parser` 0.1.0 or later takes the same input:

**TypeScript**

```typescript
import { buildObjectPrompt } from "@meta-sam/parser";

const text = buildObjectPrompt({
  size: { width: 640, height: 480 },
  objects: [
    {
      id: 1,
      prompts: [
        { frame: 30, box: { left: 10, top: 20, right: 40, bottom: 60 } },
        { frame: 120, points: [{ x: 20, y: 40 }, { x: 30, y: 50, label: "negative" }] },
      ],
    },
  ],
});
// <30f>1<|box;x1=10;y1=20;x2=39;y2=59;w=640;h=480|><120f>1<|point;x=20;y=40;w=640;h=480|>-<|point;x=30;y=50;w=640;h=480|>
```

**Python**

```python
from meta_sam_parser import FramePrompt, PromptBox, PromptObject, PromptPoint, build_object_prompt

text = build_object_prompt(
    size=(640, 480),  # (width, height)
    objects=[
        PromptObject(
            id=1,
            prompts=[
                FramePrompt(frame=30, box=PromptBox(10, 20, 40, 60)),
                FramePrompt(frame=120, points=[PromptPoint(20, 40), PromptPoint(30, 50, label="negative")]),
            ],
        ),
    ],
)
# Same text as the TypeScript example.
```

- **Size**: the media's width and height in pixels, as displayed after any rotation. Convert coordinates from a scaled or cropped view first; see [convert coordinates to media pixels](https://dev.meta.ai/docs/sam/segmenting#coordinates).
- **Boxes**: `left`, `top`, `right`, and `bottom`, with `right` and `bottom` half-open, the same shape as a parsed box record. Pass a box from an earlier response as is to prompt that object again. The builder writes `x2` as `right - 1` and `y2` as `bottom - 1`.
- **Defaults**: `frame` defaults to 0, the only frame of an image, and a point's `label` defaults to `positive`.
- **Ids**: a non-negative integer or its decimal string, such as a parsed record's `objectId`. The response reports the object under this id.
- **Ordering**: frames come out in ascending order, objects in input order within a frame, and each object's box before its points.

The builder formats text only; your client sends the request. It throws `ObjectPromptError` for input it can't encode, with a `code` of `no_objects`, `invalid_size`, `invalid_object_id`, `duplicate_object_id`, `empty_object`, `invalid_frame`, `duplicate_frame`, `empty_prompt`, `invalid_box`, `invalid_point`, or `invalid_point_label`. The API checks every other rule, such as the 16-object limit, and returns a `400` for a prompt it rejects (see [handle errors](https://dev.meta.ai/docs/sam/segmenting#handle-errors)).

## Parse a segmentation stream {#parse-stream}

Pass the async event stream from your Responses client to `parseVideoStream` (or `parseImageStream` for a single image):

**TypeScript**

```typescript
import { parseVideoStream } from "@meta-sam/parser";
import type { ResponsesEvent } from "@meta-sam/parser";

declare const events: AsyncIterable<ResponsesEvent>;

const parsed = parseVideoStream(events);

for await (const snapshot of parsed) {
  console.log(snapshot.revision, snapshot.records.length);
}

const result = await parsed.finalResult;
if (result.outcome.status !== "completed") {
  console.warn("Segmentation ended early:", result.outcome);
}
```

Use `parseImageStream(events)` for a single image and `parseVideoStream(events)` for video; both return the same record shapes. For a format reused across streams or a custom output-text format, `parseResponsesStream(events, format)` and the `formats` registry stay available. The parser buffers text across event boundaries and emits a snapshot when the view changes. Chunk boundaries don't matter: the parser never emits a partial mask. It parses output only; your client sends the request and owns the transport.

Consume the stream once. Iterate the snapshots and then read `finalResult`, or read `finalResult` alone. A second iterator throws `ResponsesStreamConsumedError`, and breaking out of the loop early rejects `finalResult` with `ResponsesStreamAbortedError`.

## Read snapshots and the final result {#snapshots-results}

Each snapshot carries the full accepted state so far. Snapshots are cumulative, so render the latest and don't accumulate records across snapshots:

- **revision**: Monotonic counter that increases with every accepted view update.
- **records**: One append-only list in output order, across text, point, box, and mask records.
- **diagnostics**: Recoverable format problems, each with severity, code, message, line, and raw text. Parsing continues after a diagnostic.
- **rawOutput**: The exact accumulated output text. Build behavior on structured records and keep `rawOutput` for inspection and logging.

Snapshots, records, masks, diagnostics, and results are deeply frozen. Read `finalResult` after iteration for the final cumulative view and its outcome:

- **completed**: `result.outcome` is `{ status: "completed" }` when a valid `response.completed` event closed the finalized output-text lane.
- **incomplete**: `result.outcome` is `{ status: "incomplete", reason }`. The `reason` is `response` when the API emitted `response.incomplete`, or `eof` when the event source ended without a terminal event. Parsed output is still returned.

When intermediate snapshots don't matter, read `finalResult` directly without iterating:

**TypeScript**

```typescript
import { parseVideoStream } from "@meta-sam/parser";
import type { ResponsesEvent } from "@meta-sam/parser";

declare const events: AsyncIterable<ResponsesEvent>;

const result = await parseVideoStream(events).finalResult;
```

## Read confidence values {#confidence}

When a request sets [`include_confidence`](https://dev.meta.ai/docs/sam/segmenting#confidence) to `"true"`, box and mask records carry `confidence`, a number from 0 through 1. Without it, `confidence` is absent (`undefined` in TypeScript, `None` in Python); absence doesn't mean zero. Each record belongs to one frame, so read confidence per frame:

**TypeScript**

```typescript
import { recordsOfKind } from "@meta-sam/parser";
import type { VideoSegmentationResult } from "@meta-sam/parser";

declare const result: VideoSegmentationResult;

for (const box of recordsOfKind(result.records, "box")) {
  console.log(box.frame?.frameIndex, box.objectId, box.confidence);
}
```

Use `@meta-sam/parser` 0.0.13 or later, or `meta-sam-parser` 0.0.6 or later, before you set `include_confidence`. Earlier versions report every line that carries `c` as a `malformed_record` diagnostic and return no records.

## Decode and convert masks {#decode-mask}

Mask records carry complete payloads. Select them with `recordsOfKind`, then convert a mask to the shape your app needs:

**TypeScript**

```typescript
import {
  recordsOfKind,
  decodeMaskToRaster,
  decodeMaskToRLE,
  decodeMaskToSVGPath,
} from "@meta-sam/parser";
import type { VideoSegmentationResult } from "@meta-sam/parser";

declare const result: VideoSegmentationResult;

const [maskRecord] = recordsOfKind(result.records, "mask");
if (maskRecord !== undefined) {
  const raster = decodeMaskToRaster(maskRecord.mask);   // Uint8Array of 0/1, row-major
  const rle = decodeMaskToRLE(maskRecord.mask);         // COCO RLE: { size: [height, width], counts }
  const svgPath = decodeMaskToSVGPath(maskRecord.mask); // "M…L…Z" path string
  console.log(raster.length, rle.counts.length, svgPath.length);
}
```

- `decodeMaskToRaster` returns a row-major `Uint8Array` of exactly `width * height` entries, each `0` or `1`.
- `decodeMaskToRLE` returns a COCO-compatible compressed RLE (`{ size: [height, width], counts }`) in COCO's column-major order — ready for IoU, storage, or evaluation pipelines.
- `decodeMaskToSVGPath` returns a polygonal `M`/`L`/`Z` SVG path string, or `''` for an empty mask.

Request `one_bit` masks with `metadata.mask_encoding` (see [segmenting with prompts](https://dev.meta.ai/docs/sam/segmenting#mask-encoding)) for the smallest payloads. In Python, the same conversions are `decode_mask_to_raster`, `decode_mask_to_rle`, and `decode_mask_to_svg_path` from `meta_sam_parser`.

## Render overlays {#render-overlays}

`@meta-sam/graphics` is an optional utility that draws mask and box overlays on a Canvas 2D context. Use it when you want rendered overlays; skip it if you only need to decode masks.

Call and await `update()` before `render()`. Rendering is synchronous and draws the last committed update only:

**TypeScript**

```typescript
import { SegmentationRenderer } from "@meta-sam/graphics";
import type { ImageSegmentationResult } from "@meta-sam/parser";

declare const result: ImageSegmentationResult;

const canvas = document.querySelector<HTMLCanvasElement>("#overlay");
if (canvas === null) {
  throw new Error("Missing overlay canvas.");
}
const context = canvas.getContext("2d");
if (context === null) {
  throw new Error("Canvas 2D is unavailable.");
}

const renderer = new SegmentationRenderer();
await renderer.update(result);
// Source media dimensions (match the `w`/`h` on the wire) so the overlay scales 1:1.
const imageWidth = 537;
const imageHeight = 561;
renderer.render(context, {
  media: "image",
  source: { x: 0, y: 0, width: imageWidth, height: imageHeight },
  target: { x: 0, y: 0, width: canvas.width, height: canvas.height },
});
```

Pass the complete current view to every `update()` call, since parser views are cumulative. For video results, set `media: "video"` and select the frame with `frameIndex`. Records that share a frame index draw together; records without a frame reference are global and draw on every frame. The retained result media must match the render options.

For decoded video frames, compose through `renderVideoFrame()`. It draws the decoded frame first with the same fit and device pixel ratio, then draws the overlay for that frame index. `fit` accepts `contain`, `cover`, or `fill`. Pass a `Set<string>` of object ids to hide in `hiddenIds`: it hides those objects from the overlay without changing retained parser state. The id is the record's `objectId` — the wire's integer id, kept as a string (`"0"`, `"1"`). Because it is a stable track id, an id you hide stays hidden on every frame it appears on. Follow one object by holding its id while it stays in frame; don't rely on it across entry, exit, or full occlusion. See [track objects across frames](https://dev.meta.ai/docs/sam/reading-segmentation#object-identity).

Updates are transactional: a rejected update leaves the previous retained state in place. Call `clear()` to drop retained overlays while keeping the renderer reusable, and call `dispose()` to release it permanently.

Mask fill and outline opacity are configurable through `SegmentationRendererOptions`: `maskFillOpacity` (default `0.35`) and `maskOutline.opacity` (default `0.8`), each a number in the range `0`–`1`. Colors and geometry are fixed.

## Play segmented video {#play-video}

`@meta-sam/video` is an optional utility for frame-accurate video playback under the overlays. Use it when you play segmented clips; skip it if you only decode masks or render single images.

`createMediaPlayer()` returns a Canvas-only player with no media element. Wire the renderer in through `setCustomRender()`, then open a source and play:

**TypeScript**

```typescript
import { SegmentationRenderer } from "@meta-sam/graphics";
import type { VideoSegmentationResult } from "@meta-sam/parser";
import { createMediaPlayer } from "@meta-sam/video";

declare const segmentation: VideoSegmentationResult;

const canvas = document.querySelector<HTMLCanvasElement>("#video");
if (canvas === null) {
  throw new Error("Missing video canvas.");
}

const player = createMediaPlayer(canvas);
const renderer = new SegmentationRenderer();
const hiddenIds = new Set<string>();
await renderer.update(segmentation);

player.setCustomRender((context) => {
  renderer.renderVideoFrame(context, {
    fit: "contain",
    devicePixelRatio: () => window.devicePixelRatio || 1,
    hiddenIds,
  });
});

await player.open("/media/clip.mp4");
await player.seekToFrame(10);
await player.play();
```

The player invokes the render callback for the current frame during playback, so the example passes no explicit frame index.

`open()` accepts a URL string, a `URL`, or a `Blob`. An unsupported video is a fatal `open()` error. Missing or unsupported audio degrades to silent playback, surfaced through the `audiostatuschange` event. Prefer `await player.seek(time)` over assigning `currentTime` when completion matters. `getStats()` returns one frozen `PlaybackStats` snapshot of decode and overlay timings (count, average, p95, max), scheduler counters, queue depths, A/V error, and audio diagnostics. Call `dispose()` to cancel work and release listeners.

The frames you decode and play here match the frames the model segmented, so overlays line up by frame index. If required, an uploaded MP4 is remuxed losslessly for faststart (see [segmenting](https://dev.meta.ai/docs/sam/segmenting#upload-once)), which leaves frames and timestamps untouched.

## Use React bindings {#react-bindings}

`@meta-sam/react` is an optional utility that wraps the player and renderer for React. Use it in a React app; skip it if you work outside React or only decode masks.

`Video` owns a player and a renderer inside one canvas:

**TypeScript**

```typescript
"use client";

import { useRef } from "react";
import { Video, type VideoRef } from "@meta-sam/react";
import type { VideoSegmentationResult } from "@meta-sam/parser";

declare const result: VideoSegmentationResult;

export function SegmentedVideo() {
  const videoRef = useRef<VideoRef>(null);

  return (
    <div>
      <button type="button" onClick={() => void videoRef.current?.play()}>
        Play
      </button>
      <button type="button" onClick={() => videoRef.current?.pause()}>
        Pause
      </button>
      <Video
        ref={videoRef}
        src="/media/clip.mp4"
        result={result}
        objectFit="contain"
        volume={0.8}
        style={{ width: 640 }}
      />
    </div>
  );
}
```

`result` accepts a cumulative snapshot while parsing runs, so overlays stream in, or the final result when parsing completes. New values for `result`, `hiddenIds`, `objectFit`, or `devicePixelRatio` recompose the retained frame without reopening the source. `VideoRef` exposes `play`, `pause`, `seek`, `seekToFrame`, `nextFrame`, `previousFrame`, time-to-frame and frame-to-time lookups, `captureFrame('composited' | 'raw')`, and `getStats()`.

`autoPlay` can't preserve the user-activation token. For audible playback, call `videoRef.current?.play()` from a click handler; `onAudioWarning` surfaces the fallback.

Use `useMediaPlayer` when you own the canvas and need custom composition or controls:

**TypeScript**

```typescript
"use client";

import { useRef } from "react";
import { useMediaPlayer } from "@meta-sam/react";

export function CanvasPlayer({ src }: { src: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useMediaPlayer({
    canvasRef,
    src,
    volume: 0.5,
    renderFrame({ ctx, canvas, frame }) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
    },
    onError(error) {
      console.error("Playback failed", error);
    },
  });

  return (
    <div>
      <button type="button" onClick={() => void playerRef.current?.play()}>
        Play
      </button>
      <canvas ref={canvasRef} width={640} height={360} />
    </div>
  );
}
```

The hook creates the player after the canvas attaches and disposes it on unmount. It opens a changed `src` on the existing player, so callback changes don't recreate the player.

## Handle errors and diagnostics {#errors-diagnostics}

The parser separates recoverable format problems from fatal errors.

Diagnostics are not errors. A malformed line is omitted from `records` and reported in `diagnostics` with a severity, code, message, line, and raw text, and parsing continues. Inspect `diagnostics` even on a completed stream.

Errors are thrown while iterating or reject `finalResult`. Every error extends `ResponsesStreamError`, carries a stable `code`, and preserves the underlying `cause`:

| Error                          | `code`                 | Raised when                                        |
| ------------------------------ | ---------------------- | -------------------------------------------------- |
| `ResponsesStreamConsumedError` | `stream_consumed`      | The stream is iterated or consumed a second time.  |
| `ResponsesStreamAbortedError`  | `stream_aborted`       | Iteration breaks early before the stream finishes. |
| `ResponsesStreamFailedError`   | `response_failed`      | The API reports the response as failed.            |
| `ResponsesStreamEventError`    | `response_error`       | The stream carries an error event.                 |
| `ResponsesStreamLaneError`     | `response_lane`        | The output-text lane is inconsistent.              |
| `ResponsesStreamRefusalError`  | `response_refusal`     | The model refuses the request.                     |
| `ResponsesStreamParserError`   | `parser_error`         | The parser cannot process the stream.              |
| `ResponsesStreamSourceError`   | `source_error`         | The event source fails.                            |
| `InvalidSegmentationMaskError` | `invalid_mask_payload` | `decodeMaskToRaster` receives an invalid payload.  |

Branch on `code` for stable handling; the class hierarchy and `code` values stay constant across releases.

## Run the end-to-end flow {#end-to-end}

This flow sends one request, streams the response, parses each snapshot, and decodes the masks. Use `parseImageStream` for a single image and `parseVideoStream` for a clip.

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

const parsed = parseImageStream(events);
for await (const snapshot of parsed) {
  console.log(snapshot.revision, snapshot.records.length);
}
const result = await parsed.finalResult;
if (result.outcome.status !== "completed") {
  console.warn("Segmentation ended early:", result.outcome);
}

for (const record of recordsOfKind(result.records, "mask")) {
    const raster = decodeMaskToRaster(record.mask);
    console.log(raster.length);
}
```

The stream carries segmentation as special-token text in the `output_text` lane, one line per frame:

```text
<0f>0<|box;x1=353;y1=382;x2=453;y2=427;w=537;h=561|><|mask;x=0;y=0;data=46,101,!...|>,1<|box;x1=260;y1=382;x2=340;y2=427;w=537;h=561|><|mask;x=0;y=0;data=46,81,!...|>
```

See [read segmentation output](https://dev.meta.ai/docs/sam/reading-segmentation) for the full wire grammar.

## Python parser {#python}

`meta_sam_parser` is a native Python port of `@meta-sam/parser`, built against the same cross-language contract (Python ≥ 3.10, no dependencies, typed). Install it with pip:

```shell
pip install meta-sam-parser
```

Import it as `meta_sam_parser`. Parse a Responses stream into the same records as the TypeScript parser, then convert any mask with `decode_mask_to_raster`, `decode_mask_to_rle`, or `decode_mask_to_svg_path`. Build box and point prompts with `build_object_prompt` (see [build box and point prompts](https://dev.meta.ai/docs/sam/client-libraries#build-prompts)). The parsing entry points mirror the TypeScript contract.

## Next steps {#next-steps}

Now that parsing, overlays, and playback are wired up, review the [SAM overview](https://dev.meta.ai/docs/sam/overview) for the request shape that produces this output. Read the wire grammar in [read segmentation output](https://dev.meta.ai/docs/sam/reading-segmentation), then send the request through the [Responses API](https://dev.meta.ai/docs/protocols/responses) with streaming enabled and parse it with the patterns above.
