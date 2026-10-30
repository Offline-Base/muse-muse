/**
 * Reading replies the media demos get back: the realtime transcription stream (lib/docs/media/realtime.ts) fed the
 * event sequences printed on the speech-to-text page (endpointing, diarization) plus the docs relay's handshake,
 * error and done events; and Muse Image replies (lib/docs/media/images.ts) in the shapes image-generation shows.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/docs/media/__tests__/replies.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EMPTY_REALTIME, cleanTranscript, realtimeStep, realtimeText, type RealtimeView } from "@/lib/docs/media/realtime";
import { imageOfStreamEvent, imagesOfImagesReply, imagesOfResponse, reasoningOfResponse } from "@/lib/docs/media/images";

type Ev = { event: string | null; json: Record<string, unknown> | null };
const frame = (json: Record<string, unknown>): Ev => ({ event: typeof json.type === "string" ? json.type : null, json });
const fold = (events: Ev[], mode: "CUMULATIVE" | "DELTA" = "CUMULATIVE") =>
  events.reduce<RealtimeView>((v, e) => realtimeStep(v, e, mode), EMPTY_REALTIME);

describe("realtime stream", () => {
  it("reads the docs' endpointing turn: partials replace, speechComplete holds the text", () => {
    const steps = [
      { type: "speechStart", turnId: 1, audioProcessedMs: 1200 },
      { type: "transcript", transcript: "how is the", final: false, audioProcessedMs: 2400 },
      { type: "transcript", transcript: "how is the weather", final: false, audioProcessedMs: 3200 },
    ].map(frame);
    const mid = fold(steps);
    assert.equal(mid.partial, "how is the weather");
    assert.equal(mid.speaking, true);
    assert.deepEqual(mid.turns, []);
    const done = fold([...steps, frame({ type: "speechEnd", turnId: 1, audioProcessedMs: 3600 }), frame({ type: "speechComplete", turnId: 1, transcript: "How is the weather?", audioProcessedMs: 3600 })]);
    assert.deepEqual(done.turns, [{ turnId: 1, transcript: "How is the weather?", speaker: undefined, startMs: 1200, endMs: 3600 }]);
    assert.equal(done.partial, "");
    assert.equal(done.speaking, false);
    assert.equal(done.processedMs, 3600);
    assert.equal(realtimeText(done), "How is the weather?");
  });

  it("labels the turn from the docs' diarization example", () => {
    const v = fold(
      [
        { type: "speechStart", turnId: 1, audioProcessedMs: 1200 },
        { type: "transcript", transcript: "thanks for calling", final: false, audioProcessedMs: 2400 },
        { type: "speaker", label: "A", audioProcessedMs: 2480 },
        { type: "transcript", transcript: "thanks for calling how can i help", final: false, audioProcessedMs: 3400 },
        { type: "speaker", label: "A", audioProcessedMs: 3520 },
        { type: "speechEnd", turnId: 1, audioProcessedMs: 3600 },
        { type: "speechComplete", turnId: 1, transcript: "Thanks for calling. How can I help?", audioProcessedMs: 3600 },
      ].map(frame),
    );
    assert.equal(v.turns.length, 1);
    assert.equal(v.turns[0].speaker, "A");
    assert.equal(v.turns[0].transcript, "Thanks for calling. How can I help?");
  });

  it("ends PUSH_TO_TALK on final: true, and appends DELTA partials", () => {
    const ptt = fold([frame({ type: "transcript", transcript: "pawn to e4", final: false }), frame({ type: "transcript", transcript: "Pawn to e4.​", final: true })]);
    assert.deepEqual(ptt.turns.map((t) => t.transcript), ["Pawn to e4."]);
    const delta = fold([frame({ type: "transcript", transcript: "knight ", final: false }), frame({ type: "transcript", transcript: "to f3", final: false })], "DELTA");
    assert.equal(delta.partial, "knight to f3");
  });

  it("keys turns by turnId when they finish out of order", () => {
    const v = fold(
      [
        { type: "speechStart", turnId: 1 },
        { type: "speechStart", turnId: 2 },
        { type: "speechComplete", turnId: 2, transcript: "second" },
        { type: "speechComplete", turnId: 1, transcript: "first" },
      ].map(frame),
    );
    assert.deepEqual(v.turns.map((t) => [t.turnId, t.transcript]), [
      [1, "first"],
      [2, "second"],
    ]);
  });

  it("reads the relay's handshake, error and done events and counts unknown ones", () => {
    const v = fold([
      { event: "handshake", json: { sessionId: "docs-1" } },
      frame({ type: "audioProgress", audioProcessedMs: 800 }),
      frame({ type: "somethingNew", x: 1 }),
      { event: "error", json: { type: "error", code: "realtime_closed", message: "The stream closed early." } },
      { event: "done", json: { ok: false, sessionId: "docs-1", code: 1011, audioMs: 1600, processedMs: 800 } },
    ]);
    assert.equal(v.sessionId, "docs-1");
    assert.equal(v.processedMs, 800);
    assert.deepEqual(v.error, { code: "realtime_closed", message: "The stream closed early." });
    assert.deepEqual(v.done, { ok: false, audioMs: 1600, processedMs: 800, code: 1011 });
    assert.equal(v.events, 5);
  });

  it("strips the zero-width space transcripts can end with", () => {
    assert.equal(cleanTranscript("  It is raining.​ "), "It is raining.");
  });
});

describe("Muse Image replies", () => {
  const RESPONSE = {
    id: "resp_abc123",
    status: "completed",
    output: [
      { type: "reasoning", id: "rs_xxx", summary: [{ type: "summary_text", text: "Looked up the current table and each crest, then laid out the panel." }], status: "completed" },
      { type: "message", id: "msg_xxx", role: "assistant", content: [], status: "completed" },
      { type: "image_generation_call", id: "ig_xxx", status: "completed", result: "UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=" },
    ],
  };

  it("picks images by item type and reads the reasoning summary", () => {
    const images = imagesOfResponse(RESPONSE);
    assert.equal(images.length, 1);
    assert.equal(images[0].id, "ig_xxx");
    assert.equal(images[0].mime, "image/webp");
    assert.equal(reasoningOfResponse(RESPONSE), "Looked up the current table and each crest, then laid out the panel.");
    assert.deepEqual(imagesOfResponse({ output: [{ type: "image_generation_call", result: null }] }), []);
    assert.deepEqual(imagesOfResponse(null), []);
  });

  it("reads images endpoint replies as base64 or URLs", () => {
    const b64 = imagesOfImagesReply({ created: 1, data: [{ b64_json: "/9j/4AAQSkZJRgABAQAAAQABAAD" }], output_format: "jpeg" });
    assert.deepEqual(b64, [{ b64: "/9j/4AAQSkZJRgABAQAAAQABAAD", mime: "image/jpeg" }]);
    const urls = imagesOfImagesReply({ data: [{ url: "https://example.com/a.webp" }], output_format: "webp" });
    assert.deepEqual(urls, [{ url: "https://example.com/a.webp", mime: "image/webp" }]);
    assert.deepEqual(imagesOfImagesReply({ data: "nope" }), []);
  });

  it("reads a streamed images event", () => {
    assert.equal(imageOfStreamEvent({ type: "image_generation.completed", b64_json: "UklGRiQAAABXRUJQ", created_at: 1 })?.mime, "image/webp");
    assert.equal(imageOfStreamEvent({ type: "image_edit.completed", b64_json: "iVBORw0KGgoAAAAN" })?.mime, "image/png");
    assert.equal(imageOfStreamEvent({ type: "other" }), null);
  });
});
