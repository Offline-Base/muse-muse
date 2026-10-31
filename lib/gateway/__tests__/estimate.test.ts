import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_OUTPUT_TOKENS, estimateCost, MAX_OUTPUT_TOKENS } from "@/lib/gateway/estimate";
import { buildTokenBudgetFor, DEFAULT_LIMITS, liveTokenDailyBudgetFor } from "@/lib/gateway/policy";
import type { ParsedRequest } from "@/lib/gateway/extract";
import { PREVIOUS_RESPONSE_TOKENS, SEARCH_CONTEXT_TOKENS } from "@/lib/gateway/search";

const jsonReq = (json: Record<string, unknown>): ParsedRequest => ({
  kind: "json",
  json,
  model: typeof json.model === "string" ? json.model : null,
});
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

test("Responses: text at 4 characters per token, output from max_output_tokens (default and cap)", () => {
  const text = "x".repeat(4000);
  near(estimateCost("responses", jsonReq({ model: "muse-spark-1.3", input: text }), 0), (1000 * 1.25 + DEFAULT_OUTPUT_TOKENS * 4.25) / 1e6);
  near(
    estimateCost("responses", jsonReq({ model: "muse-wonder-1.0", input: text, max_output_tokens: 500 }), 0),
    (1000 * 4 + 500 * 20) / 1e6,
  );
  near(
    estimateCost("responses", jsonReq({ model: "muse-wonder-1.0", input: "", max_output_tokens: 1e9 }), 0),
    (MAX_OUTPUT_TOKENS * 20) / 1e6,
  );
});

test("Responses: base64 media counts per part, not per byte", () => {
  const photo = `data:image/jpeg;base64,${"A".repeat(3_000_000)}`;
  const body = {
    model: "muse-spark-1.3",
    max_output_tokens: 1000,
    input: [{ role: "user", content: [{ type: "input_text", text: "what is this?" }, { type: "input_image", image_url: photo }] }],
  };
  const cost = estimateCost("responses", jsonReq(body), photo.length);
  assert.ok(cost < 0.01, `a 3 MB photo is a few thousand tokens, not $${cost}`);
  const video = { ...body, input: [{ role: "user", content: [{ type: "input_video", video_url: "https://x.public.blob.vercel-storage.com/a.mp4" }] }] };
  assert.ok(estimateCost("responses", jsonReq(video), 0) > cost, "video by URL is assumed bigger");
});

test("Responses: tools, text.format and instructions count as input", () => {
  const base = { model: "muse-wonder-1.0", input: "", max_output_tokens: 16 };
  const plain = estimateCost("responses", jsonReq(base), 0);
  const chars = "x".repeat(4000);
  for (const extra of [
    { instructions: chars },
    { tools: [{ type: "function", name: "", description: chars }] },
    { text: { format: { type: "json_schema", schema: { description: chars } } } },
  ]) {
    const cost = estimateCost("responses", jsonReq({ ...base, ...extra }), 0);
    assert.ok(cost - plain >= (1000 * 4) / 1e6, JSON.stringify(extra).slice(0, 60));
    assert.ok(cost - plain < (1100 * 4) / 1e6, JSON.stringify(extra).slice(0, 60));
  }
});

test("Responses: previous_response_id counts as 10,000 input tokens of stored turns", () => {
  const base = { model: "muse-wonder-1.0", input: "hi", max_output_tokens: 16 };
  const plain = estimateCost("responses", jsonReq(base), 0);
  near(estimateCost("responses", jsonReq({ ...base, previous_response_id: "resp_1" }), 0) - plain, (PREVIOUS_RESPONSE_TOKENS * 4) / 1e6);
  near(estimateCost("responses", jsonReq({ ...base, previous_response_id: "" }), 0), plain);
  near(estimateCost("responses", jsonReq({ ...base, previous_response_id: null }), 0), plain);
});

test("Responses: each search allowed adds its fee and 8,000 tokens of results", () => {
  const base = { model: "muse-wonder-1.0", input: "hi", max_output_tokens: 16 };
  const plain = estimateCost("responses", jsonReq(base), 0);
  const eachSearch = 0.0025 + (SEARCH_CONTEXT_TOKENS * 4) / 1e6;
  const tools = [{ type: "web_search" }];
  // The tool's own 10 characters count as input: 12 characters is 3 tokens, where "hi" alone is 1.
  const toolChars = ((3 - 1) * 4) / 1e6;
  near(estimateCost("responses", jsonReq({ ...base, tools, max_tool_calls: 2 }), 0, 5) - plain - toolChars, 2 * eachSearch);
  near(estimateCost("responses", jsonReq({ ...base, tools }), 0, 5) - plain - toolChars, 5 * eachSearch);
  near(estimateCost("responses", jsonReq({ ...base, tools, max_tool_calls: 99 }), 0, 8) - plain - toolChars, 8 * eachSearch);
  near(estimateCost("responses", jsonReq({ ...base, tools }), 0) - plain - toolChars, 8 * eachSearch);
  near(estimateCost("responses", jsonReq({ ...base, tools }), 0, 0) - plain - toolChars, 0);
  const onlyFunctions = estimateCost("responses", jsonReq({ ...base, tools: [{ type: "function", name: "f" }] }), 0, 5);
  assert.ok(onlyFunctions - plain < 0.001, "a function tool isn't a search");
  const toolSearch = estimateCost("responses", jsonReq({ ...base, tools: [{ type: "tool_search" }] }), 0, 5);
  assert.ok(toolSearch - plain < 0.001, "tool search has no search fee");
});

