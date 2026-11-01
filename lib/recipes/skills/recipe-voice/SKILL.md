---
name: recipe-voice
description: Use for transcripts with speaker labels, keywords or language hints, push-to-talk commands such as voice chess, or a see-and-ask page using the phone's camera and microphone.
---

# Muse Voice recipes

Read `meta-voice` first for WAV conversion and uploads. **This skill overrides its older line that says there are no speaker labels.** Speaker labels exist with mode `DIARIZATION`. They are not confirmed through this gateway until one real call shows them, so the product must still work when `turns` is empty.

The links are for people and BUILD_NOTES. The build firewall may block GitHub, so never fetch or clone them.

**Limits for a single request:** 10 minutes of audio or 32 MB, mono 16-bit WAV at 16 or 24 kHz. This isn't a live microphone. People record, then get text. Near-live means short recordings in a row.

## The helper

The installed `transcribeFile` sends only the model and audio encoding, so write this as `lib/transcribe.ts`, on the server:

```ts
import { clientIpHeaders, gatewayEnv, type RequestLike } from "@/lib/meta/client";

export type TranscribeMode = "PUSH_TO_TALK" | "ENDPOINTING" | "DIARIZATION";
export interface SpokenTurn { speaker: string | null; startMs: number; endMs: number; text: string }
export interface TranscribeInput {
  bytes?: Uint8Array;    // WAV of 4 MB or less
  url?: string;          // public URL from uploadMedia, for anything larger
  mode?: TranscribeMode;
  keywords?: string[];   // names and jargon the model might mishear
  languageBias?: string[];
  request?: RequestLike | null;
}

export async function transcribe(input: TranscribeInput) {
  const { baseURL, apiKey } = gatewayEnv();
  const options: Record<string, unknown> = { model: "muse-voice-transcribe-1.0" };
  if (input.mode && input.mode !== "PUSH_TO_TALK") options.mode = input.mode;
  if (input.keywords?.length) options.keywords = input.keywords;
  if (input.languageBias?.length) options.languageBias = input.languageBias;

  const headers = { Authorization: `Bearer ${apiKey}`, ...clientIpHeaders(input.request) };
  let init: RequestInit;
  if (input.url) {
    init = { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ ...options, audioUrl: input.url }) };
  } else if (input.bytes) {
    const form = new FormData();
    form.append("request", JSON.stringify({ ...options, audioEncoding: "WAV" }));
    form.append("audio", new Blob([input.bytes.slice()], { type: "audio/wav" }), "audio.wav");
    init = { method: "POST", headers, body: form };
  } else {
    throw new Error("transcribe needs bytes or a url.");
  }

  const res = await fetch(`${baseURL}/asr/transcribe`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(body.error?.message ?? `Transcription failed (HTTP ${res.status}).`);
  const turns: SpokenTurn[] = (Array.isArray(body.turns) ? body.turns : []).map((t: Record<string, unknown>) => ({
    speaker: typeof t.speaker === "string" ? t.speaker : null,
    startMs: Number(t.startMs ?? 0),
    endMs: Number(t.endMs ?? 0),
    text: String(t.transcript ?? "").trim(),
  }));
  return { text: String(body.transcript ?? "").replace(/​/g, "").trim(), turns, durationMs: Number(body.audioDurationMs ?? 0) };
}
```

Read every field defensively: `turns` can be absent, and `speaker` comes only with `DIARIZATION`. Bytes over 4 MB must go through `uploadMedia` and `url`.

## 06/01 Transcripts

Build: a recording becomes a transcript, with speakers and times when it's `DIARIZATION`. Speakers come as anonymous labels, such as "A" and "B", so let the person rename them. Keywords nudge the model but don't guarantee a word. Check: a test with a stubbed reply using turns, and one using none, which shows a plain block of text. The test fixture is made with `espeak-ng`, as in `meta-voice`. Limit: two voices in espeak may not separate, so test the speaker display with a stub. One real call goes in BUILD_NOTES.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/06_muse_voice/01_voice_api_fundamentals

## 06/02 Voice chess on the page (labeled stand-in)

Build: a board on the page, and a hold-to-talk button for one move at a time.

1. One recording per move, `PUSH_TO_TALK`, with `keywords` holding pieces, files, "castle" and "takes".
2. A strict grammar parses the words in code: "e2 to e4", "knight to f3", "castle kingside". The model never chooses a move. Anything else does nothing and shows what was heard.
3. A rules engine in the page checks legality. Use `chess.js` from npm if it installs and its license allows, or write your own. An illegal move changes nothing, and says why.
4. Play a simple reply in code, or let two people take turns.

Say on the page: "This isn't a live microphone, and it doesn't control other apps." Check: unit tests for the grammar, including rejected phrases, with stubbed transcripts through to a moved piece. Limit: no Apple Chess control, and no always-on listening.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/06_muse_voice/02_voice_chess_cua

## 03/03 See and ask, on the web

Build: on a phone, hold a button and ask, take one photo, get a short answer read aloud.

- Use `<input type="file" accept="image/*" capture="environment">` or `getUserMedia` with a fallback to the file picker. Resize with `@/lib/client/resize`.
- Record with MediaRecorder, convert with `toWav16k`, and call `transcribe`.
- Send the question and the photo to `muse-wonder-1.0`, and ask for two or three spoken sentences.
- Speak with the browser's `speechSynthesis`, and always show the text too.

The camera and microphone need HTTPS and a tap to start, so always provide a typed question as a fallback. Don't save photos. Limit: say "This runs in your phone's browser. It doesn't connect to glasses." Real glasses need the glasses target and its flag, and aren't part of this skill.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/03_use_cases/03_visionclaw
