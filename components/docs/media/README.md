# Docs media kit

The media half of the docs demo kit (docs/DOCS_MIRROR.md, "Kit"): file pickers with our samples, a microphone recorder, generated-image output, the segmentation overlay, and six playgrounds for the media pages. Import from `@/components/docs/media`. Every component is a client component; the playgrounds take plain JSON props (they cross from a server DemoSpec), plus the `slug` the docs page passes.

They're built on the core kit (`@/components/docs/kit`): `useDocsRun` runs and records each call, `ModelSelect` (which shows the Contributor notice itself), `RunButton`, `ErrorBox`, `ResponseView`, `StreamView`, the `Field` controls, and `CodeView` behind a "Show code" toggle, so they look and behave like the text playgrounds. Media goes inline as data URLs (or through the Files API where a page is about it) and stays under the proxy's 4.5 MB body cap: images are downscaled to fit about 1.5 MB, audio is converted to 16 kHz mono WAV, video is checked against 3 MB.

```tsx
// lib/docs/demos/media.ts
import { VisionPlayground } from "@/components/docs/media";

export const mediaDemos: DemoMap = {
  "image-understanding": {
    title: "Ask about an image",
    blurb: "Pick a sample or drop your own photo, ask a question, and Muse Spark answers. Under a cent.",
    Component: VisionPlayground,
    props: { sampleId: "fridge", question: "List every food in this fridge and which shelf it's on.", apiSwitch: true },
    agentPrompt: { task: "..." },
  },
};
```

## Playgrounds

Every prop is optional unless marked required.

### `VisionPlayground`

An image (picker or sample) plus a question, on the Responses API (`input_image`) or Chat Completions (`image_url`), streamed.

| Prop | Type | Default | What it does |
|---|---|---|---|
| `question` | string | "What's in this image? List the main things you see." | The question it starts with |
| `sampleId` | sample id | `"fridge"` | The image picked on load |
| `samples` | string[] (ids or kinds) | every image sample | What the picker offers |
| `detail` | `"auto" \| "low" \| "high"` | not set | `input_image.detail` (left out of the request unless set) |
| `api` | `"responses" \| "chat"` | `"responses"` | Protocol |
| `apiSwitch` | boolean | false | Show a Responses / Chat Completions switch |
| `extraBody` | object | none | Merged into the body, such as `{ text: { format: { type: "json_schema", name, strict: true, schema } } }` |
| `editExtraBody` | boolean | true when `extraBody` is set | Show the extra body as editable JSON |
| `presets` | `{ label, question, sampleId?, extraBody? }[]` | none | Pills that fill the form |
| `model`, `models` | string, string[] | Contributor default, all vision models | Starting model, menu limit |
| `grounding` | boolean | false | Draw boxes and points the reply gives on the 0 to 1000 grid (perception grounding) over the image |
| `secondImage` | boolean | false | A second image slot (questions across two images) |
| `send` | `"inline" \| "file"` | `"inline"` | `"file"` uploads with `POST /v1/files` first and sends the `file_id` |
| `stream` | boolean | true | Stream the reply |
| `maxOutputTokens` | number | none | `max_output_tokens` (`max_completion_tokens` on Chat) |

### `ImageGenPlayground`

Muse Image three ways: a conversation on Responses where each follow-up edits the last image through `previous_response_id` (with a turn history and "Start over"), one-off `images/generations`, and `images/edits` with sample or uploaded images, as Meta's JSON body or multipart. $0.01 per image.

| Prop | Type | Default | What it does |
|---|---|---|---|
| `modes` | `("responses" \| "generations" \| "edits")[]` | all three | Endpoints offered; the first is where it starts |
| `prompt` | string | a watercolor fox | Generation prompt |
| `editPrompt` | string | "Make the sneaker bright orange..." | The prompt edits mode starts with |
| `followUps` | string[] | three follow-ups | Pills shown after the first conversational turn |
| `size`, `sizes` | string, string[] | `"auto"`, five shapes | Requested shape; it sets the aspect ratio only |
| `n` | 1 or 2 | 1 | Images per images/generations or images/edits call |
| `outputFormat` | `"webp" \| "png" \| "jpeg"` | `"webp"` | `output_format` |
| `reasoningStrength` | `"low" \| "high"` | not set (high) | `reasoning_strength` |
| `toolsOff` | `("image_search" \| "web_search" \| "shell")[]` | none | Start with these built-in tools off (`tools[].enable_*` on Responses, `tool_enablement` on the images endpoints) |
| `editSampleIds` | string[] | sneaker, living room, cat, street | Samples for edits and reference images |
| `editSampleId` | sample id | `"sneaker"` | The edit image picked on load |
| `references` | boolean | true | Reference images (`input_image` parts) on the conversation |
| `editBody` | `"json" \| "multipart"` | `"json"` | images/edits body to start with |

