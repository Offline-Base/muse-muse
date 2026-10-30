import type { DemoMap, DemoSpec } from "@/lib/docs/demos/types";
import {
  ParserLab,
  SegmentLab,
  TranscribeLab,
  VoiceSchemaExplorer,
  WireInspector,
  type ParserLabProps,
  type SegmentLabProps,
  type TranscribeLabProps,
  type VoiceSchemaExplorerProps,
  type WireInspectorProps,
} from "@/components/docs/playgrounds/voice-sam";

/**
 * Live demos and coding-agent prompts for the "voice-sam" pages:
 *   speech-to-text
 *   media-segmentation
 *   sam/overview
 *   sam/segmenting
 *   sam/reading-segmentation
 *   sam/client-libraries
 *   api-reference/voice
 *   api-reference/voice/transcribe
 *   api-reference/voice/realtime
 *   api-reference/voice/schemas
 * Components live in components/docs/playgrounds/voice-sam/. Every preset is a request that works through the docs
 * proxy (checked against the live API on Oct 30, 2026), except the ones grouped under "Errors", which the API
 * rejects on purpose to show its messages: with a 400 or a 406, or for one streamed SAM preset with an error event
 * under HTTP 200. Neither model in this group is a Contributor model, so nothing here sends to one except
 * SegmentLab's optional "Ask Muse Spark" step, whose model menu shows the notice.
 *
 * The copy prompts are sized to stay whole with a recorded run included ("Include what I just ran" is on by
 * default): __tests__/demos.test.tsx builds each one with the requests these demos record and checks that every
 * fact and snippet survives.
 */

/** Types one DemoSpec against its component's props (DemoMap itself takes any props). */
function demo<P extends object>(spec: DemoSpec<P>): DemoSpec<P> {
  return spec;
}

// ---- Shared snippets ------------------------------------------------------------------------------------------------

const TRANSCRIBE_CURL = `curl --fail-with-body \\
  'https://api.meta.ai/v1/asr/transcribe?sessionId=my-session-id' \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -H 'Accept: application/json' \\
  -F 'request={"model":"muse-voice-transcribe-1.0","audioEncoding":"WAV","mode":"DIARIZATION","keywords":["Acme Mobile","eSIM"]};type=application/json' \\
  -F 'audio=@meeting.wav;type=audio/wav'

# Events instead of one JSON body:
curl --fail-with-body -N 'https://api.meta.ai/v1/asr/transcribe' \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -H 'Accept: text/event-stream' \\
  -F 'request={"model":"muse-voice-transcribe-1.0","audioEncoding":"WAV","mode":"ENDPOINTING"};type=application/json' \\
  -F 'audio=@meeting.wav;type=audio/wav'`;

const TRANSCRIBE_PY = `import json
import os

import requests

request = {"model": "muse-voice-transcribe-1.0", "audioEncoding": "WAV", "mode": "DIARIZATION", "keywords": ["Acme Mobile", "eSIM"]}
with open("meeting.wav", "rb") as audio:
    response = requests.post(
        "https://api.meta.ai/v1/asr/transcribe",
        params={"sessionId": "my-session-id"},
        headers={"Authorization": f"Bearer {os.environ['MODEL_API_KEY']}", "Accept": "application/json"},
        files={
            "request": (None, json.dumps(request), "application/json"),
            "audio": ("meeting.wav", audio, "audio/wav"),
        },
    )
response.raise_for_status()
reply = response.json()
print(reply["transcript"], reply["audioDurationMs"])
for turn in reply["turns"]:  # can be empty
    print(turn.get("speaker", "?"), turn["startMs"], turn["endMs"], turn["transcript"])`;

const TRANSCRIBE_TS = `import { readFile } from "node:fs/promises";

const form = new FormData();
form.append("request", JSON.stringify({ model: "muse-voice-transcribe-1.0", audioEncoding: "WAV", mode: "DIARIZATION", keywords: ["Acme Mobile", "eSIM"] }));
form.append("audio", new Blob([await readFile("meeting.wav")], { type: "audio/wav" }), "meeting.wav");

const res = await fetch("https://api.meta.ai/v1/asr/transcribe?sessionId=my-session-id", {
  method: "POST",
  headers: { Authorization: \`Bearer \${process.env.MODEL_API_KEY}\`, Accept: "application/json" },
  body: form,
});
if (!res.ok) throw new Error(\`HTTP \${res.status}: \${await res.text()}\`);
const reply = await res.json();
console.log(reply.transcript, reply.audioDurationMs);
for (const t of reply.turns) console.log(t.speaker ?? "?", t.startMs, t.endMs, t.transcript);`;

const REALTIME_PY = `import asyncio, json, os, wave

import websockets

async def send_audio(ws, pcm: bytes) -> None:
    for at in range(0, len(pcm), 2560):  # 80 ms frames at real-time pace
        await ws.send(pcm[at : at + 2560])
        await asyncio.sleep(0.08)
    await ws.send('{"type": "endStream"}')  # then keep reading

async def main() -> None:
    with wave.open("speech.wav", "rb") as wav:  # 16 kHz mono
        pcm = wav.readframes(wav.getnframes())
    async with websockets.connect("wss://api.meta.ai/v1/asr/realtime") as ws:
        await ws.send(json.dumps({"authorization": {"accessToken": "Bearer " + os.environ["MODEL_API_KEY"]},
                                  "audioEncoding": "PCM_16KHZ", "model": "muse-voice-transcribe-1.0", "mode": "ENDPOINTING"}))
        print(await ws.recv())  # the acknowledgement
        sender = asyncio.create_task(send_audio(ws, pcm))
        async for message in ws:  # ends on 1000; other close codes raise
            if isinstance(message, str) and json.loads(message).get("type") in ("speechComplete", "error"):
                print(message)
        await sender
        print("closed with", ws.close_code)

asyncio.run(main())`;

const REALTIME_TS = `import { readFile } from "node:fs/promises";

const pcm = (await readFile("speech.wav")).subarray(44); // a 16 kHz mono 16-bit WAV's samples
const ws = new WebSocket("wss://api.meta.ai/v1/asr/realtime"); // Node 22+
ws.onopen = () =>
  ws.send(JSON.stringify({ authorization: { accessToken: \`Bearer \${process.env.MODEL_API_KEY}\` }, audioEncoding: "PCM_16KHZ", model: "muse-voice-transcribe-1.0", mode: "ENDPOINTING" }));
ws.onmessage = async (e) => {
  if (typeof e.data !== "string") return;
  const event = JSON.parse(e.data);
  if (!("type" in event)) {
    // The acknowledgement {sessionId}: send 80 ms frames at real-time pace, then endStream, and keep reading.
    for (let at = 0; at < pcm.length; at += 2560) {
      ws.send(pcm.subarray(at, at + 2560));
      await new Promise((r) => setTimeout(r, 80));
    }
    ws.send(JSON.stringify({ type: "endStream" }));
  } else if (event.type === "error" || event.type === "speechComplete") console.log(event);
};
ws.onclose = (e) => console.log("closed", e.code); // 1000 done, 1008 fix, 1011 retry, 1013 back off`;

