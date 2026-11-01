---
name: muse-media
description: Use when the brief has a media block, to read text aloud, make a video from pictures, write or play music as MIDI, turn a hummed tune into notes, or count more than 16 objects in a photo with SAM 3.1.
---

# Media made in the browser

brief.md's `### Media in the browser` section says which parts this product has (`- Media parts:`). Use only those.
Every helper is a platform file in `lib/platform/`: import it, never edit or copy it. Each throws a `MediaError`
(from `lib/platform/media-assets.ts`) whose message is plain words: show `err.message` as it is.

All of this runs in the user's browser (`"use client"` components), except `samBoxes`, which runs on the server.

## Speech: `lib/platform/speech.ts`

```tsx
"use client";
import { prepareSpeech, speak, stopSpeech } from "@/lib/platform/speech";

const [state, setState] = useState<"idle" | "loading" | "reading">("idle");
const [progress, setProgress] = useState(0);
const [note, setNote] = useState<string | null>(null);

async function readAloud(text: string) {
  setState("loading");
  const res = await speak(text, { onProgress: (p) => setProgress(p.done) });
  setNote(res.note ?? null); // set when it fell back to the browser's own voice
  setState("idle");
}
```

- `speak(text)` reads up to 600 characters in English with an open model (SpeechT5) in the page. The first use downloads
  about 190 MB from Muse Muse; the browser keeps it, so later uses start at once and work offline. Show the download as a
  progress bar with words ("Getting the reading voice ready, 40%"), only on the first use.
- It answers `{ by: "model" | "browser" | "none", durationMs, note? }`. With no WebAssembly or no connection to the
  files it reads with the browser's own voice and sets `note`: show that one line under the button. `by: "none"` means
  the browser has no voice at all: say so.
- Show a Stop button while reading: `stopSpeech()`.
- Longer text: split it into parts the user picks, each under 600 characters. Never read on page load: a tap starts it.
- Limit to show once: "The reading voice is plain and English only."

## Video from pictures: `lib/platform/video.ts`

```tsx
import { imagesToVideo } from "@/lib/platform/video";

const video = await imagesToVideo(frames, { fps: 2 }); // frames: image URLs, data URLs, Blobs, canvases or bitmaps
// video: { blob, url, mimeType: "video/mp4", durationMs, width, height, frames, codec }
<video src={video.url} controls playsInline className="..." />
<a className="btn" href={video.url} download="slideshow.mp4">Save video</a>
```

- At most 120 pictures and 1280 px on the long side. `fps` 1 to 2 for a slideshow, 8 to 12 for a flipbook. Pictures
  are letterboxed (`fit: "contain"`) unless you pass `fit: "cover"`.
- Pictures from Muse Image are data URLs: pass them straight in. Make them all the same aspect ratio for a clean video.
- It's an H.264 MP4 in Chrome, Edge and Safari, VP9 in an MP4 elsewhere. No sound track.
- Revoke the old `url` with `URL.revokeObjectURL` when a new video replaces it.

## Music: `lib/platform/midi.ts`

```ts
import { midiBlob, noteName, notesFromAudio, playNotes, toMidi, type Note } from "@/lib/platform/midi";

const tune: Note[] = [{ pitch: 60, startBeat: 0, beats: 1 }, { pitch: 64, startBeat: 1, beats: 1 }, { pitch: 67, startBeat: 2, beats: 2 }];
const player = playNotes(tune, { bpm: 100, onEnd: () => setPlaying(false) }); // player.stop()
const file = URL.createObjectURL(midiBlob(toMidi(tune, { bpm: 100, name: "My tune" })));
<a className="btn" href={file} download="tune.mid">Save MIDI file</a>
```

- `pitch` is a MIDI number: 60 is middle C (C4), 69 is A4. `noteName(60)` is "C4". Times are in beats.
- A model can write notes: ask Muse Wonder with `respondJson` for `{ notes: [{ pitch, startBeat, beats }] }`, then
  check them in code (pitches 36 to 96, beats over 0, at most 2000 notes) before playing.