### `VideoPlayground`

A short clip plus a question on Responses: inline as `input_video` (data URL), or uploaded with the Files API and referenced as `input_file` or `input_video` by `file_id`. With `audio`, a second tab sends speech as `input_audio` (bare base64, `format: "wav"`), starting on Muse Spark 1.2 as the page advises.

| Prop | Type | Default | What it does |
|---|---|---|---|
| `question` | string | "Describe what happens in this video, step by step." | The question |
| `sampleId` | sample id | `"street-pan"` | The clip picked on load |
| `send` | `"inline" \| "input_file" \| "input_video"` | `"inline"` | How the clip goes in |
| `sendSwitch` | boolean | true | Offer the switch |
| `model`, `models` | string, string[] | Contributor default | Model |
| `presets` | `{ label, question }[]` | none | Question pills |
| `audio` | boolean | false | Add the audio tab |
| `startWith` | `"video" \| "audio"` | `"video"` | Which tab opens first |
| `audioQuestion` | string | "Transcribe this audio. Return only the transcript." | The audio tab's question |
| `stream`, `maxOutputTokens` | boolean, number | true, none | As above |

### `TranscribePlayground`

Muse Voice Transcribe from a sample, a file or the microphone. "File" sends the two-part multipart (`request` JSON and `audio`) to `asr/transcribe`; "Realtime" posts the WAV to `/api/docs/asr-realtime`, which streams it to the WebSocket at real-time pace, and shows partials, turns, speaker labels and progress as they arrive. Audio is converted to 16 kHz mono 16-bit WAV in the browser first. It says plainly that speaker turns may come back empty (docs/SPIKES.md).

| Prop | Type | Default | What it does |
|---|---|---|---|
| `endpoints` | `("transcribe" \| "realtime")[]` | both | Endpoints offered; the first is where it starts |
| `sampleId` | sample id | `"speech-paragraph"` | The audio picked on load (`"two-voices"` for diarization, `"chess-moves"` for commands) |
| `microphone` | boolean | true | Offer recording (60 s cap for realtime, 120 s for files) |
| `mode` | `"PUSH_TO_TALK" \| "ENDPOINTING" \| "DIARIZATION"` | `"PUSH_TO_TALK"` | Starting mode |
| `modes` | same, array | all three | Modes offered |
| `keywords` | string[] | none | Vocabulary biasing, editable as a comma list |
| `languageBias` | string[] | none | Language names, editable |
| `partialMode` | `"CUMULATIVE" \| "DELTA"` | `"CUMULATIVE"` | Realtime partials |

### `SegmentPlayground`

SAM 3.1 on an image or a short clip, with a concept prompt (one short noun phrase, with chips from the sample) or box and point prompts drawn on the media (Box, Point, Negative point, per object id, on the current video frame). The reply streams; each line is parsed as it arrives and drawn on the overlay. "Raw wire" shows the output text exactly.

| Prop | Type | Default | What it does |
|---|---|---|---|
| `media` | `("image" \| "video")[]` | both | Media offered; the first is where it starts |
| `sampleId` | sample id | `"street"` | Image picked on load |
| `videoSampleId` | sample id | `"street-pan"` | Clip picked on load |
| `prompt` | string | `"dog"` | The concept |
| `suggestions` | string[] | the sample's own | Concept chips |
| `promptKind` | `"concept" \| "objects"` | `"concept"` | Starting prompt kind |
| `objectPrompts` | boolean | true | Offer box and point prompts |
| `maskEncoding` | `"one_bit" \| "lossless"` | `"one_bit"` | `metadata.mask_encoding` |
| `includeConfidence` | boolean | true | `metadata.include_confidence: "true"` |
| `propagation` | `"both" \| "forward" \| "backward"` | `"both"` | `metadata.propagation_direction` (video, object prompts) |
| `stream` | boolean | true | Stream the reply |
| `showRaw` | boolean | false | Start with the raw wire showing |