test("Responses: inline files count by size, never below the guess per part", () => {
  const base = { model: "muse-wonder-1.0", max_output_tokens: 16 };
  const part = (url: string) => [{ role: "user", content: [{ type: "input_file", file_url: url }] }];
  const small = `data:text/plain;base64,${"A".repeat(400)}`;
  const big = `data:application/pdf;base64,${"A".repeat(3_000_000)}`;
  const smallCost = estimateCost("responses", jsonReq({ ...base, input: part(small) }), 0);
  assert.ok(smallCost >= (20_000 * 4) / 1e6, "a small file keeps the room it always had");
  const bigCost = estimateCost("responses", jsonReq({ ...base, input: part(big) }), 0);
  assert.ok(bigCost >= (45_000 * 4) / 1e6, `a big PDF counts by its pages, not $${bigCost}`);
});

test("image and SAM models ignore searches: their price isn't by the token", () => {
  const tools = [{ type: "web_search" }];
  near(estimateCost("responses", jsonReq({ model: "muse-image-1.0", input: "cat", tools }), 0, 5), 0.01);
  near(estimateCost("responses", jsonReq({ model: "sam-3.1", input: [{ content: [{ type: "input_image", image_url: "x" }] }], tools }), 0, 5), 0.0025);
});

test("per-image, per-frame and per-second models", () => {
  near(estimateCost("images/generations", jsonReq({ model: "muse-image-1.0", prompt: "cat", n: 3 }), 0), 0.03);
  near(estimateCost("images/generations", jsonReq({ model: "muse-image-1.0", prompt: "cat", n: 500 }), 0), 0.1);
  near(estimateCost("responses", jsonReq({ model: "muse-image-1.0", input: "cat" }), 0), 0.01);
  const form = new FormData();
  form.set("model", "muse-image-1.0");
  form.set("n", "2");
  near(estimateCost("images/edits", { kind: "multipart", form, model: "muse-image-1.0" }, 0), 0.02);

  const sam = estimateCost("responses", jsonReq({ model: "sam-3.1", input: [{ content: [{ type: "input_image", image_url: "x" }] }] }), 0);
  near(sam, 0.0025);
  const samVideo = estimateCost("responses", jsonReq({ model: "sam-3.1", input: [{ content: [{ type: "input_video", video_url: "x" }] }] }), 0);
  assert.ok(samVideo > sam);

  // 32,000 bytes of 16 kHz mono WAV is one second; the JSON extension assumes the largest download.
  const asrForm = new FormData();
  near(
    estimateCost("asr/transcribe", { kind: "multipart", form: asrForm, model: "muse-voice-transcribe-1.0" }, 32_000 * 3600),
    0.18,
  );
  const asrJson = estimateCost("asr/transcribe", jsonReq({ model: "muse-voice-transcribe-1.0", audioUrl: "x" }), 100);
  assert.ok(asrJson > 0.09 && asrJson < 0.1, String(asrJson));

  assert.equal(estimateCost("files", { kind: "raw", model: null }, 4_000_000), 0);
});

test("a build's test budget is $10 whatever models the product may call", () => {
  assert.equal(buildTokenBudgetFor(["muse-spark-1.3", "sam-3.1"]), 10);
  assert.equal(buildTokenBudgetFor(["muse-wonder-1.0"]), 10);
  assert.equal(buildTokenBudgetFor([]), 10);
});

test("a live product's daily budget fits 20 runs plus one, between the floor and $10", () => {
  assert.equal(liveTokenDailyBudgetFor(undefined), DEFAULT_LIMITS.liveTokenDailyBudgetUsd);
  assert.equal(liveTokenDailyBudgetFor(0.01), DEFAULT_LIMITS.liveTokenDailyBudgetUsd);
  assert.equal(liveTokenDailyBudgetFor(0.3), Math.max(DEFAULT_LIMITS.liveTokenDailyBudgetUsd, 7));
  assert.equal(liveTokenDailyBudgetFor(5), 10);
});
