import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { matchEndpoint, type DocsEndpoint } from "@/lib/docs/proxy/endpoints";
import {
  chatUsage,
  docsMinimalUsage,
  docsStreamMeter,
  docsUsageFromJson,
  messagesSearches,
  messagesUsage,
  meterStream,
  readMetered,
  responsesSearches,
  usageShown,
} from "@/lib/docs/proxy/meter";
import { usageCost } from "@/lib/meta/pricing";
import { sse, streamOf } from "./helpers";

const at = (method: string, p: string) => matchEndpoint(method, p.split("/")) as DocsEndpoint;
const responses = at("POST", "responses");
const chat = at("POST", "chat/completions");
const messages = at("POST", "messages");
const images = at("POST", "images/generations");
const asr = at("POST", "asr/transcribe");
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

/** Recorded from api.meta.ai (sam-3.1, stream:true) for the gateway's tests. */
const samStream = readFileSync(path.join(import.meta.dirname, "../../../gateway/__tests__/fixtures/sam-stream.sse"), "utf8");

test("chat completions JSON: prompt tokens include the cached ones, priced like Responses", () => {
  // The shape of the protocols/chat-completions example reply, with the details Meta's schema adds.
  const reply = {
    id: "chatcmpl-abc123",
    object: "chat.completion",
    model: "muse-spark-1.3-contributor",
    choices: [{ index: 0, message: { role: "assistant", content: "Here are three key differences..." }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 1025,
      completion_tokens: 419,
      total_tokens: 1444,
      prompt_tokens_details: { cached_tokens: 1000 },
      completion_tokens_details: { reasoning_tokens: 400 },
    },
  };
  const [item] = docsUsageFromJson(chat, "muse-spark-1.3-contributor", reply);
  assert.equal(item.inputTokens, 1025);
  assert.equal(item.cachedInputTokens, 1000);
  assert.equal(item.outputTokens, 419);
  close(item.costUsd, usageCost({ model: "muse-spark-1.3-contributor", inputTokens: 1025, cachedInputTokens: 1000, outputTokens: 419 }));
  assert.equal(chatUsage("muse-wonder-1.0", null), null);
});

test("messages JSON: input, cache reads and cache writes add up; web_search blocks are billed", () => {
  const reply = {
    id: "msg_abc123",
    type: "message",
    role: "assistant",
    model: "muse-spark-1.3",
    content: [
      { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "muse spark" } },
      { type: "text", text: "The capital of France is Paris." },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 14, output_tokens: 8, cache_read_input_tokens: 100, cache_creation_input_tokens: 6, output_tokens_details: { thinking_tokens: 5 } },
  };
  assert.equal(messagesSearches(reply), 1);
  const [item] = docsUsageFromJson(messages, "muse-wonder-1.0", reply);
  assert.equal(item.inputTokens, 120);
  assert.equal(item.cachedInputTokens, 100);
  assert.equal(item.outputTokens, 8);
  close(item.costUsd, usageCost({ model: "muse-wonder-1.0", inputTokens: 120, cachedInputTokens: 100, outputTokens: 8 }) + 0.0025);
  assert.equal(messagesUsage("muse-wonder-1.0", undefined), null);
});

test("responses JSON: web_search_call items add $2.50 per 1,000 queries; open_page and find_in_page don't", () => {
  const reply = {
    id: "resp_123",
    status: "completed",
    output: [
      { id: "ws_1", type: "web_search_call", status: "completed" },
      { id: "ws_2", type: "web_search_call", status: "completed", action: { type: "search", query: "a", queries: ["a", "b", "c"] } },
      { id: "ws_3", type: "web_search_call", status: "completed", action: { type: "open_page", url: "https://example.com" } },
      { id: "msg_1", type: "message", content: [{ type: "output_text", text: "ok" }] },
    ],
    usage: { input_tokens: 2000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 100, output_tokens_details: { reasoning_tokens: 50 } },
  };
  assert.equal(responsesSearches(reply), 4);
  const [item] = docsUsageFromJson(responses, "muse-spark-1.2", reply);
  close(item.costUsd, usageCost({ model: "muse-spark-1.2", inputTokens: 2000, cachedInputTokens: 0, outputTokens: 100 }) + 4 * 0.0025);
});

test("images and transcription JSON reuse the gateway's meters", () => {
  const [image] = docsUsageFromJson(images, "muse-image-1.0", { created: 1, data: [{ b64_json: "x" }, { b64_json: "y" }] });
  assert.equal(image.images, 2);
  close(image.costUsd, 0.02);
  const [audio] = docsUsageFromJson(asr, "muse-voice-transcribe-1.0", { sessionId: "s", transcript: "hi", audioDurationMs: 3_600_000, turns: [] });
  close(audio.costUsd, 0.18);
});

