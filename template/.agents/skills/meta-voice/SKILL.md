---
name: meta-voice
description: Use to turn recorded speech into text with Muse Voice Transcribe (muse-voice-transcribe-1.0), with turn-level timing and speaker labels.
---

# Muse Voice Transcribe

## What you get

A transcript split into turns, each with timing and a speaker label. There are no word-level timestamps.

## Recorded files (v1)

1. In the browser, upload the audio with `uploadMedia` (product-ui skill).
2. On the server, call `transcribeFile` with the uploaded file's URL. It sends the audio to `POST /v1/asr/transcribe` through the gateway. The exact request format gets confirmed during the build week, and the helper hides it.

```ts
import { transcribeFile } from "@/lib/meta/voice";

const transcript = await transcribeFile({ url: audioUrl, mimeType: "audio/mp4" });
for (const turn of transcript.turns) {
  // turn.speaker, turn.startSec, turn.endSec, turn.text
}
```

## Live captions

Live captions are not in v1. Realtime transcription needs a WebSocket to `wss://api.meta.ai/v1/asr/realtime` with 16-bit PCM mono audio at 16 or 24 kHz, and the gateway doesn't proxy WebSockets yet. If the brief asks for live captions, record short chunks, transcribe each one, and call it near-live in the UI.

## Doing something with the transcript

Send the transcript to Muse Spark 1.3 (meta-reasoning skill) for summaries, questions, action items or study notes. Keep the speaker labels in the prompt.

## Cost and limits

- $0.18 per hour of audio.
- Cap uploads at 60 minutes in v1 and show progress while a long file is transcribed.
