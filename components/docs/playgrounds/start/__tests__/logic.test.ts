/**
 * The "start" group's pure logic: the pricing calculator against the pricing page's own examples, the retry planner
 * against the error-handling page's rules, and the error lab's cases and reply readers. Fixtures are small real
 * replies from the docs proxy (Oct 30, 2026), with the safety identifier removed. Nothing here touches the network.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/start/__tests__/logic.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { PRICES } from "@/lib/meta/pricing";
import { isAllowedEndpoint } from "@/lib/docs/client/endpoints";
import {
  MODEL_CARDS,
  RATE_LIMITS,
  SPARK_RATES,
  TOKEN_MODELS,
  WONDER_RATES,
} from "@/components/docs/playgrounds/start/facts";
import {
  audioCostLines,
  compareTokenWorkload,
  costOfUsage,
  exactUsd,
  imageCostLines,
  rateLimitFit,
  rateText,
  samBilledFrames,
  samCostLines,
  sumUsd,
  tokenCostLines,
} from "@/components/docs/playgrounds/start/pricing";
import {
  backoffMs,
  gaveUpAdvice,
  PAGE_POLICY,
  planRetries,
  RETRY_SCENARIOS,
  retryCode,
  secondsLabel,
  seededRandom,
  timelineVerdict,
  verdictFor,
} from "@/components/docs/playgrounds/start/retry";
import {
  answeredByMeta,
  displayCaseBody,
  ERROR_CASES,
  errorCase,
  errorParts,
  missesTarget,
  STATUS_ADVICE,
  whoAnswered,
} from "@/components/docs/playgrounds/start/error-cases";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as Record<string, unknown>;

describe("facts", () => {
  it("prices agree with lib/meta/pricing, which the kit's estimates use", () => {
    const p = PRICES as unknown as Record<string, { input: number; cachedInput: number; output: number }>;
    assert.deepEqual({ ...WONDER_RATES.standard }, { input: p["muse-wonder-1.0"].input, cachedInput: p["muse-wonder-1.0"].cachedInput, output: p["muse-wonder-1.0"].output });
    for (const id of ["muse-spark-1.3", "muse-spark-1.2", "muse-spark-1.1"]) {
      assert.deepEqual({ ...SPARK_RATES.standard }, { input: p[id].input, cachedInput: p[id].cachedInput, output: p[id].output }, id);
    }
    for (const id of ["muse-spark-1.3-contributor", "muse-spark-1.2-contributor"]) {
      assert.deepEqual({ ...SPARK_RATES.contributor }, { input: p[id].input, cachedInput: p[id].cachedInput, output: p[id].output }, id);
    }
    assert.equal(WONDER_RATES.contributor, null, "the page: Contributor mode isn't available for Muse Wonder");
  });

  it("has a card and a rate-limit row for every model GET /v1/models returns", () => {
    const ids = (fixture("models-list").data as Array<{ id: string }>).map((m) => m.id).sort();
    assert.deepEqual(MODEL_CARDS.map((m) => m.id).sort(), ids);
    assert.deepEqual(RATE_LIMITS.map((l) => l.model).sort(), ids);
    assert.equal(TOKEN_MODELS.filter((m) => m.id).length, 6);
  });
});

describe("pricing", () => {
  it("prices a cached workload line by line: uncached input, cached input, output, searches", () => {
    const lines = tokenCostLines(SPARK_RATES.contributor, { input: 60_000, cached: 50_000, output: 1_500, searches: 2 });
    assert.deepEqual(
      lines.map((l) => [l.label, l.quantity]),
      [
        ["Input, not cached", 10_000],
        ["Cached input", 50_000],
        ["Output, reasoning included", 1_500],
        ["Web searches", 2],
      ],
    );
    // 10,000 x $0.10 + 50,000 x $0.002 + 1,500 x $0.20, per 1M, plus 2 x $0.0025.
    assert.ok(Math.abs(sumUsd(lines) - (0.001 + 0.0001 + 0.0003 + 0.005)) < 1e-12);
    assert.equal(lines[1].rate, "$0.002 per 1M tokens");
  });

  it("never counts more cached tokens than input, and ignores junk", () => {
    const lines = tokenCostLines(WONDER_RATES.standard, { input: 100, cached: 500, output: Number.NaN });
    assert.equal(lines[0].quantity, 0);
    assert.equal(lines[1].quantity, 100);
    assert.equal(lines[2].quantity, 0);
  });

  it("bills images per image, audio in whole seconds rounded down, SAM at 50 frames a video at least", () => {
    assert.equal(sumUsd(imageCostLines(3)), 0.03);
    const audio = audioCostLines(3600.9);
    assert.equal(audio[0].quantity, 3600);
    assert.ok(Math.abs(sumUsd(audio) - 0.18) < 1e-12);
    assert.equal(samBilledFrames(24), 50);
    assert.equal(samBilledFrames(120), 120);
    assert.equal(samBilledFrames(0), 0);
    const sam = samCostLines(1000, 24, 10);
    assert.ok(Math.abs(sumUsd(sam) - (2.5 + 0.1)) < 1e-12, "1,000 images, then 10 requests x 50 frames x $0.0002");
    assert.match(sam[1].label, /50-frame minimum/);
  });

  it("compares a workload on every token model, with Muse Wonder Contributor not available", () => {
    const rows = compareTokenWorkload({ input: 1_000_000, cached: 0, output: 0 }, 2);
    const by = Object.fromEntries(rows.map((r) => [r.row.label, r.usd]));
    assert.equal(by["Muse Wonder 1.0"], 8);
    assert.equal(by["Muse Spark 1.3"], 2.5);
    assert.equal(by["Muse Spark 1.3 Contributor"], 0.2);
    assert.equal(by["Muse Wonder 1.0 Contributor"], null);
  });

  it("turns a real reply's usage into the page's line items, for the model that ran", () => {
    const reply = fixture("responses-first-call");
    const cost = costOfUsage(String(reply.model), reply.usage);
    assert.equal(cost.priced, true);
    assert.equal(cost.tokens?.reasoning, 685);
    assert.ok(Math.abs(cost.usd - (15 * 0.1 + 701 * 0.2) / 1e6) < 1e-15);
    assert.equal(costOfUsage("muse-spark-1.3", reply.usage).model, "muse-spark-1.3-contributor", "1.3 is priced as the Contributor model it runs as");
    assert.equal(costOfUsage("muse-image-1.0", reply.usage).priced, false);
    const chat = fixture("chat-reply");
    assert.ok(costOfUsage("muse-spark-1.3-contributor", chat.usage).usd > 0, "Chat Completions usage reads too");
  });

  it("formats exact amounts and rates the way the page writes them", () => {
    assert.equal(exactUsd(0), "$0");
    assert.equal(exactUsd(0.000072), "$0.000072");
    assert.equal(exactUsd(0.0125), "$0.0125");
    assert.equal(exactUsd(1234.5), "$1,234.50");
    assert.equal(rateText(0.1), "$0.10");
    assert.equal(rateText(4), "$4.00");
    assert.equal(rateText(0.002), "$0.002");
  });

  it("finds the binding rate limit", () => {
    const fit = rateLimitFit("muse-spark-1.3-contributor", 120, 30_000)!;
    assert.equal(fit.maxRequestsPerMinute, 100, "3,000,000 TPM / 30,000 tokens");
    assert.equal(fit.binding, "tokens");
    assert.equal(fit.fits, false);
    const ok = rateLimitFit("muse-wonder-1.0", 100, 1_000)!;
    assert.equal(ok.binding, "requests");
    assert.equal(ok.maxRequestsPerMinute, 3000);
    assert.equal(ok.fits, true);
    assert.equal(rateLimitFit("muse-image-1.0", 10, 0)!.tokenShare, null, "no TPM limit on Muse Image");
    assert.equal(rateLimitFit("nope", 1, 1), null);
  });
});

describe("retry planner", () => {
  it("follows the page's rules on what to retry", () => {
    for (const status of [429, 500, 503]) assert.equal(verdictFor({ status }).verdict, "retry", String(status));
    for (const status of [400, 401, 402, 403, 404, 413]) assert.equal(verdictFor({ status }).verdict, "fix", String(status));
    assert.equal(verdictFor({ status: 504 }).verdict, "rethink");
    assert.equal(verdictFor({ status: 200 }).verdict, "success");
    assert.equal(verdictFor({ status: 200, midStream: true, code: "server_shutting_down" }).verdict, "retry");
  });

  it("doubles from 500 ms and treats Retry-After as a floor", () => {
    assert.deepEqual([1, 2, 3].map((r) => backoffMs(PAGE_POLICY, r)), [500, 1000, 2000]);
    const t = planRetries([{ status: 429, retryAfterSec: 15 }, { status: 200 }], PAGE_POLICY, () => 0.5);
    assert.equal(t.result, "success");
    assert.equal(t.steps[0].wait?.totalMs, 15_000);
    assert.equal(t.steps[0].wait?.byRetryAfter, true);
    assert.equal(t.steps[1].atMs, 15_000);
    const noFloor = planRetries([{ status: 429, retryAfterSec: 15 }, { status: 200 }], { ...PAGE_POLICY, honorRetryAfter: false }, () => 0.5);
    assert.equal(noFloor.steps[0].wait?.totalMs, 1000, "500 ms backoff + 500 ms jitter");
  });

  it("gives up after the last attempt, repeating the last outcome", () => {
    const t = planRetries([{ status: 500 }], { ...PAGE_POLICY, maxAttempts: 3, jitterMs: 0 }, () => 0);
    assert.equal(t.result, "gave_up");
    assert.equal(t.steps.length, 3);
    assert.equal(t.steps[2].gaveUp, true);
    assert.equal(t.totalMs, 500 + 1000);
  });

  it("stops at once on a request that needs fixing or rethinking", () => {
    assert.equal(planRetries([{ status: 400 }], PAGE_POLICY, () => 0).steps.length, 1);
    assert.equal(planRetries([{ status: 504 }], PAGE_POLICY, () => 0).result, "rethink");
  });

  it("draws the same jitter from the same seed, and every scenario plays", () => {
    const a = seededRandom(7);
    const b = seededRandom(7);
    const xs = [a(), a(), a()];
    assert.deepEqual(xs, [b(), b(), b()]);
    assert.ok(xs.every((x) => x >= 0 && x < 1));
    for (const s of RETRY_SCENARIOS) assert.ok(planRetries(s.outcomes, PAGE_POLICY, seededRandom(1)).steps.length >= 1, s.id);
    assert.equal(planRetries(RETRY_SCENARIOS.find((s) => s.id === "overloaded")!.outcomes, PAGE_POLICY, seededRandom(1)).totalMs, 120_000);
  });

  it("waits out a mid-stream error with the backoff alone: its headers went out with the 200", () => {
    const scenario = RETRY_SCENARIOS.find((s) => s.id === "mid-stream")!;
    assert.equal(scenario.outcomes[0].retryAfterSec, undefined);
    const t = planRetries([{ status: 200, code: "server_shutting_down", midStream: true, retryAfterSec: 30 }, { status: 200 }], PAGE_POLICY, () => 0);
    assert.deepEqual(t.steps[0].wait, { backoffMs: 500, jitterMs: 0, retryAfterMs: 0, totalMs: 500, byRetryAfter: false }, "even a stray Retry-After is ignored");
    assert.equal(t.result, "success");
  });

  it("says what to do after the last attempt by what failed: slow down on 429s, check the service on 5xx", () => {
    const twice429 = planRetries(RETRY_SCENARIOS.find((s) => s.id === "rate-limit-backoff")!.outcomes, { ...PAGE_POLICY, maxAttempts: 2 }, () => 0);
    assert.equal(twice429.result, "gave_up");
    const verdict = timelineVerdict(twice429);
    assert.match(verdict, /^Gave up after 2 attempts\. Still rate limited/);
    assert.match(verdict, /x-ratelimit-remaining-requests/);
    assert.doesNotMatch(verdict, /500s/);
    assert.match(gaveUpAdvice({ status: 500 }), /If 500s persist, check the API status page/);
    assert.match(gaveUpAdvice({ status: 503, code: "service_overloaded" }), /GET \/v1\/status/);
    assert.match(gaveUpAdvice({ status: 200, code: "server_shutting_down", midStream: true }), /status page/);
    assert.equal(timelineVerdict(planRetries([{ status: 429 }], { ...PAGE_POLICY, maxAttempts: 1 }, () => 0)).startsWith("Gave up after 1 attempt."), true);
    assert.match(timelineVerdict(planRetries([{ status: 400 }], PAGE_POLICY, () => 0)), /needs a fixed request/);
    assert.match(timelineVerdict(planRetries([{ status: 429, retryAfterSec: 15 }, { status: 200 }], PAGE_POLICY, () => 0)), /^Succeeded on attempt 2, 15 s after/);
  });

  it("writes the policy as code that turns off the SDK's own retries and honors Retry-After", () => {
    const py = retryCode(PAGE_POLICY, "python", "muse-spark-1.3-contributor");
    assert.match(py, /max_retries=0/);
    assert.match(py, /retry-after/);
    assert.match(py, /max_attempts=4, base=0\.5, factor=2, jitter=1/);
    const ts = retryCode({ ...PAGE_POLICY, honorRetryAfter: false }, "typescript", "muse-spark-1.3-contributor");
    assert.doesNotMatch(ts, /retry-after/);
    assert.match(ts, /process\.env\.MODEL_API_KEY/);
    assert.equal(secondsLabel(500), "500 ms");
    assert.equal(secondsLabel(40), "40 ms");
    assert.equal(secondsLabel(0), "0 s");
    assert.equal(secondsLabel(1500), "1.5 s");
    assert.equal(secondsLabel(15_000), "15 s");
    assert.equal(secondsLabel(62_000), "1 min 2 s");
  });
});

describe("error lab", () => {
  it("has a case for each failure it names, each sent to an endpoint the proxy runs (or deliberately not)", () => {
    for (const c of ERROR_CASES) {
      const allowed = isAllowedEndpoint(c.method, c.path);
      assert.equal(allowed, c.id !== "unknown-path", `${c.id}: ${c.method} ${c.path}`);
      assert.ok(c.teaches && c.fix && c.anchor, c.id);
      if (c.answeredBy === "proxy") assert.ok(c.metaWouldSay, `${c.id} says what Meta itself answers`);
    }
    for (const s of STATUS_ADVICE) if (s.liveCase) assert.ok(errorCase(s.liveCase), s.liveCase);
    assert.deepEqual(STATUS_ADVICE.map((s) => s.status), [400, 401, 402, 403, 404, 413, 429, 500, 503, 504]);
  });

  it("reads Meta's envelope, a body that isn't JSON, and who answered", () => {
    const meta = errorParts(404, fixture("model-not-found"), "");
    assert.deepEqual(meta, {
      status: 404,
      type: "invalid_request_error",
      code: "model_not_found",
      param: null,
      message: "The model `bogus-model` does not exist or is not available",
      envelope: true,
    });
    const plain = errorParts(400, null, "invalid order: sideways");
    assert.equal(plain.envelope, false);
    assert.equal(plain.message, "invalid order: sideways");
    assert.equal(answeredByMeta({ "x-request-id": "abc" }), true);
    assert.equal(answeredByMeta({ "content-type": "application/json" }), false);
  });

  it("shows the page's 413 as a recorded example instead of sending a body the host refuses first", () => {
    const c = errorCase("too-large")!;
    assert.ok(c.recorded, "recorded, not live");
    assert.equal(c.body, undefined);
    assert.equal(c.raw, undefined);
    assert.equal(c.answeredBy, "meta");
    assert.deepEqual(c.expect, { status: 413, type: "invalid_request_error", code: "payload_too_large", param: null });
    assert.equal(c.recorded.replies.length, 2, "the page's two 413 bodies");
    for (const reply of c.recorded.replies) {
      const parts = errorParts(413, reply.body, "");
      assert.equal(parts.code, "payload_too_large", reply.cause);
      assert.equal(parts.type, "invalid_request_error", reply.cause);
      assert.equal(missesTarget(c, parts), false, `${reply.cause} is the error the case is about`);
    }
    assert.deepEqual(STATUS_ADVICE.find((s) => s.status === 413)!.example, c.recorded.replies[0].body);
    assert.match(c.recorded.why, /1\.1 MB background request/);
    const shown = displayCaseBody(c)!;
    assert.ok(shown.length < 200);
    assert.match(shown, /"background": true/);
    assert.equal(displayCaseBody(errorCase("bad-json")!), errorCase("bad-json")!.raw);
    assert.throws(() => JSON.parse(errorCase("bad-json")!.raw!), "the malformed case really is malformed");
  });

  it("knows Meta's replies, the proxy's own, and a host's plain-text page apart, and flags a reply a case doesn't aim for", () => {
    const meta = errorParts(404, fixture("model-not-found"), "");
    assert.equal(whoAnswered({ "x-request-id": "abc" }, meta), "meta");
    const proxy = errorParts(400, { error: { message: "bad", type: "invalid_request_error", code: "invalid_body", param: null } }, "");
    assert.equal(whoAnswered({ "content-type": "application/json" }, proxy), "proxy");
    // What a platform limit sends back: plain text, no envelope, no request id.
    const host = errorParts(413, null, "Request Entity Too Large FUNCTION_PAYLOAD_TOO_LARGE");
    assert.equal(whoAnswered({ "content-type": "text/plain" }, host), "other");
    const unknownModel = errorCase("unknown-model")!;
    assert.equal(missesTarget(unknownModel, meta), false);
    assert.equal(missesTarget(unknownModel, host), true, "another status");
    assert.equal(missesTarget(unknownModel, errorParts(404, { error: { message: "x", type: "not_found_error", code: "unknown_endpoint" } }, "")), true, "same status, another code");
    assert.equal(missesTarget(unknownModel, errorParts(404, null, "Not Found")), true, "same status, no envelope");
    const topP = errorCase("top-p")!;
    assert.equal(missesTarget(topP, errorParts(400, { error: { message: "`top_p`: The number must be `<= 1.0`.", type: "invalid_request_error", code: null, param: "top_p" } }, "")), false, "code null is expected");
  });
});