- Hummed or sung tunes: record with the microphone (product-ui skill), decode it with
  `new AudioContext().decodeAudioData(await blob.arrayBuffer())`, then
  `notesFromAudio(buffer.getChannelData(0), buffer.sampleRate, { bpm })`. It finds one pitch at a time, so it works
  for a voice or a whistle, not chords. Show the notes by name so the user can fix a wrong one.
- `playNotes` uses simple built-in tones, not real instruments. Say so once.

## Many objects in one photo: `lib/platform/sam-tiles.ts` and `lib/platform/sam-boxes.ts`

SAM finds at most 16 objects a call. `findAll` splits the photo into overlapping tiles, sends each to your own action
route, splits a tile again when it comes back full, and merges the boxes so an object on a seam counts once.

The route (`app/api/actions/find_tile/route.ts`, listed in musemuse.json like any action):

```ts
import { samBoxes, SamTileError } from "@/lib/platform/sam-boxes";

export async function POST(request: Request) {
  const { tile, phrase } = await request.json();
  try {
    return Response.json({ boxes: await samBoxes(request, tile, phrase) });
  } catch (err) {
    if (err instanceof SamTileError) return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
```

The page:

```ts
import { findAll } from "@/lib/platform/sam-tiles";

const result = await findAll(photoFile, "bird", {
  tiles: 4,
  segment: async (tile, phrase) => {
    const res = await fetch("/api/actions/find_tile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tile, phrase }) });
    if (!res.ok) throw new Error((await res.json()).error ?? "Looking at the photo failed.");
    return (await res.json()).boxes;
  },
  onTile: (done, planned) => setProgress(`${done} of ${planned}`),
});
// result: { boxes, tiles, rawBoxes, saturated, capped, costUsd, width, height }
```

- `tiles: 4` to start; it adds tiles only where a tile came back full, up to 16 calls a photo (about $0.04). When
  `capped` is true, show the count as "at least 48 birds".
- Draw `result.boxes` over the photo scaled from `result.width` and `result.height` (meta-sam skill, Drawing results).
- In the platform's test runs `findAll` holds itself to 4 SAM calls a page in all, so test one photo with `{ tiles: 4 }`.
- Long clips: `videoChunks(file)` keeps 5 frames a second and cuts the clip into H.264 MP4 chunks of at most 300 frames,
  900 frames in all (about $0.18). Upload each `chunk.blob` with `uploadMedia`, send each to SAM as the meta-sam skill
  says, and add `chunk.startMs` to its frame times. When `capped` is true, say only the first part was read.

## Notices

`public/notices/media.txt` lists the open source parts. Link "Open source notices" to `/notices/media.txt` from the
page's footer area. The platform's check fails without the link.

## Smoke test (`tests/caps/media.ts`)

```ts
import { expectMidi, expectSpeech, expectTiles, expectVideoPlays } from "./caps/media";

await expectVideoPlays(page, { make: page.getByRole("button", { name: "Make video" }), shot: "03-video" });
await expectMidi(page, { click: page.getByRole("link", { name: "Save MIDI file" }), shot: "04-tune" });
await expectSpeech(page, { click: page.getByRole("button", { name: "Read aloud" }) });
await expectTiles(page, { shot: "05-count" }); // after the product ran findAll
```

- Call only the helpers for the parts brief.md lists. Each records a check and saves the file it checked.
- Keep test media small: 10 frames, a few notes, one short sentence, one photo with `{ tiles: 4 }`.
- Make a hummed-tune fixture with ffmpeg, no model needed:
  `ffmpeg -f lavfi -i "sine=frequency=262:duration=0.5" -f lavfi -i "sine=frequency=330:duration=0.5" -f lavfi -i "sine=frequency=392:duration=0.5" -filter_complex "[0][1][2]concat=n=3:v=0:a=1" -ar 16000 -ac 1 fixtures/hum.wav`
  (C4, E4, G4).
- In the test browser speech may come from the model or from the browser's voice: assert only that `expectSpeech`
  passed, never which voice read it.
