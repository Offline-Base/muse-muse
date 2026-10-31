import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  framesFromUsage,
  meterBody,
  meterReply,
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

test("files are free; unparseable bodies record a minimal estimate", async () => {
  assert.deepEqual(await meterBody("files", null, "application/json", streamOf('{"id":"file-1"}', 4)), []);
  const [item] = await meterBody("responses", "muse-spark-1.3", "application/json", streamOf("not json", 4));
  assert.equal(item.model, "muse-spark-1.3");
  assert.equal(item.inputTokens, 1000);
  assert.equal(item.outputTokens, 1000);
  assert.ok(item.costUsd > 0);
});

/** A stream that sends `text` and then fails, like the upstream timeout or a reset mid-stream. */
function failingStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (sent) return controller.error(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
      sent = true;
      controller.enqueue(bytes);
    },
  });
}

const delta = (text: string) =>
  `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`;

test("cut-off Responses stream: records the deltas seen, at least a minimal estimate", async () => {
  const long = "x".repeat(8000);
  const sse = 'event: response.created\ndata: {"type":"response.created","response":{"usage":null}}\n\n' + delta(long) + delta(long);
  const [item] = await meterBody("responses", "muse-wonder-1.0", "text/event-stream", failingStream(sse));
  assert.equal(item.model, "muse-wonder-1.0");
  assert.equal(item.outputTokens, 4000, "16,000 delta characters at 4 per token");
  assert.equal(item.inputTokens, 1000);
  assert.ok(Math.abs(item.costUsd - (1000 * 4 + 4000 * 20) / 1e6) < 1e-12);

  const [early] = await meterBody("responses", "muse-spark-1.3", "text/event-stream", failingStream(delta("hi")));
  assert.equal(early.outputTokens, 1000, "nothing much seen: the minimal estimate");

  // A stream that closes cleanly without a final event was cut off too.
  const [closed] = await meterBody("responses", "muse-spark-1.3", "text/event-stream", streamOf(delta("hi"), 3));
  assert.equal(closed.inputTokens, 1000);
});

test("cut-off streams after the final event keep the real usage; SAM and images record one image", async () => {
  const done =
    'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":3}}}\n\n';
  const [real] = await meterBody("responses", "muse-spark-1.3", "text/event-stream", failingStream(done));
  assert.equal(real.inputTokens, 7);
  assert.equal(real.outputTokens, 3);

  const [sam] = await meterBody("responses", "sam-3.1", "text/event-stream", failingStream(delta("<0f>0<|box;")));
  assert.equal(sam.images, 1);
  assert.ok(sam.costUsd > 0);

  const [image] = await meterBody("images/generations", "muse-image-1.0", "text/event-stream", failingStream(": ping\n\n"));
  assert.equal(image.images, 1);
  assert.ok(Math.abs(image.costUsd - 0.01) < 1e-12);
});

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
const USAGE = { input_tokens: 1000, output_tokens: 100 };
/** Muse Wonder at $4 per million input tokens and $20 per million output. */
const WONDER_TOKENS_USD = (1000 * 4 + 100 * 20) / 1e6;
const SEARCH_USD = 0.0025;
const searchItem = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: "web_search_call", status: "completed", ...extra });
const itemDone = (item: unknown) => `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`;
const completed = (output: unknown[], usage: unknown = USAGE) =>
  `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { usage, output } })}\n\n`;

test("JSON replies: each search query adds $0.0025 on top of tokens, and units counts the queries", () => {
  const [item] = usageFromJson("responses", "muse-wonder-1.0", {
    usage: USAGE,
    output: [
      searchItem("ws_1"),
      searchItem("ws_2", { action: { type: "search", queries: ["a", "b", "c"] } }),
      searchItem("ws_3", { action: { type: "open_page", url: "https://x" } }),
      { type: "message", content: [] },
    ],
  });
  near(item.costUsd, WONDER_TOKENS_USD + 4 * SEARCH_USD);
  assert.equal(item.units, 4);
  assert.equal(item.inputTokens, 1000);
});

test("JSON replies: no searches, no fee and no units", () => {
  const [item] = usageFromJson("responses", "muse-wonder-1.0", { usage: USAGE, output: [{ type: "message" }] });
  near(item.costUsd, WONDER_TOKENS_USD);
  assert.equal(item.units, undefined);
});

test("Muse Image's own searches are part of its per-image price", () => {
  const [item] = usageFromJson("responses", "muse-image-1.0", {
    usage: USAGE,
    output: [searchItem("ws_1"), { type: "image_generation_call" }],
  });
  near(item.costUsd, 0.01);
  assert.equal(item.units, undefined);
});

test("SSE replies: the final response's output sets the search fee; finished items aren't counted twice", async () => {
  const sse = itemDone(searchItem("ws_1")) + itemDone(searchItem("ws_2")) + completed([searchItem("ws_1"), searchItem("ws_2")]);
  for (const size of [5, 64, 1 << 20]) {
    const { items, builtInCalls } = await meterReply("responses", "muse-wonder-1.0", "text/event-stream", streamOf(sse, size));
    near(items[0].costUsd, WONDER_TOKENS_USD + 2 * SEARCH_USD);
    assert.equal(items[0].units, 2);
    assert.equal(builtInCalls, 2);
  }
});

