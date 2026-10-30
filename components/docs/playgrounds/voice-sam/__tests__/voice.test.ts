/**
 * The voice demos' logic against real replies captured through the docs proxy on Oct 30, 2026 (fixtures/): the event
 * fold for transcribe event streams and the realtime relay, the text/plain reader, billing, the request builders and
 * the code they hand out, and the schema validator.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/voice-sam/__tests__/voice.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { sseReader, type SseEvent } from "@/lib/docs/client/api";
import {
  billedSeconds,
  cleanText,
  foldVoiceEvents,
  parsePlainTranscript,
  shownTurns,
  transcribeCostUsd,
  voiceText,
} from "@/components/docs/playgrounds/voice-sam/voice-events";
import {
  DEFAULT_VOICE_SETTINGS,
  VOICE_LANGUAGES,
  multipartPreview,
  presetEndpoint,
  realtimeHandshakeFrame,
  realtimeSnippets,
  relayQuery,
  splitList,
  transcribePath,
  transcribeRequestJson,
  transcribeSnippets,
  unknownLanguages,
  type VoiceSettings,
} from "@/components/docs/playgrounds/voice-sam/voice-request";
import { VOICE_SCHEMAS, checkVoiceMessage, identifyVoiceMessage, readMessages, searchSchemas } from "@/components/docs/playgrounds/voice-sam/voice-schemas";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

function events(text: string): SseEvent[] {
  const out: SseEvent[] = [];
  const r = sseReader((e) => out.push(e));
  r.push(text);
  r.end();
  return out;
}

const json = (o: Record<string, unknown>): SseEvent => ({ event: typeof o.type === "string" ? o.type : null, data: JSON.stringify(o), json: o });

const NO_EM = new RegExp(String.fromCharCode(0x2014));
const KEYISH = /\bsk-[A-Za-z0-9]{8}|LLM_\d{6}|DOCS_MODEL_API_KEY|Bearer [A-Za-z0-9_]{12}/;

describe("voice event fold", () => {
  it("reads a real ENDPOINTING stream into one finished turn, ignoring the empty final transcript", () => {
    const view = foldVoiceEvents(events(fixture("transcribe-endpointing.sse")), "ENDPOINTING");
    assert.equal(view.turns.length, 1);
    const [turn] = view.turns;
    assert.equal(turn.turnId, 0);
    assert.equal(turn.transcript, "K23 for 4. Night to F3. Bishop to c4. Castle kingside.");
    assert.equal(turn.startMs, 620);
    assert.equal(turn.endMs, 8700);
    assert.equal(turn.done, true);
    assert.equal(view.partial, "", "speechComplete clears the partial");
    assert.equal(view.finalText, "", "the stream's last event is an empty final: true transcript");
    assert.equal(view.processedMs, 9200);
    assert.equal(view.counts.speechComplete, 1);
    assert.equal(view.counts.audioProgress, 4);
    assert.ok(view.timeline.every((e) => e.type !== "audioProgress"), "progress is counted, not listed");
    assert.equal(voiceText(view), turn.transcript);
  });

  it("appends DELTA partials, then takes final: true as the whole PUSH_TO_TALK transcript", () => {
    const all = events(fixture("transcribe-delta.sse"));
    const mid = foldVoiceEvents(all.slice(0, 3), "PUSH_TO_TALK", "DELTA");
    assert.equal(cleanText(mid.partial), "pawn to e4 knight to");
    const view = foldVoiceEvents(all, "PUSH_TO_TALK", "DELTA");
    assert.deepEqual(
      view.turns.map((t) => [t.turnId, t.transcript, t.done]),
      [[null, "pawn to e4 knight to f3 bishop to c4 castle kingside", true]],
    );
    assert.equal(view.counts.audioProgress, undefined, "emitAudioProgress: false sends none");
  });

  it("replaces CUMULATIVE partials and keeps the last one when the completed text differs", () => {
    const view = foldVoiceEvents(
      [
        json({ type: "speechStart", turnId: 1, audioProcessedMs: 1200 }),
        json({ type: "transcript", transcript: "how is the", final: false, audioProcessedMs: 2400 }),
        json({ type: "transcript", transcript: "how is the weather", final: false, audioProcessedMs: 3200 }),
        json({ type: "speechEnd", turnId: 1, audioProcessedMs: 3600 }),
        json({ type: "speechComplete", turnId: 1, transcript: "How is the weather?", audioProcessedMs: 3600 }),
      ],
      "ENDPOINTING",
    );
    assert.equal(view.turns[0].transcript, "How is the weather?");
    assert.equal(view.turns[0].lastPartial, "how is the weather");
    assert.equal(view.speaking, false);
  });

  it("labels the open turn from the relay's DIARIZATION session and reads the handshake and close", () => {
    const view = foldVoiceEvents(events(fixture("realtime-diarization.sse")), "DIARIZATION");
    assert.match(view.sessionId ?? "", /^docs-/);
    assert.equal(view.turns.length, 1);
    assert.equal(view.turns[0].speaker, "A");
    assert.equal(view.speakerSpans[0].label, "A");
    assert.equal(view.speakerSpans[0].fromMs, 540, "the span starts at the turn's speechStart");
    assert.deepEqual(view.done, { ok: true, audioMs: 9151, processedMs: 9200, code: 1000 });
    assert.equal(view.counts.handshake, 1);
  });

  it("keeps every frame as it arrived, so a printed frame shows all its fields", () => {
    const view = foldVoiceEvents(events(fixture("realtime-diarization.sse")), "DIARIZATION");
    const last = view.timeline.find((e) => e.type === "transcript" && e.final);
    assert.ok(last?.raw, "the final transcript frame keeps its data");
    assert.deepEqual(JSON.parse(last.raw), { type: "transcript", transcript: last.text, final: true, audioProcessedMs: last.atMs });
    const ack = view.timeline.find((e) => e.type === "handshake");
    assert.deepEqual(Object.keys(JSON.parse(ack?.raw ?? "{}")), ["sessionId"]);
    for (const e of view.timeline) assert.equal(typeof e.raw, "string", `${e.type} keeps its frame`);
    // An error frame keeps its sessionId, which the old rebuilt pane dropped.
    const err = foldVoiceEvents([json({ type: "error", message: "Invalid mode", sessionId: "s-1", errorCode: "bad_mode" })]);
    assert.deepEqual(JSON.parse(err.timeline[0].raw ?? "{}"), { type: "error", message: "Invalid mode", sessionId: "s-1", errorCode: "bad_mode" });
  });

  it("keeps overlapping turns apart by turnId and spans speakers from the later of speechStart or speaker", () => {
    const view = foldVoiceEvents(
      [
        json({ type: "speechStart", turnId: 1, audioProcessedMs: 1200 }),
        json({ type: "speaker", label: "A", audioProcessedMs: 2480 }),
        json({ type: "speechStart", turnId: 2, audioProcessedMs: 3000 }),
        json({ type: "speechComplete", turnId: 1, transcript: "Thanks for calling.", audioProcessedMs: 3300 }),
        json({ type: "speaker", label: "B", audioProcessedMs: 4000 }),
        json({ type: "speechComplete", turnId: 2, transcript: "Hi there.", audioProcessedMs: 4400 }),
      ],
      "DIARIZATION",
    );
    assert.deepEqual(
      view.turns.map((t) => [t.turnId, t.speaker, t.transcript]),
      [
        [1, "A", "Thanks for calling."],
        [2, "B", "Hi there."],
      ],
    );
    assert.deepEqual(
      view.speakerSpans.map((s) => [s.label, s.fromMs, s.toMs]),
      [
        ["A", 1200, 2480],
        ["B", 3000, 4000],
      ],
    );
    assert.equal(shownTurns(view).length, 2);
  });

  it("starts a span at the turn's speechStart when the last speaker event came before it, as in a real session", () => {
    // The relay's real order: speechStart, speaker, speechEnd, speechComplete, and the next turn's speechStart
    // reports less audio processed than the speaker event before it.
    const view = foldVoiceEvents(
      [
        json({ type: "speechStart", audioProcessedMs: 220, turnId: 0 }),
        json({ type: "speaker", label: "A", audioProcessedMs: 5120 }),
        json({ type: "speechEnd", audioProcessedMs: 4620, turnId: 0 }),
        json({ type: "speechComplete", audioProcessedMs: 4620, turnId: 0, transcript: " Hi. Thanks for calling Riverside Bikes. " }),
        json({ type: "speechStart", audioProcessedMs: 5020, turnId: 1 }),
        json({ type: "speaker", label: "B", audioProcessedMs: 10080 }),
        json({ type: "speechComplete", audioProcessedMs: 9580, turnId: 1, transcript: " Hi, the back brake is squeaking. " }),
      ],
      "DIARIZATION",
    );
    assert.deepEqual(
      view.speakerSpans.map((sp) => [sp.label, sp.fromMs, sp.toMs, sp.turnId]),
      [
        ["A", 220, 5120, 0],
        ["B", 5020, 10080, 1],
      ],
    );
    assert.deepEqual(view.turns.map((t) => [t.turnId, t.speaker, t.transcript]), [
      [0, "A", "Hi. Thanks for calling Riverside Bikes."],
      [1, "B", "Hi, the back brake is squeaking."],
    ]);
  });

  it("captures error events and counts types the docs don't list", () => {
    const view = foldVoiceEvents([json({ type: "emotion", label: "calm" }), json({ type: "error", message: "Backlog too large", sessionId: "s-1", errorCode: "backlog" })]);
    assert.equal(view.unknown, 1);
    assert.deepEqual(view.error, { message: "Backlog too large", code: "backlog", type: undefined, param: undefined, sessionId: "s-1" });
  });

  it("reads text/plain lines by speaker, with unknown for unattributed turns", () => {
    const lines = parsePlainTranscript(fixture("transcribe-diarization.txt"), "DIARIZATION");
    assert.equal(lines.length, 6);
    assert.deepEqual(lines[0], { speaker: "A", text: "Hi. Thanks for calling Riverside Bikes. How can I help?" });
    assert.equal(lines[1].speaker, "B");
    assert.deepEqual(parsePlainTranscript("unknown:mm hm\n", "DIARIZATION"), [{ speaker: "unknown", text: "mm hm" }]);
    assert.deepEqual(parsePlainTranscript("One.\nTwo.\n", "ENDPOINTING"), [{ text: "One." }, { text: "Two." }]);
  });

  it("bills whole seconds, rounded down: 30.4 s is 30 s", () => {
    assert.equal(billedSeconds(30_400), 30);
    assert.equal(billedSeconds(999), 0);
    assert.equal(transcribeCostUsd(3_600_000), 0.18);
    assert.ok(Math.abs(transcribeCostUsd(14_640) - (14 / 3600) * 0.18) < 1e-12);
  });
});

describe("voice requests and code", () => {
  const settings = (over: Partial<VoiceSettings> = {}): VoiceSettings => ({ ...DEFAULT_VOICE_SETTINGS, ...over });

  it("builds the request part with the required fields and only the options that apply", () => {
    assert.deepEqual(transcribeRequestJson(settings()), { model: "muse-voice-transcribe-1.0", audioEncoding: "WAV", mode: "PUSH_TO_TALK" });
    const sse = transcribeRequestJson(settings({ accept: "sse", partialMode: "DELTA", emitAudioProgress: false, keywords: ["eSIM"], languageBias: ["English"] }));
    assert.deepEqual(sse, {
      model: "muse-voice-transcribe-1.0",
      audioEncoding: "WAV",
      mode: "PUSH_TO_TALK",
      keywords: ["eSIM"],
      languageBias: ["English"],
      partialMode: "DELTA",
      emitAudioProgress: false,
    });
    const json = transcribeRequestJson(settings({ accept: "json", partialMode: "DELTA", emitAudioProgress: false }));
    assert.equal("partialMode" in json, false, "partialMode only changes event streams");
    assert.equal("emitAudioProgress" in json, false);
  });

  it("puts the optional sessionId in the query and the relay settings in its query", () => {
    assert.equal(transcribePath(settings()), "asr/transcribe");
    assert.equal(transcribePath(settings({ sessionId: " my id/1 " })), "asr/transcribe?sessionId=my%20id%2F1");
    const q = new URLSearchParams(relayQuery(settings({ mode: "DIARIZATION", partialMode: "DELTA", keywords: ["a", "b"], languageBias: ["French"] })));
    assert.equal(q.get("model"), "muse-voice-transcribe-1.0");
    assert.equal(q.get("mode"), "DIARIZATION");
    assert.equal(q.get("diarization"), "true");
    assert.equal(q.get("partialMode"), "DELTA");
    assert.equal(q.get("keywords"), "a,b");
    assert.equal(q.get("languageBias"), "French");
  });

  it("runs a preset on its own endpoint, a file upload when it picks a reply format, else the demo's first", () => {
    const both = ["transcribe", "realtime"] as const;
    assert.equal(presetEndpoint({ endpoint: "realtime" }, both), "realtime");
    assert.equal(presetEndpoint({ accept: "text" }, both), "transcribe", "a file preset after a realtime one still sends the file");
    assert.equal(presetEndpoint({}, both), "transcribe");
    assert.equal(presetEndpoint({}, ["realtime"] as const), "realtime");
    assert.equal(presetEndpoint({ endpoint: "realtime" }, ["transcribe"] as const), "transcribe", "an endpoint the page doesn't offer falls back");
    assert.equal(presetEndpoint({ accept: "json" }, ["realtime"] as const), "realtime");
  });

  it("shows the handshake with a placeholder credential", () => {
    const h = realtimeHandshakeFrame(settings({ mode: "ENDPOINTING", keywords: ["pawn"] }));
    assert.deepEqual(h.authorization, { accessToken: "Bearer $MODEL_API_KEY" });
    assert.equal(h.audioEncoding, "PCM_16KHZ");
    assert.equal(h.emitAudioProgress, true);
    assert.equal(realtimeHandshakeFrame(settings(), 24_000).audioEncoding, "PCM_24KHZ");
  });

  it("writes transcribe code with the Accept header, the sessionId and the two parts", () => {
    const [curl, py, ts] = transcribeSnippets(settings({ accept: "sse", mode: "ENDPOINTING", sessionId: "my-session-id" }), "chess-moves.wav");
    assert.match(curl.code, /curl --fail-with-body -N -X POST 'https:\/\/api\.meta\.ai\/v1\/asr\/transcribe\?sessionId=my-session-id'/);
    assert.match(curl.code, /-H 'Accept: text\/event-stream'/);
    assert.match(curl.code, /-F 'request=\{"model":"muse-voice-transcribe-1\.0","audioEncoding":"WAV","mode":"ENDPOINTING"\};type=application\/json'/);
    assert.match(curl.code, /-F 'audio=@chess-moves\.wav;type=audio\/wav'/);
    assert.match(py.code, /params=\{"sessionId": "my-session-id"\}/);
    assert.match(py.code, /"request": \(None, json\.dumps\(/);
    assert.match(py.code, /stream=True/);
    assert.match(ts.code, /Accept: "text\/event-stream"/);
    assert.match(ts.code, /form\.append\("request", JSON\.stringify\(/);
    for (const s of [curl, py, ts]) {
      assert.doesNotMatch(s.code, NO_EM);
      assert.doesNotMatch(s.code, KEYISH);
      assert.match(s.code, /MODEL_API_KEY/);
    }
    assert.match(transcribeSnippets(settings({ accept: "text" }))[1].code, /print\(response\.text\)/);
  });

  it("writes realtime clients that send the handshake first and endStream last", () => {
    const [py, ts] = realtimeSnippets(settings({ mode: "DIARIZATION", partialMode: "DELTA" }), "two-voices.wav");
    assert.match(py.code, /"accessToken": f"Bearer \{os\.environ\['MODEL_API_KEY'\]\}"/);
    assert.match(py.code, /"mode": "DIARIZATION"/);
    assert.match(py.code, /"partialMode": "DELTA"/);
    assert.match(py.code, /\{"type": "endStream"\}/);
    assert.match(py.code, /speechComplete/);
    assert.match(ts.code, /new WebSocket\(/);
    assert.match(ts.code, /type: "endStream"/);
    assert.doesNotMatch(py.code + ts.code, NO_EM);
    assert.equal((py.code.match(/accessToken/g) ?? []).length, 1, "the credential is written once, from the environment");
  });

  it("prints both multipart parts for the reference view", () => {
    const text = multipartPreview({ path: "asr/transcribe?sessionId=x", accept: "text/plain", request: { model: "m", audioEncoding: "WAV" } }, { name: "a.wav", bytes: 1234, durationMs: 1500 });
    assert.match(text, /^POST \/v1\/asr\/transcribe\?sessionId=x HTTP\/1\.1/);
    assert.match(text, /Accept: text\/plain/);
    assert.match(text, /name="request"\nContent-Type: application\/json\n\n\{"model":"m","audioEncoding":"WAV"\}/);
    assert.match(text, /name="audio"; filename="a\.wav"/);
    assert.match(text, /<1,234 bytes of RIFF\/WAVE, mono 16-bit PCM, 1\.5 s>/);
  });

  it("splits comma lists and knows the 25 languages", () => {
    assert.deepEqual(splitList(" Acme Mobile, eSIM,,5G, eSIM "), ["Acme Mobile", "eSIM", "5G"]);
    assert.equal(VOICE_LANGUAGES.length, 25);
    assert.deepEqual(unknownLanguages(["english", "Klingon", "Mandarin Chinese"]), ["Klingon"]);
  });
});

describe("voice schemas", () => {
  it("lists every schema on the page, with an event schema for each server event type", () => {
    assert.equal(VOICE_SCHEMAS.length, 14);
    const types = VOICE_SCHEMAS.filter((s) => s.eventType).map((s) => s.eventType);
    assert.deepEqual(new Set(types), new Set(["transcript", "speechStart", "speechEnd", "speechComplete", "speaker", "audioProgress", "error"]));
    for (const s of VOICE_SCHEMAS) assert.doesNotMatch(`${s.description} ${s.fields.map((f) => f.description).join(" ")}`, NO_EM);
  });

  it("validates every event of a real stream and a real buffered reply", () => {
    for (const e of events(fixture("transcribe-endpointing.sse"))) {
      const check = checkVoiceMessage(e.json);
      assert.ok(check.schema, `identified ${e.data}`);
      assert.equal(check.ok, true, `${e.data}: ${JSON.stringify(check.checks.filter((c) => !c.ok))}`);
      assert.deepEqual(check.extra, []);
    }
    const reply = checkVoiceMessage(JSON.parse(fixture("transcribe-diarization.json")));
    assert.equal(reply.schema?.id, "TranscribeResponse");
    assert.equal(reply.ok, true);
    assert.ok(reply.checks.some((c) => c.field === "turns[5].speaker" && c.ok), "an unattributed turn has no speaker, which is allowed");
  });

  it("names what's wrong with broken messages", () => {
    const missing = checkVoiceMessage({ model: "muse-voice-transcribe-1.0", mode: "DIARIZATION" });
    assert.equal(missing.schema?.id, "TranscribeRequest");
    assert.ok(missing.checks.some((c) => c.field === "audioEncoding" && !c.ok && /required/.test(c.message)));
    const turnId = checkVoiceMessage({ type: "speechComplete", turnId: "1", transcript: "x", audioProcessedMs: 1 });
    assert.ok(turnId.checks.some((c) => c.field === "turnId" && !c.ok));
    const enumBad = checkVoiceMessage({ authorization: { accessToken: "Bearer x" }, audioEncoding: "PCM_44KHZ", model: "m" });
    assert.equal(enumBad.schema?.id, "RealtimeHandshakeRequest");
    assert.ok(enumBad.checks.some((c) => c.field === "audioEncoding" && !c.ok && /PCM_24KHZ, PCM_16KHZ/.test(c.message)));
    assert.ok(enumBad.checks.some((c) => c.field === "authorization.accessToken" && c.ok), "nested refs are checked");
    const unknown = identifyVoiceMessage({ type: "emotion", label: "calm" });
    assert.equal(unknown.schema, null);
    assert.match(unknown.reason, /ignore unknown event types/);
    assert.equal(identifyVoiceMessage({ sessionId: "550e" }).schema?.id, "RealtimeHandshakeResponse");
  });

  it("reads JSON, a JSON array, one object per line, and event-stream lines", () => {
    assert.equal(readMessages('{"type":"speaker","label":"A","audioProcessedMs":1}').length, 1);
    assert.equal(readMessages('[{"a":1},{"b":2}]').length, 2);
    const sse = readMessages('event: transcript\ndata: {"type":"transcript","transcript":"hi","final":false,"audioProcessedMs":5}\n\n: comment\nnot json');
    assert.equal(sse.length, 2);
    assert.equal(sse[0].line, 2);
    assert.ok(sse[1].error);
  });

  it("filters schemas by name, field and description", () => {
    const ids = searchSchemas("turnId").map((s) => s.id);
    assert.ok(ids.includes("Turn") && ids.includes("SpeechStartEvent") && !ids.includes("AudioProgressEvent"));
    assert.deepEqual(searchSchemas("PCM_16").map((s) => s.id), ["RealtimeHandshakeRequest"]);
    assert.equal(searchSchemas("").length, VOICE_SCHEMAS.length);
  });
});
