---
name: meta-voice
description: Use to turn recorded speech into text with Muse Voice Transcribe (muse-voice-transcribe-1.0). WAV in, one block of text out.
---

# Muse Voice Transcribe

## What you get

One transcript string plus the audio duration. **No speaker labels and no timings**: `turns` comes back empty, even for two voices. Don't promise "who said what". If the brief needs speakers, send the transcript to Muse Spark 1.3 and say in the UI that speaker split is a guess.

## WAV only

Meta accepts only **mono 16-bit PCM WAV at 16 or 24 kHz**. MP3, M4A, AAC, OGG, Opus and WebM all fail with HTTP 400. Always convert in the browser first with `toWav16k` from `@/lib/client/wav`. It decodes anything the browser can play, including MediaRecorder webm/opus, so recording with MediaRecorder is fine once converted.

## Flow

1. Browser: get audio from `<input type="file" accept="audio/*">` or MediaRecorder, then `const wav = await toWav16k(blob)`.
2. Send it to your action route:
   - Up to 1 minute (WAV is about 32 KB per second, and base64 adds a third, so it stays well under the 4.5 MB body limit): send it in the JSON body as a data URL (`blobToDataUrl` from `@/lib/client/resize`).
   - Longer: `uploadMedia(wav, { fileName: "note.wav" })` from `@/lib/client/upload`, and send the returned `url`.
3. Server: call `transcribeFile`.

```ts
import { transcribeFile } from "@/lib/meta/voice";

// data URL from the browser
const bytes = Buffer.from(audio.slice(audio.indexOf(",") + 1), "base64");
const { text, durationSec } = await transcribeFile({ bytes, request }); // request: the route's incoming request

// or a public URL from uploadMedia (pass size if you know it)
const t = await transcribeFile({ url, size, request });
```

`transcribeFile` sends small files as multipart, exactly like Meta's API. Files over 4 MB go as JSON `{ model, audioUrl }`, a Muse Muse gateway extension where the gateway downloads the file. It trims the text and strips the zero-width space Meta sometimes appends. It throws a plain `Error` with Meta's message on failure: show "Couldn't hear that. Try a shorter, clearer recording."

## Live captions

Not available. Realtime needs a WebSocket the gateway doesn't proxy. If the brief asks for live captions, record short chunks, transcribe each one, and call it near-live in the UI.

## Test fixtures

Make speech fixtures with espeak-ng and ffmpeg (both installed in the builder), then use the WAV in action tests and a webm in the browser test so `toWav16k` is exercised:

```bash
espeak-ng -w /tmp/raw.wav "Three sparrows were at the feeder this morning."
ffmpeg -y -i /tmp/raw.wav -ar 16000 -ac 1 fixtures/note.wav
ffmpeg -y -i fixtures/note.wav -c:a libopus fixtures/note.webm
```

## Doing something with the transcript

Send it to Muse Spark 1.3 (meta-reasoning skill) with `respondJson` for summaries, action items or study notes.

## Cost and limits

$0.18 per hour of audio, billed by duration. Cap recordings at 60 minutes and show progress while a long file is transcribed.