const REALTIME_CURL = `# curl can't hold a WebSocket session, so write the realtime client in a language with one (Python websockets,
# Node 22's WebSocket). To check the key, the mode and the audio first, asr/transcribe streams the same server events
# over HTTP:
curl --fail-with-body -N 'https://api.meta.ai/v1/asr/transcribe' \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -H 'Accept: text/event-stream' \\
  -F 'request={"model":"muse-voice-transcribe-1.0","audioEncoding":"WAV","mode":"ENDPOINTING"};type=application/json' \\
  -F 'audio=@speech.wav;type=audio/wav'`;

const SAM_STREAM_PY = `import os

from openai import OpenAI

client = OpenAI(base_url="https://api.meta.ai/v1", api_key=os.environ["MODEL_API_KEY"])

output = ""
with client.responses.stream(
    model="sam-3.1",
    input=[{"type": "message", "role": "user", "content": [
        {"type": "input_text", "text": "dog"},  # one short noun phrase
        {"type": "input_image", "image_url": "https://example.com/street.jpg"},  # or a data: URL
    ]}],
    metadata={"mask_encoding": "one_bit", "include_confidence": "true"},
) as stream:
    for event in stream:
        if event.type in ("error", "response.failed"):
            raise RuntimeError(f"SAM failed: {event}")  # a failure under HTTP 200, not zero matches
        if event.type == "response.output_text.delta":
            output += event.delta  # one line per frame
if not output:
    print("No matches: a valid result.")
for line in output.splitlines():
    print(line[:160])  # <0f>0<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..;c=..|><|mask;...|>,1<|box;...`;

const SAM_PARSER_TS = `import OpenAI from "openai";
import { parseImageStream, recordsOfKind, decodeMaskToRaster } from "@meta-sam/parser";

const client = new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey: process.env.MODEL_API_KEY });

const events = await client.responses.create({
  model: "sam-3.1",
  input: [
    { type: "message", role: "user", content: [
        { type: "input_text", text: "dog" },
        { type: "input_image", image_url: "https://example.com/street.jpg" },
    ]},
  ],
  stream: true,
  metadata: { mask_encoding: "one_bit" },
});

const result = await parseImageStream(events).finalResult; // throws on an error event or response.failed
if (result.outcome.status !== "completed") console.warn("Ended early:", result.outcome);
for (const box of recordsOfKind(result.records, "box")) console.log(box.objectId, box.left, box.top, box.right, box.bottom);
for (const record of recordsOfKind(result.records, "mask")) {
  const raster = decodeMaskToRaster(record.mask); // Uint8Array of 0 or 1, width * height, row-major
  console.log(record.objectId, record.bounds, raster.length);
}`;

const SAM_CURL = `curl -N -X POST "https://api.meta.ai/v1/responses" \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Accept: text/event-stream" \\
  -d '{
  "model": "sam-3.1",
  "input": [{ "type": "message", "role": "user", "content": [
    { "type": "input_text", "text": "dog" },
    { "type": "input_image", "image_url": "https://example.com/street.jpg" }
  ]}],
  "stream": true,
  "metadata": { "mask_encoding": "one_bit" }
}'`;

/** For SAM prompts: a failure that arrives inside a streamed reply (checked on Oct 30, 2026). */
const SAM_STREAM_FAILURE = "A stream can also fail after HTTP 200 (an error event, then response.failed): a failure, not zero matches.";

// ---- Presets ---------------------------------------------------------------------------------------------------------

const DICTATION_KEYWORDS = ["Muse Voice Transcribe", "Acme Mobile", "eSIM", "5G", "Anaya", "Kolkata"];
const CHESS_KEYWORDS = ["pawn", "e4", "knight", "f3", "bishop", "c4", "castle", "kingside"];

/** Dog boxes on the street photo (1280 x 853) and the clip (1280 x 720), from SAM's own answers on Oct 30, 2026. */
const STREET_DOG_BOX = { x1: 186, y1: 587, x2: 392, y2: 834 };
const CLIP_DOG_F30 = { x1: 434, y1: 551, x2: 648, y2: 719 };
const CLIP_DOG_F60 = { x1: 352, y1: 550, x2: 566, y2: 719 };
const CLIP_DOG_F90 = { x1: 273, y1: 551, x2: 486, y2: 719 };

/** A point prompt on the street photo whose w and h give a 16:9 frame: the photo is 1280 x 853. */
const WRONG_ASPECT = "<0f>1<|point;x=100;y=100;w=1280;h=720|>";

