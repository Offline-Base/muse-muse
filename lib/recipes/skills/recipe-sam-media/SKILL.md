---
name: recipe-sam-media
description: Use for video work with SAM 3.1, such as masks over clips, animated sticker packs cut from a video, or speech bubble captions that follow each speaker.
---

# SAM media recipes

Read `meta-sam` first for prompts, parsing and limits. The links are for people and BUILD_NOTES. The build firewall may block GitHub, so never fetch or clone them.

## Shared rules

- **Masks on video:** pass `metadata: { mask_encoding: "one_bit" }`, with `stream: true`. Decode each with `decodeMaskToRaster` from `@meta-sam/parser`. It returns a row-major 0/1 array, at the mask's own width and height, which may differ from the displayed size.
- **Drawing over media:** place every SVG box, point and mask with `@/lib/client/overlay`: boxes with `toRect(box, { units: "px", from: { width: w, height: h }, to })`, where `w` and `h` are the size you sent, and a mask path inside `<g transform={maskTransform(maskSize, to)}>`. Test with `overlayProblems` that each box's center is inside the frame and near its mask or point. If `lib/client/overlay.ts` isn't in the project (an older builder), write the same scale yourself: SAM's box numbers are pixels of the media you sent, so multiply by displayed size over sent size, once, and test it the same way.
- **Clips of 4 MB or less** (the sample, short phone clips): the browser posts the file as form data to the product's own route, which calls `meta.files.create({ file: await toFile(bytes, "clip.mp4", { type: "video/mp4" }), purpose: "user_data" })` (`toFile` from `openai`) and sends `videoPart({ fileId })`. This needs no Blob upload, so the sample works on every builder.
- **Bigger clips** go up with `uploadMedia` and are sent with `videoPart({ url })`. On `media_url_origin_error`, fall back to the file id path. If `/api/upload` answers 503 (`uploads_unavailable`, on older builders), say in an `.error` with `role="alert"` that clips over 4 MB can't be sent right now and offer the sample. Never go on without SAM.
- **Route time:** a long clip can outlast the route, so keep demo clips between 5 and 20 seconds, and state that limit. Billing is per frame, with a 50-frame minimum.
- **Formats:** MP4 or MOV only, so don't record clips with MediaRecorder.
- **Frame accuracy:** seeking a `<video>` in the browser is only roughly accurate. `@meta-sam/video` and `@meta-sam/react` are frame-accurate. Add them only if they resolve from npm, and read each one's LICENSE in `node_modules` first. Otherwise seek with `requestVideoFrameCallback`, and say in BUILD_NOTES that overlays can be a frame off.

## The sample clip

The sample is the product's first impression and the smoke test's input, so it shows the real subject. **Never ship a placeholder**: no flat background with a colored block, no test pattern, no shapes standing in for an animal or a person. The Nov 3 audit's sticker studio shipped a 4.5 KB "puppy" clip of an orange block, so SAM had nothing to find.

1. Start from a still of the subject. The brief's image fixture in `fixtures/` is a Muse Image picture of it, like a dog on grass, made by the platform. If there is none, and the brief's references hold a clip of the subject, use that clip as the sample instead and skip step 2.
2. Make a 6 second MP4 from the still with ffmpeg (installed), a slow pan and zoom over it:
   `ffmpeg -y -i fixtures/<still>.jpg -vf "scale=2560:-2,crop=2560:1440,zoompan=z='1+0.2*on/179':x='(iw-iw/zoom)*on/179':y='(ih-ih/zoom)/2':d=180:s=1280x720:fps=30,scale=out_range=tv,format=yuv420p" -c:v libx264 -movflags +faststart public/samples/<name>.mp4`
   For another length, set `d` to 30 times the seconds and replace both `179` with `d - 1`. Look at three of its frames before you go on (`ffmpeg -i <clip> -vf "select='not(mod(n\,60))',tile=3x1" -frames:v 1 /tmp/strip.png`): the subject is in every one. Keep it under 4 MB (`ls -l`; add `-crf 28` if not), so it takes the file id path.
3. Ship the same clip as `fixtures/<name>.mp4` for the smoke test and behind Try the sample. Say in BUILD_NOTES.md that it is a made-up still with a camera move.

If there is no still and no clip, say so in BUILD_NOTES.md and in the verdict, and leave the sample out rather than ship a fake one.

**SAM checks the sample in the smoke test.** The test runs the product's real tracking on the sample clip, through its own route, and asserts SAM found the subject: one track with a mask on most frames, each mask between about 2% and 80% of the frame. Never fake a result: when SAM finds nothing or the call fails, say so in an `.error` with `role="alert"` and offer Retry. Never draw an estimated box or a drifting outline instead, and never cut stickers from one.

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

Build: a photo or short clip plus one or more noun phrases, and masks drawn over the result, with a count per phrase.

1. Photos go as a data URL, resized with `@/lib/client/resize`; clips take the paths above.
2. One request per phrase, run in parallel ("duck" and "water" are two calls, never "duck, water"). Each phrase gets its own color and a count ("Found 5 ducks").
3. Show what Meta's `summary.json` holds, per phrase: outcome, boxes, mask sizes in pixels and, for a clip, each track's first and last frame. Offer it as a JSON download.
4. A completed request with zero masks is a valid empty match: "No ducks found. Try a closer photo." HTTP errors, refusals and an incomplete stream are errors, in an `.error` with `role="alert"` and Retry.

The sample is the brief's image fixture (several of one kind of thing, like ducks on a pond), and the smoke test sends it through the real route and asserts at least one mask. Check: a fixture stream parses, and an empty result gets the plain message. Limit: at most 16 objects, and one noun phrase per request.
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

The sample is a conversation clip made in the build: the brief's image fixture of two made-up people side by side, both whole in frame, panned as above for as long as a two-voice espeak track (recipe-voice, "Samples and uploads": four short lines, alternating voices, about 9 seconds). Mux them in one step, checked here (9 s, 270 frames, about 1.2 MB):
`ffmpeg -y -i fixtures/<still>.jpg -i /tmp/convo.wav -filter_complex "[0:v]scale=2560:-2,crop=2560:1440,zoompan=z='1+0.1*on/269':x='(iw-iw/zoom)*on/269':y='(ih-ih/zoom)/2':d=270:s=1280x720:fps=30,scale=out_range=tv,format=yuv420p[v]" -map "[v]" -map 1:a -c:v libx264 -c:a aac -b:a 96k -shortest -movflags +faststart public/samples/<name>.mp4`
Say in BUILD_NOTES.md and on the page that the sample is a still with a camera move and synthetic voices, so mouths don't move.

1. In parallel: `transcribe` with `DIARIZATION` from `recipe-voice`, on audio extracted in the browser with `toWav16k`, and one SAM call for `person`.
2. `speechTurns` and `captionChunks` make the text; `peopleOf` finds people. `defaultMapping` guesses who speaks. **The person confirms the mapping**, since voices are anonymous: play a few seconds of each voice, then they tap the person who said it.
3. `headAnchor`, `smoothAnchors` and `placeBubble` place bubbles on a canvas over the video.
4. Export: play the clip once, with canvas `captureStream` plus the audio track in MediaRecorder.

Say on the page: "Exports as WebM, recorded in real time. It is not an H.264 MP4." Export takes as long as the clip. Keep the tab in front, since background tabs slow it. Check: unit tests on chunks and placement, using a stubbed transcript; the smoke test runs both real calls on the sample and asserts two person tracks and non-empty text. Limit: if a real call returns no turns, offer manual labels, and say speaker labels are unavailable. No server rendering.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/07_sam/03_headlocked_speech_bubble_captions