### `FilesPlayground`

The Files API on the visitor's own files: upload (`purpose=user_data`, optional `expires_after`), list, retrieve, download the content (with a preview), delete, and "Use it in a request", a streamed Responses call that references the `file_id` with the part for its kind (`input_image`, `input_video`, `input_audio`) or `input_file`.

| Prop | Type | Default | What it does |
|---|---|---|---|
| `sampleId` | sample id | `"field-report"` | The file picked on load |
| `focus` | `"upload" \| "list" \| "retrieve" \| "content" \| "delete" \| "use"` | `"upload"` | Whose code "Show code" opens on (match the API reference page) |
| `expiry` | boolean | true | Offer `expires_after` |
| `question` | string | by file kind | "Use it in a request" question |
| `model`, `models` | string, string[] | Contributor default | Model for the request |

## Components

### `FilePicker`

Drop a file, choose one, or pick a sample for the kind `accept` allows. Shows a preview and the size, and prepares the file before handing it over.

| Prop | Type | Notes |
|---|---|---|
| `accept` (required) | string | The input's accept list. Also picks the samples offered |
| `value` (required) | `PickedMedia \| null` | |
| `onChange` (required) | `(file: PickedMedia \| null) => void` | |
| `label`, `hint` | string | |
| `samples` | `boolean \| string[]` | true: by `accept`; false: none; a list of kinds (`"image"`) or sample ids |
| `defaultSampleId` | sample id | Loaded on mount when nothing is picked |
| `prepare` | `"image" \| "audio" \| "video" \| "none"` | By kind: images downscale, audio becomes 16 kHz WAV, video is probed and checked |
| `maxBytes` | number | After preparing. Defaults to 3 MB |
| `forSam` | boolean | Check video codecs against what SAM 3.1 takes |
| `maxAudioSeconds` | number | Longest audio accepted |
| `preview` | `"full" \| "compact"` | Player or thumbnail |
| `disabled` | boolean | |

`PickedMedia` (from `lib/docs/media/prepare.ts`): `{ blob, name, mime, bytes, kind, source: "upload" | "sample" | "recording", sampleId?, description?, width?, height?, durationMs?, fps?, frames?, codec?, note?, problems: string[] }`. `blob` is what to send; disable Run while `problems` isn't empty.

### `AudioRecorder`

Record, stop, play back, with a level meter, a clock and a cap. The take is a 16 kHz mono 16-bit WAV.

| Prop | Type | Notes |
|---|---|---|
| `onRecorded` (required) | `(file: PickedMedia) => void` | Called with the take |
| `maxSeconds` | number | Default 60 |
| `label` | string | |
| `disabled` | boolean | |

### `ImageOutput`

Generated images, base64 or URL, with size and a download button each.

| Prop | Type | Notes |
|---|---|---|
| `images` (required) | `OutputImage[]` | `{ b64?, url?, mime?, label?, alt?, id? }`. The type is read from the bytes when `mime` is missing |
| `name` | string | Download file stem, default `"muse-image"` |
| `emptyText` | string | Shown when there are none |

### `MaskOverlay`

A canvas over an image or the current video frame: SAM boxes and masks with per-object colors, labels and confidence, a legend that toggles objects, Masks / Boxes / Labels switches, a frame bar for video, and optional drawing of box and point prompts.

| Prop | Type | Notes |
|---|---|---|
| `src` (required) | string | Object URL or same-origin path |
| `media` (required) | `"image" \| "video"` | |
| `records` | `SamRecord[]` | From `parseSamOutput` / `SamStreamParser` (`lib/docs/media/sam.ts`). Video draws the current frame's |
| `shapes` | `PixelShape[]` | Other boxes and points in media pixels, such as `gridToPixels(groundingShapes(extractJson(text)), w, h)` from `lib/docs/media/grounding.ts` |
| `fps`, `frames` | number | Video: frame rate (default 30) and count, to line SAM's frame numbers up with playback |
| `label`, `labels` | string, `Record<objectId, string>` | Names in tags and the legend |
| `alt` | string | |
| `prompts` | `SamPromptObject[]` | Box and point prompts to draw |
| `tool` | `"box" \| "point" \| "negative" \| null` | Turns drawing on (needs `onPromptsChange`) |
| `activeObjectId` | number | The object new prompts go to |
| `onPromptsChange` | `(prompts) => void` | |
| `onFrame` | `(frame: number) => void` | The current frame as it changes |
| `onMediaSize` | `({ width, height }) => void` | Once the media loads |

