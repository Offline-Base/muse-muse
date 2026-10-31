/**
 * Wave 3, unit 2 (docs/CAPABILITIES.md, section 8): a call the budget left can't cover at its max_output_tokens runs
 * with a lower one instead of being refused, when ENGINE_FIT_OUTPUT is on (deps.fitOutputToBudget) or for a Muse Code
 * session token (code_session, unit 9). Off, the gateway answers exactly as it does today.
 *
 *   npx tsx --test lib/gateway/__tests__/fit-output.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateCost, fitOutputToBudget, MAX_OUTPUT_TOKENS, MIN_FIT_OUTPUT_TOKENS } from "@/lib/gateway/estimate";
import type { ParsedRequest } from "@/lib/gateway/extract";
import { handleGateway } from "@/lib/gateway/handler";
import { fakeGateway, gatewayRequest, json } from "./helpers";

const JSON_CT = { "content-type": "application/json" };
const jsonReq = (body: Record<string, unknown>): ParsedRequest => ({ kind: "json", json: body, model: typeof body.model === "string" ? body.model : null });
/** About 30,000 input tokens, the size of a Muse Code turn a few steps in. */
const SESSION_TURN = { model: "muse-wonder-1.0", input: "x".repeat(120_000), max_output_tokens: 128_000 };

test("a Muse Code turn on Wonder is estimated at about $0.76, so a $1 budget refuses it after $0.24 without fitting", () => {
  const estimate = estimateCost("responses", jsonReq(SESSION_TURN), 0, 0);
  assert.ok(estimate > 0.75 && estimate < 0.77, String(estimate));
  assert.ok(0.25 + estimate > 1, "with $0.25 spent, today's check refuses the call");
});

test("fitting lowers max_output_tokens to what the budget left pays for, and the new estimate fits", () => {
  const parsed = jsonReq(SESSION_TURN);
  const estimate = estimateCost("responses", parsed, 0, 0);
  for (const left of [0.7, 0.4, 0.2]) {
    const fit = fitOutputToBudget({ endpoint: "responses", parsed, bodyBytes: 0, mostSearches: 0, estimate, leftUsd: left });
    assert.ok(fit, `fits with $${left} left`);
    assert.ok(fit.estimate <= left + 1e-9, `${fit.estimate} <= ${left}`);
    assert.ok(fit.maxOutputTokens >= MIN_FIT_OUTPUT_TOKENS && fit.maxOutputTokens < MAX_OUTPUT_TOKENS);
    near(fit.estimate, estimateCost("responses", jsonReq({ ...SESSION_TURN, max_output_tokens: fit.maxOutputTokens }), 0, 0));
  }
  // 30,000 input tokens cost $0.12 on Wonder, so $0.125 left can't pay for 1,024 output tokens ($0.02).
  assert.equal(fitOutputToBudget({ endpoint: "responses", parsed, bodyBytes: 0, mostSearches: 0, estimate, leftUsd: 0.125 }), null);
});

test("fitting leaves alone a call that fits, a call with nothing left, and calls not priced by output tokens", () => {
  const parsed = jsonReq(SESSION_TURN);
  const estimate = estimateCost("responses", parsed, 0, 0);
  assert.equal(fitOutputToBudget({ endpoint: "responses", parsed, bodyBytes: 0, mostSearches: 0, estimate, leftUsd: 1 }), null);
  assert.equal(fitOutputToBudget({ endpoint: "responses", parsed, bodyBytes: 0, mostSearches: 0, estimate, leftUsd: 0 }), null);
  const sam = jsonReq({ model: "sam-3.1", input: [{ type: "input_image", image_url: "https://x/a.png" }] });
  assert.equal(fitOutputToBudget({ endpoint: "responses", parsed: sam, bodyBytes: 0, mostSearches: 0, estimate: 1, leftUsd: 0.5 }), null);
  const image = jsonReq({ model: "muse-image-1.0", prompt: "a cat" });
  assert.equal(fitOutputToBudget({ endpoint: "images/generations", parsed: image, bodyBytes: 0, mostSearches: 0, estimate: 1, leftUsd: 0.5 }), null);
});

function near(a: number, b: number) {
  assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
}

const usageReply = { usage: { input_tokens: 100, output_tokens: 10 } };

test("handler, fitting on: a call over the budget left runs with a lower max_output_tokens and says so", async () => {
  const g = fakeGateway({ token: { allowedModels: ["muse-wonder-1.0"], dailyBudgetUsd: 1 }, tokenSpend: 0.3, fetch: async () => Response.json(usageReply) });
  g.deps.fitOutputToBudget = true;
  const res = await handleGateway(gatewayRequest("responses", json(SESSION_TURN), JSON_CT), ["responses"], g.deps);
  assert.equal(res.status, 200);
  const sent = JSON.parse(String(g.upstreamCalls[0]!.init?.body ? new TextDecoder().decode(g.upstreamCalls[0]!.init.body as Uint8Array) : "{}"));
  assert.ok(sent.max_output_tokens < 128_000 && sent.max_output_tokens >= MIN_FIT_OUTPUT_TOKENS, String(sent.max_output_tokens));
  assert.match(res.headers.get("x-musemuse-note") ?? "", /Set max_output_tokens to \d+: that is what's left in this product's Meta budget/);
  await res.arrayBuffer();
  await g.settled();
});

test("handler, fitting off: the same call is refused as today", async () => {
  const g = fakeGateway({ token: { allowedModels: ["muse-wonder-1.0"], dailyBudgetUsd: 1 }, tokenSpend: 0.3, fetch: async () => Response.json(usageReply) });
  const res = await handleGateway(gatewayRequest("responses", json(SESSION_TURN), JSON_CT), ["responses"], g.deps);
  assert.equal(res.status, 429);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, "budget_exceeded");
  assert.equal(g.upstreamCalls.length, 0);
});

test("handler: a Muse Code session token (code_session, unit 9) is fitted with the flag off", async () => {
  const g = fakeGateway({ token: { allowedModels: ["muse-wonder-1.0"], dailyBudgetUsd: 1, scope: "code_session" as "live" }, tokenSpend: 0.3, fetch: async () => Response.json(usageReply) });
  const res = await handleGateway(gatewayRequest("responses", json(SESSION_TURN), JSON_CT), ["responses"], g.deps);
  assert.notEqual(res.status, 429);
  await res.arrayBuffer();
  await g.settled();
});
