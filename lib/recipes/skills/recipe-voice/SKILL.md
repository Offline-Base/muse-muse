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

## Samples and uploads

- **The sample is real speech.** Try the sample sends a bundled WAV through the product's real route, never a canned transcript. Make it in the build with `espeak-ng` and ffmpeg (both installed), as in `meta-voice`, from made-up lines that use the product's keywords. For two or more speakers, give each a different voice and pitch, join the lines with short silences, and keep it under 60 seconds:
  `espeak-ng -v en-us -p 35 -w /tmp/a1.wav "<line>"`, `espeak-ng -v en-gb+f3 -p 70 -w /tmp/b1.wav "<line>"`, then
  `ffmpeg -y -i /tmp/a1.wav -i /tmp/b1.wav -i /tmp/a2.wav -filter_complex "[0][1][2]concat=n=3:v=0:a=1,aresample=16000" -ac 1 -sample_fmt s16 public/samples/<name>.wav`
  Pad each line with `apad=pad_dur=0.4` if the turns run together. Ship the same file as `fixtures/<name>.wav` for the smoke test.
- **Size.** A 16 kHz mono WAV is about 32 KB a second, so 4 MB is about 2 minutes. Shorter recordings go as bytes. Longer ones need `uploadMedia`; if that answers 503 (`uploads_unavailable`, on older builders), say in an `.error` with `role="alert"` that recordings over about 2 minutes can't be sent right now. Never send a shortened or made-up transcript instead.

## 06/01 Transcripts

Build: a recording becomes a transcript, with speakers and times when it's `DIARIZATION`. Show each turn as `[1.52s] A: text`. Speakers come as anonymous labels, such as "A" and "B", so let the person rename them. When a later model call suggests who each speaker is (a name said in the talk), put that name in the speaker's name field as its starting value, marked as a suggestion, and never leave the field empty while the suggestion goes unused. Offer a keywords box (names and jargon) and a language hint, and say they nudge the model but don't guarantee a word. Meta's streaming endpoint (`/v1/asr/realtime`) isn't reachable from a product, so say "transcribes a finished recording, not live". Check: a test with a stubbed reply using turns, and one using none, which shows a plain block of text; the smoke test sends the sample through the real route and asserts non-empty text. Limit: two voices in espeak may not separate, so test the speaker display with a stub. One real call goes in BUILD_NOTES.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/06_muse_voice/01_voice_api_fundamentals

## 06/02 Voice chess on the page (labeled stand-in)

Build: a board on the page, and a hold-to-talk button for one move at a time.

1. One recording per move, `PUSH_TO_TALK`, with `keywords` holding `Move`, `to` and the 64 squares (`A1` to `H8`).
2. Meta's grammar, parsed in code: `Move <square> to <square>`, a case-insensitive full match with an optional trailing period, files A to H, ranks 1 to 8, and two different squares. Trim the transcript and drop the zero-width space; repair nothing else ("E two", extra words or missing spaces are rejected). The model never chooses a move. Anything else does nothing and shows what was heard.
3. Only the final transcript of the latest recording can move a piece. A reply for an older recording, a duplicate, or one that lands while a move is being made is dropped.
4. A rules engine in the page checks legality. Use `chess.js` from npm if it installs and its license allows, or write your own. An illegal move changes nothing, and says why. The game ends on checkmate or stalemate with an end screen and New game.
5. Play a simple reply in code, or let two people take turns.
6. Show what the original's HUD shows: `VOICE` (idle, recording, sending), `TURN` (whose move) and `HEARD` (the last transcript and whether it parsed).

Ship two espeak samples, "Move E2 to E4." and one that must be rejected, such as "Knight to f3", behind "Try a sample move", so a judge with no microphone sees a real transcription move a piece, and see the rejection. Say on the page: "This isn't a live microphone, and it doesn't control other apps." Check: unit tests for the grammar, including rejected phrases, with stubbed transcripts through to a moved piece; the smoke test sends the sample through the real route and asserts the pawn moved. Limit: no Apple Chess control, and no always-on listening.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/06_muse_voice/02_voice_chess_cua

## 03/03 See and ask, on the web

Build: on a phone, hold a button and ask, take one photo, get a short answer read aloud.

- Use `<input type="file" accept="image/*" capture="environment">` or `getUserMedia` with a fallback to the file picker. Resize with `@/lib/client/resize`.
- Record with MediaRecorder, convert with `toWav16k`, and call `transcribe`.
- Send the question and the photo to `muse-wonder-1.0`, and ask for two or three spoken sentences.
- Speak with the browser's `speechSynthesis`, and always show the text too.

The camera and microphone need HTTPS and a tap to start, so always provide a typed question as a fallback. Don't save photos. Limit: say "This runs in your phone's browser. It doesn't connect to glasses." Real glasses need the glasses target and its flag, and aren't part of this skill.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/03_use_cases/03_visionclaw