test("chat completions stream: usage from the include_usage chunk, across any chunking", async () => {
  const text = sse([
    { data: { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Gar" } }] } },
    { data: { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "bage" }, finish_reason: "stop" }] } },
    {
      data: {
        id: "c1",
        object: "chat.completion.chunk",
        choices: [],
        usage: { prompt_tokens: 30, completion_tokens: 600, total_tokens: 630, prompt_tokens_details: { cached_tokens: 0 } },
      },
    },
    { data: "[DONE]" },
  ]);
  for (const size of [1, 5, 64, text.length]) {
    const items = await meterStream(docsStreamMeter(chat, "muse-wonder-1.0"), streamOf(text, size));
    assert.equal(items.length, 1, `chunk ${size}`);
    assert.equal(items[0].inputTokens, 30);
    assert.equal(items[0].outputTokens, 600);
  }
});

test("chat completions stream without its usage chunk records at least the minimum", async () => {
  const text = sse([{ data: { choices: [{ index: 0, delta: { content: "x".repeat(8000) } }] } }]);
  const [item] = await meterStream(docsStreamMeter(chat, "muse-wonder-1.0"), streamOf(text, 512));
  assert.equal(item.inputTokens, 1000);
  assert.equal(item.outputTokens, 2000, "8,000 characters seen is about 2,000 tokens");
});

test("messages stream: input from message_start, output from the last message_delta", async () => {
  const text = sse([
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: { id: "msg_1", type: "message", role: "assistant", content: [], usage: { input_tokens: 25, output_tokens: 1, cache_read_input_tokens: 10 } },
      },
    },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", name: "web_search" } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Paris." } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 15 } } },
    { event: "message_delta", data: { type: "message_delta", delta: {}, usage: { output_tokens: 42 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);
  for (const size of [3, 100, text.length]) {
    const [item] = await meterStream(docsStreamMeter(messages, "muse-spark-1.3-contributor"), streamOf(text, size));
    assert.equal(item.inputTokens, 35, `chunk ${size}`);
    assert.equal(item.cachedInputTokens, 10);
    assert.equal(item.outputTokens, 42);
    close(
      item.costUsd,
      usageCost({ model: "muse-spark-1.3-contributor", inputTokens: 35, cachedInputTokens: 10, outputTokens: 42 }) + 0.0025,
    );
  }
});

test("messages stream cut off after message_start keeps its input count", async () => {
  const text = sse([
    { event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 5000, output_tokens: 1 } } } },
    { event: "content_block_delta", data: { type: "content_block_delta", delta: { type: "text_delta", text: "y".repeat(12_000) } } },
  ]);
  const [item] = await meterStream(docsStreamMeter(messages, "muse-wonder-1.0"), streamOf(text, 1024));
  assert.equal(item.inputTokens, 5000);
  assert.equal(item.outputTokens, 3000);
});

test("responses stream: the id is reported from response.created before the stream ends", async () => {
  const ids: string[] = [];
  let reportedAt = -1;
  let pushed = 0;
  const meter = docsStreamMeter(responses, "sam-3.1", { onResponseId: (id) => ((reportedAt = pushed), ids.push(id)) });
  const chunk = 256;
  for (let i = 0; i < samStream.length; i += chunk) {
    pushed = i;
    meter.push(samStream.slice(i, i + chunk));
  }
  const items = meter.finish();
  assert.deepEqual(ids, ["resp_6ae03abc7da3c46402314b89"]);
  assert.ok(reportedAt < samStream.length / 2, "reported while the stream was still going");
  assert.equal(items[0].model, "sam-3.1");
  assert.equal(items[0].images, 1);
});

test("responses stream: web searches counted from the final response, or from finished items when it was cut off", async () => {
  const created = { event: "response.created", data: { type: "response.created", response: { id: "resp_9", status: "in_progress" } } };
  const searchDone = (id: string) => ({
    event: "response.output_item.done",
    data: { type: "response.output_item.done", item: { id, type: "web_search_call", status: "completed", action: { type: "search", queries: ["q"] } } },
  });
  const usage = { input_tokens: 1000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 100, output_tokens_details: { reasoning_tokens: 0 } };
  const full = sse([
    created,
    searchDone("ws_1"),
    searchDone("ws_2"),
    {
      event: "response.completed",
      data: {
        type: "response.completed",
        response: { id: "resp_9", output: [{ type: "web_search_call", action: { type: "search", queries: ["q"] } }, { type: "web_search_call" }], usage },
      },
    },
    { data: "[DONE]" },
  ]);
  const base = usageCost({ model: "muse-wonder-1.0", inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100 });
  const [item] = await meterStream(docsStreamMeter(responses, "muse-wonder-1.0"), streamOf(full, 50));
  close(item.costUsd, base + 2 * 0.0025);

  const cut = sse([created, searchDone("ws_1"), searchDone("ws_1"), searchDone("ws_2")]);
  const [partial] = await meterStream(docsStreamMeter(responses, "muse-wonder-1.0"), streamOf(cut, 50));
  assert.equal(partial.inputTokens, 1000, "the gateway's minimum");
  close(partial.costUsd, usageCost({ model: "muse-wonder-1.0", inputTokens: 1000, cachedInputTokens: 0, outputTokens: 1000 }) + 2 * 0.0025);
});

