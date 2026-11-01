---
name: recipe-sam-media
description: Use for video work with SAM 3.1, such as masks over clips, animated sticker packs cut from a video, or speech bubble captions that follow each speaker.
---

# SAM media recipes

Read `meta-sam` first for prompts, parsing and limits. The links are for people and BUILD_NOTES. The build firewall may block GitHub, so never fetch or clone them.

## Shared rules

- **Masks on video:** pass `metadata: { mask_encoding: "one_bit" }`, with `stream: true`. Decode each with `decodeMaskToRaster` from `@meta-sam/parser`. It returns a row-major 0/1 array, at the mask's own width and height, which may differ from the displayed size.
- **Clips:** the 4.5 MB body cap means clips go up with `uploadMedia` and are sent with `videoPart({ url })`. On `media_url_origin_error`, upload with `meta.files.create` and `purpose: "user_data"`, and use `videoPart({ fileId })`.
- **Route time:** a long clip can outlast the route, so keep demo clips between 5 and 20 seconds, and state that limit. Billing is per frame, with a 50-frame minimum.
- **Formats:** MP4 or MOV only, so don't record clips with MediaRecorder.
- **Frame accuracy:** seeking a `<video>` in the browser is only roughly accurate. `@meta-sam/video` and `@meta-sam/react` are frame-accurate. Add them only if they resolve from npm, and read each one's LICENSE in `node_modules` first. Otherwise seek with `requestVideoFrameCallback`, and say in BUILD_NOTES that overlays can be a frame off.

## Helpers

`helpers/` beside this file holds pure TypeScript files with no imports. They reach the build at `.agents/skills/recipe-sam-media/helpers/`. Copy the ones you need into `lib/media/`, and don't edit them unless a test shows a bug.

| File | What it gives you |
|---|---|
| `sticker.ts` | `tracksOf`, `smoothCrops`, `capFrameRate`, `motionBetween`, `stickerLength`, `pickWindows`, `packManifest` |
| `webp-anim.ts` | `readWebp`, `buildAnimatedWebp`, `describeAnimatedWebp` |
| `gif.ts` | `encodeGif` |
| `captions.ts` | `speechTurns`, `speakersOf`, `captionChunks`, `chunkAt`, `peopleOf`, `defaultMapping`, `headAnchor`, `smoothAnchors`, `anchorNear`, `wrapText`, `placeBubble`, `tailFor`, `faceRect` |

Read each file's comments and signatures before using it.

## 07/01 API basics

Build: a photo or short clip plus one noun phrase, and masks drawn over the result, with counts. For several concepts, make one request per concept. Check: a fixture stream parses, and an empty result gets a plain message. Limit: at most 16 objects, and one noun phrase per request.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/07_sam/01_api_basics

## 07/02 Sticker pack

Build: a clip and an object noun become three transparent animated stickers, all done in the browser after one SAM call.

1. Segment the clip, then choose the track with `tracksOf` (the longest-lived).
2. Get smooth crops with `smoothCrops`, and limit the rate with `capFrameRate`.
3. For each kept frame, seek the video, draw it on a canvas, and clear pixels outside the raster.
4. Score motion with `motionBetween`, and pick one window from each third with `pickWindows`.
5. Encode each frame with `canvas.toBlob(..., "image/webp")`, then join them with `buildAnimatedWebp`. If the browser can't encode WebP (older Safari), fall back to `encodeGif`, and say that GIF edges are rougher.

Offer a zip with the manifest. Check: unit tests on tracks and windows, and `describeAnimatedWebp` on a real result in the smoke test. Limit: one object per pack, and it needs a clip with a clear subject.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/07_sam/02_video_to_sticker_pack

## 07/03 Speaker captions (labeled stand-in)

Build: a conversation clip gets speech bubbles that follow each speaker, previewed on the page and exported.

1. In parallel: `transcribe` with `DIARIZATION` from `recipe-voice`, on audio extracted in the browser with `toWav16k`, and one SAM call for `person`.
2. `speechTurns` and `captionChunks` make the text; `peopleOf` finds people. `defaultMapping` guesses who speaks. **The person confirms the mapping**, since voices are anonymous.
3. `headAnchor`, `smoothAnchors` and `placeBubble` place bubbles on a canvas over the video.
4. Export: play the clip once, with canvas `captureStream` plus the audio track in MediaRecorder.

Say on the page: "Exports as WebM, recorded in real time. It is not an H.264 MP4." Export takes as long as the clip. Keep the tab in front, since background tabs slow it. Check: unit tests on chunks and placement, using a stubbed transcript. Limit: if a real call returns no turns, offer manual labels, and say speaker labels are unavailable. No server rendering.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/07_sam/03_headlocked_speech_bubble_captions