Mask pixels: the docs specify the payload's envelope (encoding marker, base85 alphabet, length prefix), which `readMaskEnvelope` checks, but not the arithmetic coder inside it; they point to `decodeMaskToRaster` in Meta's `@meta-sam/parser`. So the raster step is a hook in `lib/docs/media/sam-mask.ts`. Until a decoder is registered, overlays draw the exact boxes and say so. To draw masks, add `@meta-sam/parser` and register it once in client code:

```ts
import { decodeMaskToRaster } from "@meta-sam/parser";
import { setMaskRasterDecoder } from "@/lib/docs/media/sam-mask";
setMaskRasterDecoder((mask) => decodeMaskToRaster(mask));
```

## Helpers (`lib/docs/media/`)

| Module | Exports |
|---|---|
| `samples.ts` | `DOCS_SAMPLES` (15 files: 9 images, a clip, 3 WAVs, a PDF, a text), `samplesOf(kind)`, `sampleById(id)`. Each entry has `description` (the chart's numbers, each transcript, the sign-up screen's button positions), `prompts` that suit it, its pixel size or length, and a small `thumb` for images and the clip |
| `base64.ts` | `fileToDataUrl`, `fileToBase64`, `bytesToBase64`, `base64ToBytes`, `toDataUrl`, `parseDataUrl`, `dataUrlLength`, `maxBytesForDataUrl`, `sniffMime`, `base64ImageMime`, `formatBytes` |
| `downscale.ts` | `downscaleImage(blob, { maxSide, maxDataUrl, type })`, `imageSize`, pure `fitWithin`, `downscalePlan`, `keepsOriginal` |
| `wav.ts` | `encodeWav(samples, rate, channels?)`, `parseWav`, `decodeWav`, `wavPcm`, `isTranscribeReady`, `floatToInt16` |
| `resample.ts` | `resample(samples, from, to)` (windowed sinc), `mixToMono`, `toTranscribeSamples`, `resampledLength`, `rms` |
| `audio.ts` | `decodeAudio(blob)`, `toTranscribeWav(blob, { maxSeconds })`, `formatDuration` |
| `recorder.ts` | `startMicRecording({ maxMs, onLevel, onAutoStop, onError })` returns `{ stop(), cancel() }`; `stop()` gives `{ wav, durationMs, sampleRate }` |
| `video.ts`, `mp4.ts` | `probeVideo`, `videoProblems`, `samVideoCost`, `MAX_INLINE_VIDEO_BYTES`; `parseMp4(bytes)` gives codec, displayed size, rotation, fps, frames, duration, audio, faststart |
| `sam.ts` | `parseSamOutput`, `parseSamLine`, `SamStreamParser`, `samDelta`, `samTextOfResponse`, `recordsByFrame`, `objectIds`, `readMaskEnvelope`, `decodeSamBase85`, `SAM_BASE85`, `buildSamPrompt`, `toMediaPixels`, `boxFromCorners` |
| `sam-mask.ts` | `setMaskRasterDecoder`, `decodeMaskRaster`, `rasterToRgba`, `rasterArea` |
| `requests.ts` | Body builders shared by demos, code and records: `visionRequest`, `videoRequest`, `audioQuestionRequest`, `imageTurnRequest`, `imagesGenerationRequest`, `imagesEditJsonRequest`, `imagesEditFormFields`, `samRequest`, `transcribeRequestPart`, `realtimeQuery`, `realtimeHandshake`, `fileUploadFields`, `fileQuestionRequest`, `partForFile`, `redactMedia` |
| `realtime.ts` | `realtimeStep`, `realtimeText`, `cleanTranscript`, `EMPTY_REALTIME`: folds the realtime relay's events into partials, turns and speakers |
| `images.ts` | `imagesOfResponse`, `reasoningOfResponse`, `imagesOfImagesReply`, `imageOfStreamEvent` |
| `grounding.ts` | `extractJson`, `groundingShapes`, `gridToPixels` |
| `accept.ts`, `prepare.ts` | `acceptKinds`, `matchesAccept`, `kindOf`; `prepareFile` and the `PickedMedia` type |

Samples are made by `scripts/docs/make-samples.ts`; `public/docs-samples/README.md` says where each came from and its license.