test("transcription stream: billed by the most audio processed, else by the WAV, and not at all when it failed first", async () => {
  const events = sse([
    { event: "transcript", data: { type: "transcript", transcript: "How is the weather", final: false, audioProcessedMs: 2400 } },
    { event: "audioProgress", data: { type: "audioProgress", audioProcessedMs: 4640 } },
    { event: "speechComplete", data: { type: "speechComplete", turnId: 1, transcript: "How is the weather?", audioProcessedMs: 4000 } },
  ]);
  const [item] = await meterStream(docsStreamMeter(asr, "muse-voice-transcribe-1.0", { audioMs: 9000 }), streamOf(events, 9));
  assert.equal(item.audioSeconds, 4.64);
  const [fallback] = await meterStream(docsStreamMeter(asr, "muse-voice-transcribe-1.0", { audioMs: 9000 }), streamOf(sse([{ data: { type: "x" } }])));
  assert.equal(fallback.audioSeconds, 9);
  const failed = await meterStream(
    docsStreamMeter(asr, "muse-voice-transcribe-1.0", { audioMs: 9000 }),
    streamOf(sse([{ event: "error", data: { type: "error", message: "bad audio" } }])),
  );
  assert.deepEqual(failed, []);
});

test("a body that errors mid-read records what was seen", async () => {
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) return controller.error(new Error("reset"));
      sent = true;
      controller.enqueue(new TextEncoder().encode(sse([{ data: { choices: [{ delta: { content: "z".repeat(40) } }] } }])));
    },
  });
  const [item] = await meterStream(docsStreamMeter(chat, "muse-spark-1.2"), body);
  assert.equal(item.outputTokens, 1000);
  assert.deepEqual(docsMinimalUsage(at("GET", "models"), "muse-wonder-1.0"), []);
  assert.equal(docsMinimalUsage(asr, "muse-voice-transcribe-1.0", 1500)[0].audioSeconds, 1.5);
});

test("streams say whether they showed their final usage: a stream without it was cut off", async () => {
  const chatDone = sse([
    { data: { choices: [{ index: 0, delta: { content: "hi" } }] } },
    { data: { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } } },
    { data: "[DONE]" },
  ]);
  assert.equal((await readMetered(docsStreamMeter(chat, "muse-wonder-1.0"), streamOf(chatDone))).complete, true);
  const chatCut = sse([{ data: { choices: [{ index: 0, delta: { content: "hi" } }] } }]);
  assert.equal((await readMetered(docsStreamMeter(chat, "muse-wonder-1.0"), streamOf(chatCut))).complete, false);

  const start = { event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } } };
  const messagesDone = sse([
    start,
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);
  assert.equal((await readMetered(docsStreamMeter(messages, "muse-wonder-1.0"), streamOf(messagesDone))).complete, true);
  const messagesCut = sse([start, { event: "message_delta", data: { type: "message_delta", delta: {}, usage: { output_tokens: 3 } } }]);
  assert.equal((await readMetered(docsStreamMeter(messages, "muse-wonder-1.0"), streamOf(messagesCut))).complete, false);

  const usage = { input_tokens: 10, output_tokens: 2 };
  const responsesDone = sse([{ event: "response.completed", data: { type: "response.completed", response: { id: "r", output: [], usage } } }]);
  assert.equal((await readMetered(docsStreamMeter(responses, "muse-wonder-1.0"), streamOf(responsesDone))).complete, true);
  const responsesCut = sse([{ event: "response.created", data: { type: "response.created", response: { id: "r" } } }]);
  assert.equal((await readMetered(docsStreamMeter(responses, "muse-wonder-1.0"), streamOf(responsesCut))).complete, false);
  assert.equal((await readMetered(docsStreamMeter(responses, "sam-3.1"), streamOf(samStream, 4096))).complete, true, "SAM's final usage counts images");

  // A body that errors is never complete, even after its usage chunk.
  let sent = false;
  const broken = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) return controller.error(new Error("reset"));
      sent = true;
      controller.enqueue(new TextEncoder().encode(chatDone.replace("data: [DONE]\n\n", "")));
    },
  });
  const read = await readMetered(docsStreamMeter(chat, "muse-wonder-1.0"), broken);
  assert.equal(read.complete, false);
  assert.equal(read.items[0].inputTokens, 3, "what it saw is still reported");
});

test("usageShown: a JSON reply without usage can't be metered from", () => {
  assert.equal(usageShown(responses, { status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } }), true);
  assert.equal(usageShown(responses, { status: "queued", output: [], usage: null }), false);
  assert.equal(usageShown(responses, { status: "completed", output: [{ type: "image_generation_call", result: "A" }] }), true, "images bill by count");
  assert.equal(usageShown(chat, { choices: [] }), false);
  assert.equal(usageShown(messages, { content: [], usage: { input_tokens: 1, output_tokens: 1 } }), true);
  assert.equal(usageShown(images, { data: [] }), true, "no images back is a known zero");
  assert.equal(usageShown(images, { created: 1 }), false);
  assert.equal(usageShown(asr, { transcript: "hi", audioDurationMs: 0 }), true);
  assert.equal(usageShown(asr, { transcript: "hi" }), false);
  assert.equal(usageShown(responses, null), false);
});