test("SSE replies: a stream cut off before its final event still pays for the searches it showed", async () => {
  const sse = itemDone(searchItem("ws_1")) + itemDone(searchItem("ws_1")) + itemDone(searchItem("ws_2", { action: { queries: ["a", "b"] } })) + delta("hi");
  const failed = await meterReply("responses", "muse-wonder-1.0", "text/event-stream", failingStream(sse));
  near(failed.items[0].costUsd, (1000 * 4 + 1000 * 20) / 1e6 + 3 * SEARCH_USD);
  assert.equal(failed.items[0].units, 3);
  assert.equal(failed.builtInCalls, null, "cut off, so it may have run more");

  const closed = await meterReply("responses", "muse-wonder-1.0", "text/event-stream", streamOf(itemDone(searchItem("ws_1")), 7));
  near(closed.items[0].costUsd, (1000 * 4 + 1000 * 20) / 1e6 + SEARCH_USD);
  assert.equal(closed.builtInCalls, null, "closed without a final event");
});

test("SSE replies: a stream that fails after its final event keeps the real usage and its searches", async () => {
  const { items, builtInCalls } = await meterReply("responses", "muse-wonder-1.0", "text/event-stream", failingStream(completed([searchItem("ws_1")])));
  near(items[0].costUsd, WONDER_TOKENS_USD + SEARCH_USD);
  assert.equal(builtInCalls, 1);
});

test("SSE replies: items a final response leaves out still count, since Meta ran them", () => {
  const c = sseUsageCollector("responses", "muse-wonder-1.0");
  c.push(itemDone(searchItem("ws_1")) + completed([]));
  const [item] = c.finish();
  near(item.costUsd, WONDER_TOKENS_USD + SEARCH_USD);
  assert.equal(c.builtInCalls(), 1);
});

test("SSE replies: events with no event: line are read by their type", async () => {
  const sse = `data: ${JSON.stringify({ type: "response.output_item.done", item: searchItem("ws_1") })}\n\n` +
    `data: ${JSON.stringify({ type: "response.completed", response: { usage: USAGE, output: [searchItem("ws_1")] } })}\n\n`;
  const { items } = await meterReply("responses", "muse-wonder-1.0", "text/event-stream", streamOf(sse, 9));
  near(items[0].costUsd, WONDER_TOKENS_USD + SEARCH_USD);
});

test("searches: false leaves the fee to the caller, for the docs proxy", () => {
  const c = sseUsageCollector("responses", "muse-wonder-1.0", { searches: false });
  c.push(itemDone(searchItem("ws_1")) + completed([searchItem("ws_1")]));
  const [item] = c.finish();
  near(item.costUsd, WONDER_TOKENS_USD);
  assert.equal(item.units, undefined);
});

test("built-in calls count calls, not queries, and hosted tool search counts as a call without a fee", async () => {
  const reply = {
    usage: USAGE,
    output: [
      searchItem("ws_1", { action: { type: "search", queries: ["a", "b", "c"] } }),
      { id: "ts_1", type: "tool_search_call", paths: ["x"] },
      { id: "fc_1", type: "function_call", name: "f" },
    ],
  };
  const { items, builtInCalls } = await meterReply("responses", "muse-wonder-1.0", "application/json", streamOf(JSON.stringify(reply), 11));
  assert.equal(builtInCalls, 2);
  assert.equal(items[0].units, 3);
  near(items[0].costUsd, WONDER_TOKENS_USD + 3 * SEARCH_USD);

  const sse = itemDone(reply.output[0]) + itemDone(reply.output[1]) + itemDone(reply.output[2]) + completed(reply.output);
  const streamed = await meterReply("responses", "muse-wonder-1.0", "text/event-stream", streamOf(sse, 13));
  assert.equal(streamed.builtInCalls, 2);
  assert.equal(streamed.items[0].units, 3);
});

test("built-in calls: unreadable JSON isn't known, other endpoints have none", async () => {
  assert.equal((await meterReply("responses", "muse-wonder-1.0", "application/json", streamOf("not json", 4))).builtInCalls, null);
  const images = await meterReply("images/generations", "muse-image-1.0", "application/json", streamOf('{"data":[{"b64_json":"a"}]}', 4));
  assert.equal(images.builtInCalls, 0);
  assert.equal((await meterReply("files", null, "application/json", streamOf("{}", 4))).builtInCalls, 0);
});

test("a real SAM stream pays no search fee and its output items are never buffered", () => {
  const c = sseUsageCollector("responses", "sam-3.1");
  c.push(samStream);
  const [item] = c.finish();
  assert.equal(item.units, undefined);
  assert.ok(item.costUsd > 0);
});
