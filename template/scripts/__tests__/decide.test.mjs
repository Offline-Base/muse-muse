// Unit tests for lib/meta/decide.ts: what decide() sends to {GATEWAY_URL}/decide, how its errors read, and the
// template's own copy of the build-time stand-in, which must answer exactly as the gateway's does. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/decide.test.mjs
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { decide, DecideError, isDecideOffline, NONE_OPTION, optionId, standInDecision } from "../../lib/meta/decide";
// The platform's own stand-in and gateway, which this template copy must match.
import { labelId, NONE_OPTION as PLATFORM_NONE, standInDecision as platformStandIn } from "../../../lib/decide/format";
import { handleDecide } from "../../../lib/gateway/decide";

const realFetch = globalThis.fetch;
const env = { GATEWAY_URL: process.env.GATEWAY_URL, PRODUCT_TOKEN: process.env.PRODUCT_TOKEN };
let calls = [];

function stubFetch(reply) {
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    calls.push({ url: req.url, headers: req.headers, body: await req.text() });
    return reply(req);
  };
}

const visitor = (headers) => new Request("https://product.example/api/actions/x", { method: "POST", headers });

beforeEach(() => {
  calls = [];
  process.env.GATEWAY_URL = "https://gateway.example/api/gateway/";
  process.env.PRODUCT_TOKEN = "mm_test_token";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const REPLY = {
  decision: "Billing",
  id: "billing",
  confidence: 0.91,
  probabilities: [
    { option: "Billing", id: "billing", p: 0.91 },
    { option: "Shipping", id: "shipping", p: 0.07 },
  ],
  none: 0.02,
  model: "d0d0d0d0-0000-4000-8000-000000000001",
  calibrated: true,
  simulated: false,
  ms: 840,
  note: null,
};

test("decide posts to {GATEWAY_URL}/decide with the product's token and the visitor's IP, and returns the reply", async () => {
  stubFetch(() => Response.json(REPLY));
  const got = await decide({
    state: "I was charged twice",
    model: "d0d0d0d0-0000-4000-8000-000000000001",
    request: visitor({ "x-forwarded-for": "203.0.113.7" }),
  });
  assert.deepEqual(got, REPLY);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://gateway.example/api/gateway/decide");
  assert.equal(calls[0].headers.get("authorization"), "Bearer mm_test_token");
  assert.equal(calls[0].headers.get("x-musemuse-client-ip"), "203.0.113.7");
  assert.deepEqual(JSON.parse(calls[0].body), { state: "I was charged twice", model: "d0d0d0d0-0000-4000-8000-000000000001" }, "never the request object");

  await decide({ state: { order: 7 }, question: "Which team should handle this?", options: ["Billing", { option: "Shipping", description: "Parcels" }], none: false });
  assert.deepEqual(JSON.parse(calls[1].body), {
    state: { order: 7 },
    question: "Which team should handle this?",
    options: ["Billing", { option: "Shipping", description: "Parcels" }],
    none: false,
  });
});

test("its errors carry the gateway's code, and isDecideOffline says when no model is answering", async () => {
  const answer = (status, code) => () => Response.json({ error: { type: "server_error", code, message: `It said ${code}.` } }, { status });
  for (const [status, code, offline] of [
    [503, "decide_offline", true],
    [502, "decide_unavailable", true],
    [504, "timeout", true],
    [403, "decide_not_allowed", false],
    [404, "unknown_model", false],
    [429, "rate_limited", false],
    [400, "invalid_options", false],
  ]) {
    stubFetch(answer(status, code));
    await assert.rejects(decide({ state: "x", question: "Which one fits?", options: ["A", "B"] }), (err) => {
      assert.ok(err instanceof DecideError);
      assert.deepEqual([err.code, err.status, err.message], [code, status, `It said ${code}.`]);
      assert.equal(isDecideOffline(err), offline, code);
      return true;
    });
  }
  // The gateway out of reach reads as offline too; anything that isn't a DecideError doesn't.
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(decide({ state: "x" }), (err) => err instanceof DecideError && err.code === "decide_unavailable" && isDecideOffline(err));
  stubFetch(() => new Response("<html>", { status: 500 }));
  await assert.rejects(decide({ state: "x" }), (err) => err instanceof DecideError && err.code === "decide_error" && !isDecideOffline(err));
  assert.equal(isDecideOffline(new Error("decide_offline")), false);
  delete process.env.PRODUCT_TOKEN;
  await assert.rejects(decide({ state: "x" }), /Missing PRODUCT_TOKEN/);
});

test("the template's stand-in is the gateway's: the same picks, ids and probabilities", () => {
  assert.equal(NONE_OPTION, PLATFORM_NONE);
  const options = [
    { option: "Billing", description: "Charges, refunds and invoices" },
    { option: "Shipping", description: "Delivery, tracking and damaged parcels" },
    { option: "Sign-in issues", description: "Passwords and profile" },
    "Returns",
  ];
  const labels = options.map((o) => (typeof o === "string" ? { id: labelId(o), name: o, description: "" } : { id: labelId(o.option), name: o.option, description: o.description }));
  for (const state of [
    "I was charged twice and want a refund on the invoice",
    "My parcel never came and the tracking is stuck",
    "Can't sign in: my password stopped working",
    "Hello there",
    "Ça a été facturé deux fois, REFUND please!!",
    "",
  ]) {
    for (const none of [true, false]) {
      assert.deepEqual(standInDecision({ state, options, none }), platformStandIn({ state, labels, none }), `${state} ${none}`);
    }
  }
  assert.equal(optionId("Sign-in issues"), "sign-in-issues");
  assert.equal(optionId("Café Orders"), labelId("Café Orders"));
  assert.equal(standInDecision({ state: "my refund", options }).decision, "Billing");
  assert.equal(standInDecision({ state: "Hello there", options }).decision, "Billing", "ties go to the first");
  assert.ok(standInDecision({ state: "Hello there", options }).none > 0, "none is shown but never picked");
});

test("a build token gets exactly the stand-in the template predicts", async () => {
  const token = { id: "tok-build", productId: "prod-1", scope: "build", allowedModels: ["muse-decide"], dailyBudgetUsd: 3 };
  const deps = {
    findToken: async () => token,
    productStatus: async () => "building",
    hitRateLimits: async (keys) => Object.fromEntries(keys.map((k) => [k, 1])),
    findModel: async () => null,
    backend: async () => {
      throw new Error("a build never reaches a backend");
    },
    recordUsage: async () => {},
  };
  const body = { state: "  The parcel tracking says lost  ", question: "Which team should handle this?", options: ["Billing", { option: "Shipping", description: "Parcels and tracking" }] };
  const res = await handleDecide(
    new Request("https://gateway.example/api/gateway/decide", { method: "POST", headers: { authorization: "Bearer mm_build_x" }, body: JSON.stringify(body) }),
    deps,
  );
  assert.equal(res.status, 200);
  const reply = await res.json();
  const { model, calibrated, simulated, ms, note, ...decision } = reply;
  assert.deepEqual(decision, standInDecision({ state: body.state, options: body.options }));
  assert.deepEqual([model, calibrated, simulated, ms], ["stand-in", false, true, 0]);
  assert.match(note, /not a model/);
  assert.equal(decision.decision, "Shipping");
});
