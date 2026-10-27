import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  framesFromUsage,
  meterBody,
  SseParser,
  sseUsageCollector,
  usageFromJson,
  type SseEvent,
} from "@/lib/gateway/meter";

const fixtures = path.join(import.meta.dirname, "fixtures");
/** Recorded from api.meta.ai (sam-3.1, stream:true) by scripts/dev/gateway-make-fixtures.ts. */
const samStream = readFileSync(path.join(fixtures, "sam-stream.sse"), "utf8");

function streamOf(text: string, chunkSize: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

test("SseParser splits events across arbitrary chunk boundaries", () => {
  for (const size of [1, 3, 17, 256, samStream.length]) {
    const events: SseEvent[] = [];
    const p = new SseParser((e) => events.push(e));
    for (let i = 0; i < samStream.length; i += size) p.push(samStream.slice(i, i + size));
    p.end();
    const types = events.map((e) => e.event);
    assert.equal(types[0], "response.created", `chunk ${size}`);
    assert.ok(types.includes("response.completed"), `chunk ${size}`);
    assert.equal(events.at(-1)?.data, "[DONE]");
  }
});

test("SseParser handles CRLF, comments, multi-line data and skipped events", () => {
  const events: SseEvent[] = [];
  const p = new SseParser((e) => events.push(e), (name) => name !== "skip.me");
  p.push(": ping\r\n\r\nevent: a\r\ndata: one\r\ndata: two\r\n\r\nevent: skip.me\ndata: big\n\ndata: {\"type\":\"x\"}\n\n");
  p.end();
  assert.deepEqual(events, [
    { event: "a", data: "one\ntwo" },
    { event: null, data: '{"type":"x"}' },
  ]);
});

test("real SAM stream: usage comes from response.completed (images_processed)", async () => {
  for (const size of [7, 1024, 1 << 20]) {
    const items = await meterBody("responses", "sam-3.1", "text/event-stream; charset=utf-8", streamOf(samStream, size));
    assert.equal(items.length, 1);
    assert.equal(items[0].model, "sam-3.1");
    assert.equal(items[0].images, 1);
    assert.equal(items[0].inputTokens, 0);
    assert.ok(items[0].costUsd > 0, "SAM image calls cost something");
  }
});

test("SAM video frames: any *frames* usage field counts, max not sum", () => {
  assert.equal(framesFromUsage({ images_processed: 0, video_frames_processed: 120, frames: 90 }), 120);
  assert.equal(framesFromUsage({ input_tokens: 5 }), 0);
  const [item] = usageFromJson("responses", "sam-3.1", { usage: { images_processed: 0, video_frames: 10 } });
  assert.equal(item.videoFrames, 10);
  // 50-frame minimum per request.
  assert.ok(Math.abs(item.costUsd - 50 * 0.0002) < 1e-12);
});

test("Spark JSON usage: cached input priced separately", () => {
  const [item] = usageFromJson("responses", "muse-spark-1.3", {
    model: "muse-spark-1.3",
    usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 400 }, output_tokens: 100 },
  });
  assert.equal(item.inputTokens, 1000);
  assert.equal(item.cachedInputTokens, 400);
  assert.equal(item.outputTokens, 100);
  const expected = (600 * 1.25 + 400 * 0.15 + 100 * 4.25) / 1e6;
  assert.ok(Math.abs(item.costUsd - expected) < 1e-12);
});

test("image metering: data[] items x $0.01, token counts ignored", () => {
  const body = { created: 1, usage: { input_tokens: 999, output_tokens: 999 }, data: [{ b64_json: "a" }, { b64_json: "b" }, { b64_json: "c" }] };
  const [gen] = usageFromJson("images/generations", "muse-image-1.0", body);
  assert.equal(gen.images, 3);
  assert.equal(gen.inputTokens, 0);
  assert.ok(Math.abs(gen.costUsd - 0.03) < 1e-12);
  const [edit] = usageFromJson("images/edits", "muse-image-1.0", { data: [{ url: "https://x" }] });
  assert.ok(Math.abs(edit.costUsd - 0.01) < 1e-12);
  assert.deepEqual(usageFromJson("images/generations", "muse-image-1.0", { data: [] }), []);
});

test("image metering: streamed completed events count one image each", () => {
  const c = sseUsageCollector("images/generations", "muse-image-1.0");
  c.push('event: image_generation.partial_image\ndata: {"type":"image_generation.partial_image"}\n\n');
  c.push('event: image_generation.completed\ndata: {"type":"image_generation.completed","b64_json":"x"}\n\n');
  c.push('data: {"type":"image_generation.completed","b64_json":"y"}\n\n');
  const [item] = c.finish();
  assert.equal(item.images, 2);
  assert.ok(Math.abs(item.costUsd - 0.02) < 1e-12);
});

test("Muse Image through responses: image_generation_call outputs count", () => {
  const [item] = usageFromJson("responses", "muse-image-1.0", {
    output: [{ type: "image_generation_call", status: "completed" }, { type: "message" }],
    usage: { input_tokens: 10, output_tokens: 10 },
  });
  assert.equal(item.images, 1);
  assert.ok(Math.abs(item.costUsd - 0.01) < 1e-12);
});

test("asr metering: audioDurationMs at $0.18 per hour", () => {
  const [item] = usageFromJson("asr/transcribe", "muse-voice-transcribe-1.0", { transcript: "hi", audioDurationMs: 3_600_000 });
  assert.equal(item.audioSeconds, 3600);
  assert.ok(Math.abs(item.costUsd - 0.18) < 1e-12);
});

test("files are free and unparseable bodies go unmetered", async () => {
  assert.deepEqual(await meterBody("files", null, "application/json", streamOf('{"id":"file-1"}', 4)), []);
  assert.deepEqual(await meterBody("responses", "muse-spark-1.3", "application/json", streamOf("not json", 4)), []);
});
