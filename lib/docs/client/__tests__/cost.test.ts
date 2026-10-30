/**
 * Token counts and cost from all three usage shapes, priced through lib/meta/pricing.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/docs/client/__tests__/cost.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { estimateCost, estimateReplyCost, formatUsd, tokenUsage, WEB_SEARCH_USD } from "@/lib/docs/client/cost";
import { PRICES } from "@/lib/meta/pricing";

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-12, `${a} is not ${b}`);

describe("tokenUsage", () => {
  it("reads the Responses shape, cached and reasoning tokens included", () => {
    assert.deepEqual(
      tokenUsage({ input_tokens: 2000, input_tokens_details: { cached_tokens: 1792 }, output_tokens: 300, output_tokens_details: { reasoning_tokens: 250 }, total_tokens: 2300 }),
      { input: 2000, cached: 1792, output: 300, reasoning: 250, total: 2300 },
    );
  });

  it("reads the Chat Completions shape", () => {
    assert.deepEqual(
      tokenUsage({ prompt_tokens: 25, completion_tokens: 19, total_tokens: 44, prompt_tokens_details: { cached_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 12 } }),
      { input: 25, cached: 5, output: 19, reasoning: 12, total: 44 },
    );
  });

  it("reads the Messages shape, adding cache reads and writes to the input", () => {
    assert.deepEqual(
      tokenUsage({ input_tokens: 14, cache_read_input_tokens: 100, cache_creation_input_tokens: 6, output_tokens: 8, output_tokens_details: { thinking_tokens: 5 } }),
      { input: 120, cached: 100, output: 8, reasoning: 5, total: 128 },
    );
  });

  it("returns null for anything else", () => {
    assert.equal(tokenUsage(null), null);
    assert.equal(tokenUsage({ images_processed: 1 }), null);
    assert.equal(tokenUsage("usage"), null);
  });
});

describe("estimateCost", () => {
  it("prices the docs' example response on Spark 1.3 Contributor", () => {
    const p = PRICES["muse-spark-1.3-contributor"];
    const est = estimateCost("muse-spark-1.3-contributor", { input_tokens: 69, output_tokens: 163, total_tokens: 232 });
    assert.ok(est?.priced);
    close(est!.usd, (69 * p.input + 163 * p.output) / 1e6);
  });

  it("prices muse-spark-1.3 as the Contributor model it runs as, and Spark 1.2 with its cached rate", () => {
    const contributor = estimateCost("muse-spark-1.3", { input_tokens: 1000, output_tokens: 1000 })!;
    close(contributor.usd, estimateCost("muse-spark-1.3-contributor", { input_tokens: 1000, output_tokens: 1000 })!.usd);
    const p = PRICES["muse-spark-1.2"];
    const cached = estimateCost("muse-spark-1.2", { prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 800 } })!;
    close(cached.usd, (200 * p.input + 800 * p.cachedInput + 10 * p.output) / 1e6);
  });

  it("prices Spark 1.2 Contributor and Spark 1.1 like their siblings", () => {
    const u = { input_tokens: 5000, output_tokens: 700 };
    close(estimateCost("muse-spark-1.2-contributor", u)!.usd, estimateCost("muse-spark-1.3-contributor", u)!.usd);
    close(estimateCost("muse-spark-1.1", u)!.usd, estimateCost("muse-spark-1.2", u)!.usd);
  });

  it("adds web searches, and says when a model has no price", () => {
    const withSearch = estimateCost("muse-wonder-1.0", { input_tokens: 0, output_tokens: 0 }, { webSearches: 2 })!;
    close(withSearch.usd, 2 * WEB_SEARCH_USD);
    assert.equal(withSearch.webSearches, 2);
    const unknown = estimateCost("some-other-model", { input_tokens: 10, output_tokens: 10 })!;
    assert.equal(unknown.priced, false);
    assert.equal(unknown.usd, 0);
    assert.equal(estimateCost("muse-spark-1.2", null), null);
  });

  it("bills Muse Image per image, SAM per image or frame, and transcription by whole seconds", () => {
    close(estimateCost("muse-image-1.0", { input_tokens: 9999, output_tokens: 9999 }, { images: 2 })!.usd, 2 * PRICES["muse-image-1.0"].perImage);
    close(estimateCost("sam-3.1", { images_processed: 1, input_tokens: 0, output_tokens: 0 })!.usd, PRICES["sam-3.1"].perImage);
    const asr = estimateCost("muse-voice-transcribe-1.0", null, { audioMs: 61_900 })!;
    assert.equal(asr.audioSeconds, 61);
    close(asr.usd, (61 / 3600) * PRICES["muse-voice-transcribe-1.0"].perAudioHour);
  });
});

describe("estimateReplyCost", () => {
  it("counts images in an images reply and image_generation_call items", () => {
    close(estimateReplyCost("muse-image-1.0", { data: [{ b64_json: "UklGR" }, { b64_json: "UklGR" }], usage: { input_tokens: 5, output_tokens: 5 } })!.usd, 0.02);
    close(
      estimateReplyCost(null, { object: "response", model: "muse-image-1.0", output: [{ type: "image_generation_call", result: "UklGR" }] })!.usd,
      0.01,
    );
  });

  it("counts web_search_call items and reads a transcript's audio duration", () => {
    const est = estimateReplyCost("muse-spark-1.3-contributor", {
      object: "response",
      output: [{ type: "web_search_call", status: "completed" }, { type: "message", content: [] }],
      usage: { input_tokens: 0, output_tokens: 0 },
    })!;
    assert.equal(est.webSearches, 1);
    assert.equal(estimateReplyCost("muse-voice-transcribe-1.0", { transcript: "hi", audioDurationMs: 3000 })!.audioSeconds, 3);
  });
});

describe("formatUsd", () => {
  it("keeps tiny amounts readable", () => {
    assert.equal(formatUsd(0), "$0");
    assert.equal(formatUsd(0.00004), "under $0.0001");
    assert.equal(formatUsd(0.0004), "$0.0004");
    assert.equal(formatUsd(0.0125), "$0.013");
    assert.equal(formatUsd(0.5), "$0.50");
    assert.equal(formatUsd(1.234), "$1.23");
  });
});