export const voiceSamDemos: DemoMap = {
  "speech-to-text": demo<TranscribeLabProps>({
    title: "Transcribe a recording, or stream it live",
    blurb:
      "Transcribe sends the clip to POST /v1/asr/transcribe with the mode, biasing and reply format you pick; Realtime streams it over the WebSocket and shows partials and finished turns as they arrive. Under a cent a clip ($0.18 an hour of audio).",
    Component: TranscribeLab,
    props: {
      endpoints: ["transcribe", "realtime"],
      sampleId: "speech-paragraph",
      presets: [
        {
          label: "Dictation with keywords",
          endpoint: "transcribe",
          sampleId: "speech-paragraph",
          mode: "PUSH_TO_TALK",
          accept: "json",
          keywords: DICTATION_KEYWORDS,
          note: 'Vocabulary biasing: with these keywords our test got "Muse Voice Transcribe", "Anaya" and "Kolkata" right. Try the next preset to hear the difference.',
        },
        {
          label: "Same clip, no keywords",
          endpoint: "transcribe",
          sampleId: "speech-paragraph",
          mode: "PUSH_TO_TALK",
          accept: "json",
          note: 'Without biasing our runs heard "use voice transcribe" and "Calcutta", and names like Anaya can come out differently from run to run.',
        },
        {
          label: "Two speakers (DIARIZATION)",
          endpoint: "transcribe",
          sampleId: "two-voices",
          mode: "DIARIZATION",
          accept: "json",
          note: "Each turn comes back with startMs, endMs and a speaker label. Labels are session-scoped, not names.",
        },
        {
          label: "Speech turns as events",
          endpoint: "transcribe",
          sampleId: "chess-moves",
          mode: "ENDPOINTING",
          accept: "sse",
          keywords: CHESS_KEYWORDS,
          note: "Watch speechStart, the partials, speechEnd and then speechComplete with the cleaned-up text, keyed by turnId.",
        },
        {
          label: "DELTA partials, no progress",
          endpoint: "transcribe",
          sampleId: "chess-moves",
          mode: "PUSH_TO_TALK",
          accept: "sse",
          partialMode: "DELTA",
          emitAudioProgress: false,
          keywords: CHESS_KEYWORDS,
          note: "Each partial carries only the new words; the final: true event still holds the whole transcript.",
        },
        {
          label: "Plain text by speaker",
          endpoint: "transcribe",
          sampleId: "two-voices",
          mode: "DIARIZATION",
          accept: "text",
          note: "Accept: text/plain gives lines like A:Hello.",
        },
        {
          label: "Live captions (realtime)",
          endpoint: "realtime",
          sampleId: "speech-paragraph",
          mode: "PUSH_TO_TALK",
          keywords: DICTATION_KEYWORDS,
          note: "The audio streams at real-time pace, so this takes about 15 s. Partials replace each other until final: true.",
        },
        { label: "Realtime with speakers", endpoint: "realtime", sampleId: "two-voices", mode: "DIARIZATION", note: "About 25 s: speaker events arrive while each turn is open." },
      ],
    },
    agentPrompt: {
      task: 'Add speech-to-text to my app with Muse Voice Transcribe. First uploads, as in the starter code: POST /v1/asr/transcribe with a mono 16-bit PCM WAV, the PUSH_TO_TALK, ENDPOINTING and DIARIZATION modes, keywords and languageBias. Then live microphone audio over the realtime WebSocket, following the page\'s "Transcribe a microphone" quickstart: partials that update in place, then each finished turn.',
      facts: [
        'Upload: multipart, a request part (JSON: model "muse-voice-transcribe-1.0" and audioEncoding "WAV" required) and an audio part (RIFF/WAVE mono 16-bit PCM, 16 or 24 kHz, at most 32 MB and 10 minutes).',
        "Accept picks the reply: application/json (default), text/event-stream or text/plain; others get 406. transcript is always set; turns can be empty.",
        'Realtime: wss://api.meta.ai/v1/asr/realtime. Put the key in the first text frame (authorization.accessToken "Bearer <key>") within 10 s, wait for {sessionId}, stream PCM_16KHZ or PCM_24KHZ binary frames at real-time pace, send {"type":"endStream"}, read until close 1000.',
        "PUSH_TO_TALK completes on final: true; ENDPOINTING and DIARIZATION complete each turn with speechComplete, keyed by turnId (partials carry none). CUMULATIVE partials replace the last; DELTA ones append.",
      ],
      checklist: [
        "Transcribing a short WAV prints the transcript and audioDurationMs.",
        "DIARIZATION on a two-person clip prints turns with speaker labels, or says turns came back empty.",
        "The realtime client shows partials replacing each other, then the final text, and closes with 1000.",
      ],
      snippets: { python: TRANSCRIBE_PY, typescript: TRANSCRIBE_TS, curl: TRANSCRIBE_CURL },
    },
  }),

  "api-reference/voice": demo<TranscribeLabProps>({
    title: "Call both Voice endpoints",
    blurb:
      "Transcribe posts the clip to /v1/asr/transcribe and shows the request and reply as they went over the wire; switch to Realtime to stream it over the WebSocket through Muse Muse's relay and watch every frame. Under a cent a clip.",
    Component: TranscribeLab,
    props: {
      endpoints: ["transcribe", "realtime"],
      sampleId: "chess-moves",
      view: "reference",
      keywords: CHESS_KEYWORDS,
      presets: [
        { label: "A recording, one JSON reply", endpoint: "transcribe", sampleId: "chess-moves", mode: "PUSH_TO_TALK", accept: "json", keywords: CHESS_KEYWORDS },
        { label: "A recording as events", endpoint: "transcribe", sampleId: "chess-moves", mode: "ENDPOINTING", accept: "sse", keywords: CHESS_KEYWORDS },
        { label: "Two speakers", endpoint: "transcribe", sampleId: "two-voices", mode: "DIARIZATION", accept: "json" },
        { label: "Live audio (realtime)", endpoint: "realtime", sampleId: "chess-moves", mode: "ENDPOINTING", keywords: CHESS_KEYWORDS },
      ],
    },
    agentPrompt: {
      task: "Add a small Voice API client module to my project, typed with the Voice schemas page: transcribe(file, options), which posts the two-part multipart request to POST /v1/asr/transcribe and returns the parsed TranscribeResponse (start from the starter code), and realtime(audio, options), which opens wss://api.meta.ai/v1/asr/realtime, sends the handshake, streams PCM at real-time pace and yields each server event (start from the Python example on https://dev.meta.ai/docs/api-reference/voice/realtime.md).",
      facts: [
        "transcribe authenticates with the Authorization header; realtime ignores that header and takes the key in its handshake frame's authorization.accessToken.",
        'Both run muse-voice-transcribe-1.0 with the same modes (PUSH_TO_TALK default, ENDPOINTING, DIARIZATION), keywords and languageBias. transcribe needs audioEncoding "WAV"; the handshake needs PCM_24KHZ or PCM_16KHZ.',
        "sessionId is an optional query parameter on both, echoed back for log correlation.",
        "Both share one rate budget: 256 concurrent streams and 16,000 streams an hour per team. transcribe answers 429; realtime closes with 1013.",
      ],
      checklist: [
        "transcribe() on a WAV returns an object with transcript, turns, audioDurationMs and sessionId.",
        "realtime() yields speechStart, transcript and speechComplete events and finishes when the socket closes with 1000.",
      ],
      snippets: { python: TRANSCRIBE_PY, typescript: TRANSCRIBE_TS, curl: TRANSCRIBE_CURL },
    },
  }),

  "api-reference/voice/transcribe": demo<TranscribeLabProps>({
    title: "POST /v1/asr/transcribe in each reply format",
    blurb:
      "Transcribe sends the two-part multipart request (a request JSON part and the WAV) with your Accept header and sessionId, and prints the request and the reply exactly as they went over the wire. Under a cent a clip; the error presets are free.",
    Component: TranscribeLab,
    props: {
      endpoints: ["transcribe"],
      sampleId: "speech-paragraph",
      view: "reference",
      microphone: true,
      presets: [
        { label: "application/json", sampleId: "speech-paragraph", mode: "PUSH_TO_TALK", accept: "json", keywords: DICTATION_KEYWORDS },
        { label: "text/event-stream", sampleId: "chess-moves", mode: "ENDPOINTING", accept: "sse", keywords: CHESS_KEYWORDS },
        { label: "text/plain (DIARIZATION)", sampleId: "two-voices", mode: "DIARIZATION", accept: "text" },
        {
          label: "With a sessionId",
          sampleId: "chess-moves",
          mode: "PUSH_TO_TALK",
          accept: "json",
          sessionId: "my-session-id",
          note: "The reply echoes the sessionId you passed. Without one the server makes its own.",
        },
        {
          label: "406: an unsupported Accept",
          group: "Errors",
          sampleId: "chess-moves",
          accept: "json",
          acceptOverride: "application/xml",
          note: "Meta answers 406 with its error envelope and the sessionId.",
        },
        {
          label: "400: no audioEncoding",
          group: "Errors",
          sampleId: "chess-moves",
          accept: "json",
          requestOverride: { model: "muse-voice-transcribe-1.0", mode: "PUSH_TO_TALK" },
          note: "audioEncoding has no default: the error names it in param.",
        },
        {
          label: "400: an unknown mode",
          group: "Errors",
          sampleId: "chess-moves",
          accept: "json",
          requestOverride: { model: "muse-voice-transcribe-1.0", audioEncoding: "WAV", mode: "SHOUTING" },
        },
      ],
    },
    agentPrompt: {
      task: "Call POST /v1/asr/transcribe from my project as its API reference specifies: send multipart/form-data with a request JSON part and an audio WAV part, pass an optional sessionId query parameter, choose the reply with the Accept header, and handle every documented status, including a terminal error event on a stream.",
      facts: [
        'request part: model and audioEncoding ("WAV", no default) are required; mode, keywords, languageBias optional; partialMode and emitAudioProgress change text/event-stream replies only. audio part: RIFF/WAVE, mono integer PCM, 16 or 24 kHz.',
        "Accept application/json, */* or none: {sessionId, transcript, audioDurationMs, turns}. text/event-stream: realtime events, no summary at the end. text/plain: a turn per line, or A:Hello lines in DIARIZATION (unknown:<text> when unattributed). Other values: 406.",
        "400: not a supported WAV, over 10 minutes, not multipart, or a bad request part. 413: over 32 MB. 429: back off exponentially. 500: failed or over budget; once a stream has started it arrives as a terminal error event under HTTP 200.",
        "Errors have type, and code and param when set, plus sessionId: log it, it's the support handle.",
      ],
      checklist: [
        "The same clip transcribes with all three Accept values.",
        "A request without audioEncoding surfaces the 400 message and param audioEncoding.",
        "An event-stream run stops on an error event instead of hanging.",
      ],
      snippets: { python: TRANSCRIBE_PY, typescript: TRANSCRIBE_TS, curl: TRANSCRIBE_CURL },
    },
  }),

  "api-reference/voice/realtime": demo<TranscribeLabProps>({
    title: "Run a realtime session and read every frame",
    blurb:
      "Stream it sends the clip through Muse Muse's relay to wss://api.meta.ai/v1/asr/realtime at real-time pace and shows the handshake, every server frame and the close code as they happen. Under a cent a clip.",
    Component: TranscribeLab,
    props: {
      endpoints: ["realtime"],
      sampleId: "chess-moves",
      mode: "ENDPOINTING",
      keywords: CHESS_KEYWORDS,
      view: "reference",
      presets: [
        { label: "ENDPOINTING: turns", sampleId: "chess-moves", mode: "ENDPOINTING", keywords: CHESS_KEYWORDS, note: "speechStart, partials, speechEnd, then speechComplete per turnId." },
        { label: "PUSH_TO_TALK: final", sampleId: "chess-moves", mode: "PUSH_TO_TALK", keywords: CHESS_KEYWORDS, note: "Completion is the transcript event with final: true." },
        { label: "DELTA partials", sampleId: "chess-moves", mode: "PUSH_TO_TALK", partialMode: "DELTA", keywords: CHESS_KEYWORDS, note: "Each partial is only the new text." },
        { label: "DIARIZATION: speakers", sampleId: "two-voices", mode: "DIARIZATION", note: "About 25 s. A speaker event labels the span behind it." },
      ],
    },
    agentPrompt: {
      task: 'Write a realtime transcription client for wss://api.meta.ai/v1/asr/realtime in my project: the handshake first (the key in authorization.accessToken), then the acknowledgement, mono 16-bit PCM at real-time pace, {"type":"endStream"}, and events until the server closes; act on the close code.',
      facts: [
        'Handshake, the first text frame, within 10 s (the Authorization header is ignored): authorization.accessToken "Bearer <key>", audioEncoding PCM_24KHZ or PCM_16KHZ (required), model; optional mode, partialMode, emitAudioProgress, keywords, languageBias.',
        "The acknowledgement {sessionId} is the only frame without a type. Pace audio at real time, at most 5 s ahead.",
        "After endStream send nothing and keep reading: closing the socket yourself can drop pending events. No resume after 60 minutes.",
        "Close codes: 1000 done; 1008 bad request or pacing, don't retry unchanged; 1011 retry with backoff (a new session on Max session duration reached); 1013 rate limited, back off.",
      ],
      checklist: [
        "A 10 s WAV streams in about 10 s and prints each speechComplete turn.",
        "The sessionId from the acknowledgement and the close code are logged.",
        "An error event's message and sessionId are logged.",
      ],
      snippets: { python: REALTIME_PY, typescript: REALTIME_TS, curl: REALTIME_CURL },
    },
  }),

  "api-reference/voice/schemas": demo<VoiceSchemaExplorerProps>({
    title: "Explore and check the Voice schemas",
    blurb:
      "Browse every schema and field, paste messages to see which schema each one is and how it checks, or run a real event stream and check every event Meta sends as it arrives (under a cent).",
    Component: VoiceSchemaExplorer,
    props: { schemaId: "TranscribeRequest", sampleId: "chess-moves", mode: "ENDPOINTING" },
    agentPrompt: {
      task: "Add types and runtime validation for the Voice API to my project from this schemas page: TranscribeRequest and RealtimeHandshakeRequest for what I send, TranscribeResponse and Turn for what I read, and the ServerMessage union for events. Dispatch events on type, treat the type-less handshake acknowledgement separately, and skip unknown event types.",
      facts: [
        'Enums go as names: audioEncoding "WAV" (transcribe) or PCM_24KHZ / PCM_16KHZ (handshake); mode PUSH_TO_TALK (default), ENDPOINTING or DIARIZATION; partialMode CUMULATIVE (default) or DELTA.',
        "ServerMessage by type: transcript {transcript, final}, speechStart and speechEnd {turnId}, speechComplete {turnId, transcript}, speaker {label}, audioProgress, all with audioProcessedMs; error {message, sessionId, errorType?, errorCode?, errorParam?}.",
        "Turn: turnId, startMs, endMs, transcript required; speaker only in DIARIZATION. turns is empty in PUSH_TO_TALK; a turn can carry an empty transcript.",
        "audioProcessedMs is processing progress, not a word timestamp.",
      ],
      checklist: [
        "A recorded event stream validates with no failures, and an unknown type is logged and skipped.",
        "TypeScript makes speaker optional and errorType, errorCode and errorParam optional.",
      ],
      snippets: {
        typescript: `type VoiceMode = "PUSH_TO_TALK" | "ENDPOINTING" | "DIARIZATION";
interface TranscribeRequest {
  model: string;
  audioEncoding: "WAV";
  mode?: VoiceMode;
  keywords?: string[];
  languageBias?: string[];
  partialMode?: "CUMULATIVE" | "DELTA"; // event streams only
  emitAudioProgress?: boolean; // event streams only, default true
}
interface Turn { turnId: number; startMs: number; endMs: number; transcript: string; speaker?: string }
interface TranscribeResponse { sessionId: string; transcript: string; audioDurationMs: number; turns: Turn[] }

type ServerMessage =
  | { type: "transcript"; transcript: string; final: boolean; audioProcessedMs: number }
  | { type: "speechStart" | "speechEnd"; turnId: number; audioProcessedMs: number }
  | { type: "speechComplete"; turnId: number; transcript: string; audioProcessedMs: number }
  | { type: "speaker"; label: string; audioProcessedMs: number }
  | { type: "audioProgress"; audioProcessedMs: number }
  | { type: "error"; message: string; sessionId: string; errorType?: string; errorCode?: string; errorParam?: string };

const KNOWN = new Set(["transcript", "speechStart", "speechEnd", "speechComplete", "speaker", "audioProgress", "error"]);
export function readEvent(raw: string): ServerMessage | { sessionId: string } | null {
  const v = JSON.parse(raw);
  if (!("type" in v)) return v; // the handshake acknowledgement
  return KNOWN.has(v.type) ? v : null; // skip unknown types
}`,
        python: `from typing import List, Literal, Optional, TypedDict  # Python 3.9+

Mode = Literal["PUSH_TO_TALK", "ENDPOINTING", "DIARIZATION"]

class _Required(TypedDict):
    model: str
    audioEncoding: Literal["WAV"]

class TranscribeRequest(_Required, total=False):  # model and audioEncoding required, the rest optional
    mode: Mode
    keywords: List[str]
    languageBias: List[str]
    partialMode: Literal["CUMULATIVE", "DELTA"]  # event streams only
    emitAudioProgress: bool  # event streams only, default True

class _Turn(TypedDict):
    turnId: int
    startMs: int
    endMs: int
    transcript: str

class Turn(_Turn, total=False):
    speaker: str  # DIARIZATION only

class TranscribeResponse(TypedDict):
    sessionId: str
    transcript: str
    audioDurationMs: int
    turns: List[Turn]  # empty in PUSH_TO_TALK

KNOWN = {"transcript", "speechStart", "speechEnd", "speechComplete", "speaker", "audioProgress", "error"}

def read_event(event: dict) -> Optional[dict]:
    if "type" not in event:
        return event  # the handshake acknowledgement: {"sessionId": ...}
    return event if event["type"] in KNOWN else None  # skip unknown types`,
        curl: `# Real messages to test the types against: an event stream (ServerMessage) and a JSON reply (TranscribeResponse).
curl --fail-with-body -N 'https://api.meta.ai/v1/asr/transcribe' \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -H 'Accept: text/event-stream' \\
  -F 'request={"model":"muse-voice-transcribe-1.0","audioEncoding":"WAV","mode":"ENDPOINTING"};type=application/json' \\
  -F 'audio=@speech.wav;type=audio/wav' > events.sse

curl --fail-with-body 'https://api.meta.ai/v1/asr/transcribe' \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -F 'request={"model":"muse-voice-transcribe-1.0","audioEncoding":"WAV","mode":"DIARIZATION"};type=application/json' \\
  -F 'audio=@speech.wav;type=audio/wav' > reply.json`,
      },
    },
  }),

  "media-segmentation": demo<SegmentLabProps>({
    title: "Find and cut out objects in a photo or a clip",
    blurb:
      "Segment sends the media and a noun phrase to sam-3.1 and draws every match's box and mask, then cuts the objects out, blurs around them or measures them. $0.0025 an image; the 5 s clip is 120 frames, $0.024.",
    Component: SegmentLab,
    props: {
      media: ["image", "video"],
      sampleId: "street",
      videoSampleId: "street-pan",
      prompt: "dog",
      kinds: ["concept"],
      panels: ["useCases", "tracks"],
      pairWithSpark: true,
      presets: [
        { label: "Dogs on the street", media: "image", sampleId: "street", kind: "concept", prompt: "dog" },
        { label: "Count the people", media: "image", sampleId: "street", kind: "concept", prompt: "person", note: "Measure and count lists every instance with its area." },
        { label: "Bicycles to cut out", media: "image", sampleId: "street", kind: "concept", prompt: "bicycle" },
        { label: "A cat to keep sharp", media: "image", sampleId: "cat-sofa", kind: "concept", prompt: "cat", note: "Pick Blur the background under the result." },
        { label: "Track the dogs in the clip", media: "video", sampleId: "street-pan", kind: "concept", prompt: "dog", note: "SAM follows each match across frames under one id." },
        { label: "Nothing to find", media: "image", sampleId: "street", kind: "concept", prompt: "yellow school bus", note: "Zero matches is a normal result: an empty output_text." },
      ],
    },
    agentPrompt: {
      task: "Add object cut-outs to my app with SAM 3.1: send an image and a short noun phrase to the Responses API on sam-3.1, stream the result, parse every match's box and mask, and use the masks to cut the object out on a transparent background (or blur everything else).",
      facts: [
        "POST https://api.meta.ai/v1/responses, model sam-3.1, one user message: an input_text with one short noun phrase (one concept per request) and an input_image (image_url: a URL or a data URL) or input_video (video_url or file_id).",
        `With stream: true each response.output_text.delta is one line per frame: <0f>id<|box;x1;y1;x2;y2;w;h|><|mask;x=0;y=0;data=H,W,~payload|>, records comma-separated. Zero matches is an empty output_text. ${SAM_STREAM_FAILURE}`,
        'Decode masks with decodeMaskToRaster from @meta-sam/parser: an H x W raster of 0 and 1 that sits on the box (x2, y2 inclusive). metadata {"mask_encoding": "one_bit"} makes payloads smaller.',
        "For a caption or a question about the scene use Muse Spark; SAM returns geometry only. $2.50 per 1,000 images; video $0.20 per 1,000 frames.",
      ],
      checklist: [
        "A photo and a phrase that's in it give at least one box and a mask whose raster length is H x W.",
        "The cut-out keeps only mask pixels; a phrase that isn't there returns no records and no error.",
      ],
      snippets: { typescript: SAM_PARSER_TS, python: SAM_STREAM_PY, curl: SAM_CURL },
    },
  }),

  "sam/overview": demo<SegmentLabProps>({
    title: "See a SAM request and its response, part by part",
    blurb:
      "Segment sends sam-3.1 one user message (a noun phrase and the media) and breaks the streamed reply into its events, frame lines, object ids, boxes and masks. $0.0025 an image; the clip is $0.024.",
    Component: SegmentLab,
    props: {
      media: ["image", "video"],
      sampleId: "street",
      prompt: "dog",
      kinds: ["concept"],
      panels: ["anatomy", "tracks"],
      showRaw: true,
      presets: [
        { label: "An image, streamed", media: "image", sampleId: "street", kind: "concept", prompt: "dog" },
        {
          label: "Zero matches",
          media: "image",
          sampleId: "street",
          kind: "concept",
          prompt: "yellow school bus",
          note: "The page's own example phrase, on a street with no bus: the stream completes with an empty output_text.",
        },
        { label: "Not streamed", media: "image", sampleId: "street", kind: "concept", prompt: "bicycle", stream: false, note: "Same format, returned in one response." },
        {
          label: "Lossless masks, no confidence",
          media: "image",
          sampleId: "street",
          kind: "concept",
          prompt: "dog",
          maskEncoding: "lossless",
          includeConfidence: false,
          note: "Without metadata the masks are lossless (~) and boxes carry no c.",
        },
        { label: "A clip: one line per frame", media: "video", sampleId: "street-pan", kind: "concept", prompt: "dog" },
      ],
    },
    agentPrompt: {
      task: "Make a first end-to-end SAM 3.1 call from my project: POST /v1/responses with model sam-3.1, one user message holding an input_text noun phrase and an input_image, and stream: true; then parse the streamed output with @meta-sam/parser (parseImageStream, recordsOfKind, decodeMaskToRaster) and print each object's id, box and mask size.",
      facts: [
        "Same base URL and Bearer key as the rest of the API. Video goes in an input_video part: MP4 or MOV with H.264, H.265 or MPEG-4.",
        "The result streams in the output_text lane as special-token text, one line per frame, and the stream ends on response.completed. Streaming is recommended for video, not required.",
        "<0f> is the frame, the leading integer the object id (stable across frames), then one box and one mask; ~ marks a lossless mask payload, ! one_bit.",
        `Zero matches completes with an empty output_text: branch on it. ${SAM_STREAM_FAILURE} usage reports images_processed or video_frames_processed, not tokens.`,
      ],
      checklist: [
        "The call prints one line per detected object with its id, its box and its mask's H x W.",
        "A phrase that isn't in the image prints a no-matches message instead of failing.",
      ],
      snippets: { typescript: SAM_PARSER_TS, python: SAM_STREAM_PY, curl: SAM_CURL },
    },
  }),

  "sam/segmenting": demo<SegmentLabProps>({
    title: "Prompt SAM with words, boxes and points",
    blurb:
      "Segment runs the prompt on sam-3.1 and draws what comes back: concepts and the rules that shape them, boxes and points on the photo, prompts on several clip frames with a tracking direction, an upload referenced by file_id, and requests the API rejects. $0.0025 an image, up to $0.024 a clip.",
    Component: SegmentLab,
    props: {
      media: ["image", "video"],
      sampleId: "street",
      videoSampleId: "street-pan",
      prompt: "dog",
      kinds: ["concept", "objects", "text"],
      upload: true,
      panels: ["rules", "tracks"],
      presets: [
        { label: "dog", group: "Concepts", media: "image", sampleId: "street", kind: "concept", prompt: "dog" },
        { label: "golden retriever", group: "Concepts", media: "image", sampleId: "street", kind: "concept", prompt: "golden retriever", note: "An attribute narrows the matches." },
        { label: "dog, bicycle", group: "Concepts", media: "image", sampleId: "street", kind: "concept", prompt: "dog, bicycle", note: "A list returns zero matches: one concept per request." },
        { label: "segment the dog", group: "Concepts", media: "image", sampleId: "street", kind: "concept", prompt: "segment the dog", note: "Commands are unreliable: name the object instead." },
        {
          label: "A box and a point",
          group: "Boxes and points",
          media: "image",
          sampleId: "street",
          kind: "objects",
          objects: [
            { id: 1, frame: 0, box: STREET_DOG_BOX },
            { id: 2, frame: 0, points: [{ x: 496, y: 690 }, { x: 700, y: 300, negative: true }] },
          ],
          note: "Object 1 by its box, object 2 by a point and a negative point. Each comes back under the id you gave it.",
        },
        {
          label: "Raw prompt text",
          group: "Boxes and points",
          media: "image",
          sampleId: "street",
          kind: "text",
          prompt: "<0f>1<|box;x1=186;y1=587;x2=392;y2=834;w=1280;h=853|>,2<|point;x=496;y=690;w=1280;h=853|>-<|point;x=700;y=300;w=1280;h=853|>",
        },
        {
          label: "Two frames, forward",
          group: "Video",
          media: "video",
          sampleId: "street-pan",
          kind: "objects",
          propagation: "forward",
          objects: [
            { id: 1, frame: 30, box: CLIP_DOG_F30 },
            { id: 2, frame: 60, points: [{ x: 200, y: 640 }] },
            { id: 1, frame: 90, box: CLIP_DOG_F90 },
          ],
          note: "Object 1 prompted on frames 30 and 90, object 2 on 60: tracked from frame 30 to the end, 90 frames ($0.018).",
        },
        {
          label: "Backward from frame 60",
          group: "Video",
          media: "video",
          sampleId: "street-pan",
          kind: "objects",
          propagation: "backward",
          objects: [{ id: 1, frame: 60, box: CLIP_DOG_F60 }],
          note: "Frames 60 down to 0: 61 frames ($0.012).",
        },
        {
          label: "Both ways (default)",
          group: "Video",
          media: "video",
          sampleId: "street-pan",
          kind: "objects",
          propagation: "both",
          objects: [{ id: 1, frame: 60, box: CLIP_DOG_F60 }],
          note: "60 to 119 first, then 59 down to 0: key results by the frame marker, not line order.",
        },
        {
          label: "Upload once, use file_id",
          group: "Video",
          media: "video",
          sampleId: "street-pan",
          kind: "objects",
          propagation: "forward",
          send: "file",
          objects: [{ id: 1, frame: 60, box: CLIP_DOG_F60 }],
          note: "Uploads the clip with POST /v1/files once; run it again and only the id is sent (60 frames, $0.012).",
        },
        {
          label: "Not streamed, lossless",
          group: "Options",
          media: "image",
          sampleId: "street",
          kind: "concept",
          prompt: "bicycle",
          stream: false,
          maskEncoding: "lossless",
          includeConfidence: false,
        },
        {
          label: "Phrase plus a box",
          group: "Errors (400)",
          media: "image",
          sampleId: "street",
          kind: "text",
          prompt: "dog <0f>1<|box;x1=186;y1=587;x2=392;y2=834;w=1280;h=853|>",
        },
        { label: "Point outside", group: "Errors (400)", media: "image", sampleId: "street", kind: "text", prompt: "<0f>1<|point;x=1300;y=100;w=1280;h=853|>" },
        { label: "Image prompt on frame 5", group: "Errors (400)", media: "image", sampleId: "street", kind: "text", prompt: "<5f>1<|point;x=100;y=100;w=1280;h=853|>" },
        { label: 'include_confidence "yes"', group: "Errors (400)", media: "image", sampleId: "street", kind: "concept", prompt: "dog", metadata: { include_confidence: "yes" } },
        {
          label: "Wrong aspect ratio, not streamed",
          group: "Errors (400)",
          media: "image",
          sampleId: "street",
          kind: "text",
          prompt: WRONG_ASPECT,
          stream: false,
          note: "w=1280;h=720 on a 1280 x 853 photo. Unstreamed, the API answers 400 with the message.",
        },
        {
          label: "Wrong aspect ratio, streamed",
          group: "Errors inside a stream (HTTP 200)",
          media: "image",
          sampleId: "street",
          kind: "text",
          prompt: WRONG_ASPECT,
          note: "The same request streamed: the aspect ratio is checked against the image after the stream has started, so it comes back HTTP 200, then an error event and response.failed. Handle both events; an empty output here is a failure, not zero matches.",
        },
      ],
    },
    agentPrompt: {
      task: "Add click-to-segment to my app with SAM 3.1: let a user drag a box or click points (positive or negative) on an image or video frame, convert them to media pixels, build the prompt text (or use buildObjectPrompt from @meta-sam/parser), send it with the media on sam-3.1, and track objects through a video with metadata.propagation_direction.",
      facts: [
        "Grammar: <Nf> opens a frame, then comma-separated objects: an id, one <|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..|> (x2, y2 inclusive) and/or <|point;x=..;y=..;w=..;h=..|> points, - before a negative one. Never with a phrase.",
        "Send media pixels, with w and h the displayed size: (100, 50) on a 640x360 preview of 1920x1080 is (300, 150).",
        'metadata values are strings: include_confidence "true", mask_encoding "one_bit" (default lossless), propagation_direction both (default), forward or backward.',
        "Bad prompts get a 400 naming the problem. Streamed, a w, h of another aspect ratio fails after HTTP 200 instead: an error event, then response.failed.",
      ],
      checklist: [
        "A box drawn on a scaled preview comes back under its id, inside the object.",
        "Forward from a prompt on frame 30 returns frames 30 onward only.",
        "A rejected prompt shows the API's message, from a 400 or a stream's error event.",
      ],
      snippets: {
        typescript: `import OpenAI from "openai";
import { buildObjectPrompt } from "@meta-sam/parser";

const text = buildObjectPrompt({
  size: { width: 1280, height: 720 }, // media pixels; half-open boxes
  objects: [
    { id: 1, prompts: [{ frame: 30, box: { left: 434, top: 551, right: 649, bottom: 720 } }] },
    { id: 2, prompts: [{ frame: 60, points: [{ x: 200, y: 640 }, { x: 900, y: 200, label: "negative" }] }] },
  ],
});

const client = new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey: process.env.MODEL_API_KEY });
const stream = await client.responses.create({
  model: "sam-3.1",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text }, { type: "input_video", file_id: "file-abc123" }] }],
  stream: true,
  metadata: { propagation_direction: "forward", mask_encoding: "one_bit" },
});
for await (const event of stream) {
  if (event.type === "error" || event.type === "response.failed") throw new Error(JSON.stringify(event));
  if (event.type === "response.output_text.delta") process.stdout.write(event.delta);
}`,
        python: `import os

from openai import OpenAI

client = OpenAI(base_url="https://api.meta.ai/v1", api_key=os.environ["MODEL_API_KEY"])

# Object 1: a box on frame 30. Object 2: a point and a negative one on frame 60.
text = (
    "<30f>1<|box;x1=434;y1=551;x2=648;y2=719;w=1280;h=720|>"
    "<60f>2<|point;x=200;y=640;w=1280;h=720|>-<|point;x=900;y=200;w=1280;h=720|>"
)

with client.responses.stream(
    model="sam-3.1",
    input=[{"type": "message", "role": "user", "content": [
        {"type": "input_text", "text": text},
        {"type": "input_video", "file_id": "file-abc123"},  # from POST /v1/files, purpose user_data
    ]}],
    metadata={"propagation_direction": "forward", "include_confidence": "true"},
) as stream:
    for event in stream:
        if event.type in ("error", "response.failed"):
            raise RuntimeError(f"SAM failed: {event}")  # a failure under HTTP 200
        if event.type == "response.output_text.delta":
            print(event.delta, end="")  # one line per frame`,
        curl: `curl -N -X POST "https://api.meta.ai/v1/responses" \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Accept: text/event-stream" \\
  -d '{
  "model": "sam-3.1",
  "input": [{ "type": "message", "role": "user", "content": [
    { "type": "input_text", "text": "<30f>1<|point;x=585;y=366;w=960;h=540|><75f>2<|box;x1=405;y1=337;x2=516;y2=420;w=960;h=540|>" },
    { "type": "input_video", "file_id": "file-abc123" }
  ]}],
  "stream": true,
  "metadata": { "propagation_direction": "forward" }
}'`,
      },
    },
  }),

  "sam/reading-segmentation": demo<WireInspectorProps>({
    title: "Read SAM's wire format, line by line",
    blurb:
      "Pick one of the page's examples, paste your own output, or run SAM live ($0.0025 an image), and see each line's frame marker, object ids, boxes, confidence and masks parsed and decoded beside the raw text.",
    Component: WireInspector,
    props: { source: "examples", sampleId: "street", videoSampleId: "street-pan", prompt: "dog" },
    agentPrompt: {
      task: "Write a parser for SAM 3.1's output text in my project, without a library: split output_text into lines, read each line's <Nf> frame marker and comma-separated records (an id, a box token, a mask token), parse fields by key so the optional c works, and key results by frame and object id. Decode masks with decodeMaskToRaster from @meta-sam/parser.",
      facts: [
        "line ::= <N f> record (, record)*; record ::= id <|box;x1=;y1=;x2=;y2=;w=;h=[;c=]|><|mask;x=0;y=0[;c=];data=H,W,ENC payload|>. Box corners are source pixels, x2 and y2 inclusive.",
        "data is H,W height first, then one encoding character: ~ lossless (default) or ! one_bit. The payload is base85, not base64, and can hold ~, ! or =: only the first character after H,W, is the marker.",
        "Frames can skip (no line when nothing is visible) and arrive out of order (box and point prompts with both go forward, then backward): read the marker, not the line index. Ids are stable per object and sparse.",
        "c (include_confidence) follows h on the box and sits between y and data on the mask, the same value on both. Zero matches: no lines.",
      ],
      checklist: [
        "The page's video line parses into ids 0 and 1 on frame 0, boxes 211,228 to 270,254 and 155,228 to 202,254, masks 27x60 and 27x48, lossless.",
        "A line with c gives the same confidence on box and mask; a malformed line is reported and skipped.",
      ],
      snippets: {
        typescript: `// Split at the first "=": payloads can hold "=" (never ";" or "|").
const fields = (body: string) => Object.fromEntries(body.split(";").slice(1).map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));

export function parseSamText(text: string) {
  const out = [];
  for (const line of text.split("\\n")) {
    const head = /^<(\\d+)f>/.exec(line);
    for (const m of head ? line.slice(head[0].length).matchAll(/,?(\\d+)<\\|(box;[^|]*)\\|><\\|(mask;[^|]*)\\|>/g) : []) {
      const [b, k] = [fields(m[2]), fields(m[3])];
      const d = /^(\\d+),(\\d+),([~!][\\s\\S]*)$/.exec(k.data ?? "");
      if (!d) continue; // malformed: report and skip it
      out.push({
        frame: Number(head![1]), // from the marker, never the line index
        objectId: m[1],
        box: { x1: +b.x1, y1: +b.y1, x2: +b.x2, y2: +b.y2, w: +b.w, h: +b.h, c: b.c ? +b.c : undefined },
        mask: { height: +d[1], width: +d[2], encoding: d[3][0] === "~" ? "lossless" : "one_bit", payload: d[3], c: k.c ? +k.c : undefined },
      });
    }
  }
  return out;
}`,
        python: `import re

TOKEN = re.compile(r",?(\\d+)<\\|(box;[^|]*)\\|><\\|(mask;[^|]*)\\|>")

def fields(body: str) -> dict:
    return dict(kv.split("=", 1) for kv in body.split(";")[1:])  # payloads can hold "=", never ";"

def parse_sam_text(text: str) -> list:
    out = []
    for line in text.splitlines():
        head = re.match(r"<(\\d+)f>", line)
        if not head:
            continue  # empty, or not segmentation
        for object_id, box_body, mask_body in TOKEN.findall(line[head.end():]):
            box = {k: float(v) if k == "c" else int(v) for k, v in fields(box_body).items()}  # x2, y2 inclusive
            mask = fields(mask_body)
            height, width, payload = mask["data"].split(",", 2)
            out.append({"frame": int(head.group(1)), "object_id": object_id, "box": box, "mask": {
                "height": int(height), "width": int(width), "c": mask.get("c"),
                "encoding": "lossless" if payload[0] == "~" else "one_bit", "payload": payload}})
    return out  # decode payloads with decode_mask_to_raster`,
      },
    },
  }),

  "sam/client-libraries": demo<ParserLabProps>({
    title: "Parse, decode and draw with @meta-sam/parser",
    blurb:
      "Stream and parse sends a photo and a noun phrase to sam-3.1 ($0.0025) and feeds the stream to Meta's parser as it arrives; the other tabs decode its masks three ways, draw the overlay, build box and point prompts, and replay the stream outcomes and error codes on recorded streams.",
    Component: ParserLab,
    props: { sampleId: "street", videoSampleId: "street-pan", prompt: "dog", tab: "parse" },
    agentPrompt: {
      task: "Integrate @meta-sam/parser into my project: feed a streamed sam-3.1 response to parseImageStream (parseVideoStream for a clip), render the latest snapshot, check finalResult.outcome and diagnostics, decode masks with decodeMaskToRaster (or decodeMaskToRLE, decodeMaskToSVGPath), and build box and point prompts with buildObjectPrompt.",
      facts: [
        "@meta-sam/parser 0.1.0+: ESM only, Node ^20.17.0 or >=22.9.0, root imports only. Python: meta-sam-parser, the same API in snake_case.",
        "Consume once: iterate snapshots, then read finalResult (or read it alone). A second iterator throws stream_consumed; breaking early rejects finalResult with stream_aborted.",
        "outcome: completed, or incomplete with reason response or eof (records kept). Errors carry stable codes (response_failed, response_error, response_lane, response_refusal, parser_error, source_error, invalid_mask_payload); diagnostics aren't errors.",
        "Parsed boxes are half-open (right = x2 + 1) and go into buildObjectPrompt as is. Without include_confidence, confidence is absent, not 0.",
      ],
      checklist: [
        "A streamed sam-3.1 call logs increasing snapshot revisions, then outcome completed.",
        "Each mask decodes to a Uint8Array of width x height, and its RLE size is [height, width].",
        "buildObjectPrompt with a duplicate id throws ObjectPromptError with code duplicate_object_id.",
      ],
      snippets: {
        typescript: `import OpenAI from "openai";
import { parseImageStream, recordsOfKind, decodeMaskToRaster, decodeMaskToRLE, ResponsesStreamError } from "@meta-sam/parser";

const client = new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey: process.env.MODEL_API_KEY });
const parsed = parseImageStream(await client.responses.create({
  model: "sam-3.1",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "dog" }, { type: "input_image", image_url: "https://example.com/street.jpg" }] }],
  stream: true,
  metadata: { mask_encoding: "one_bit" },
}));
try {
  for await (const s of parsed) console.log(s.revision, s.records.length); // render the latest
  const { outcome, diagnostics, records } = await parsed.finalResult;
  console.log(outcome, diagnostics);
  for (const r of recordsOfKind(records, "mask")) console.log(r.objectId, decodeMaskToRaster(r.mask).length, decodeMaskToRLE(r.mask).size);
} catch (err) {
  if (!(err instanceof ResponsesStreamError)) throw err;
  console.error(err.code, err.message);
}`,
        python: `from meta_sam_parser import FramePrompt, PromptBox, PromptObject, PromptPoint, build_object_prompt

text = build_object_prompt(
    size=(640, 480),  # (width, height), as displayed
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
print(text)  # <30f>1<|box;x1=10;y1=20;x2=39;y2=59;w=640;h=480|><120f>1<|point;...|>-<|point;...|>
# Send it as the input_text of a sam-3.1 request, then parse the stream with meta_sam_parser and
# convert masks with decode_mask_to_raster, decode_mask_to_rle or decode_mask_to_svg_path.`,
      },
    },
  }),
};
