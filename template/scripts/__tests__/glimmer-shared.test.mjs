// askGlimmer: the hosted Muse Glimmer, falling back to Muse Wonder on anything but a 400. No network: fetch is a fake.
//   npx tsx --test template/scripts/__tests__/glimmer-shared.test.mjs
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { askGlimmer, glimmer } from "../../lib/meta/glimmer";

const saved = { ...process.env };
const realFetch = globalThis.fetch;
let calls;

function fake(answers) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body, headers: new Headers(init.headers) });
    const a = answers(String(url), body);
    return new Response(JSON.stringify(a.json), { status: a.status ?? 200, headers: { "content-type": "application/json", ...a.headers } });
  };
}

const wonder = { json: { id: "r", object: "response", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "From Wonder." }] }] } };
const chat = (text) => ({ json: { id: "c", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] } });
const err = (status, code) => ({ status, json: { error: { type: "server_error", code, message: code } } });

beforeEach(() => {
  for (const k of ["GLIMMER_URL", "GLIMMER_API_KEY", "GLIMMER_MODEL", "GLIMMER_SHARED", "TEST_MODEL"]) delete process.env[k];
  process.env.GATEWAY_URL = "https://platform.example/api/gateway";
  process.env.PRODUCT_TOKEN = "tok_made_up";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...saved };
});

test("GLIMMER_SHARED leaves glimmer() null, so code calling it directly keeps falling to Muse Wonder", () => {
  assert.equal(glimmer(), null);
  process.env.GLIMMER_SHARED = "1";
  assert.equal(glimmer(), null);
  process.env.GLIMMER_URL = "https://glimmer.example/v1/";
  assert.equal(glimmer().client.baseURL, "https://glimmer.example/v1", "an endpoint someone hosts still works");
});

test("GLIMMER_SHARED sends askGlimmer through the product's gateway address and token", async () => {
  process.env.GLIMMER_SHARED = "1";
  fake(() => chat("ok"));
  await askGlimmer({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(calls[0].url, "https://platform.example/api/gateway/glimmer/v1/chat/completions");
  assert.equal(calls[0].headers.get("authorization"), "Bearer tok_made_up");
});

test("a hosted answer says who answered and carries the gateway's note", async () => {
  process.env.GLIMMER_SHARED = "1";
  fake(() => ({ ...chat("From Glimmer."), headers: { "x-musemuse-note": "Built with Muse Spark Open." } }));
  assert.deepEqual(await askGlimmer({ messages: [{ role: "user", content: "hi" }] }), { text: "From Glimmer.", by: "glimmer", note: "Built with Muse Spark Open." });
  assert.equal(calls[0].body.model, "muse-glimmer");
  fake(() => chat("Mine."));
  assert.deepEqual(await askGlimmer({ messages: [{ role: "user", content: "hi" }], own: true }), { text: "Mine.", by: "own", note: null });
  assert.equal(calls[0].body.model, "own");
});

for (const [status, code] of [[503, "glimmer_closed"], [503, "glimmer_starting"], [409, "busy"], [404, "own_model_not_ready"], [504, "timeout"], [502, "glimmer_unavailable"], [403, "glimmer_not_allowed"]]) {
  test(`${status} ${code} falls back to Muse Wonder, once, and says so`, async () => {
    process.env.GLIMMER_SHARED = "1";
    fake((url) => (url.includes("/glimmer/") ? err(status, code) : wonder));
    const got = await askGlimmer({ messages: [{ role: "user", content: "hi" }], own: true });
    assert.deepEqual(got, { text: "From Wonder.", by: "wonder", note: "Answered by Muse Wonder while this app's own model is off." });
    assert.equal(calls.filter((c) => c.url.includes("/glimmer/")).length, 1, "no retries against a GPU");
    assert.equal(calls.at(-1).body.model, "muse-wonder-1.0");
  });
}

test("a 400 is the caller's to fix: it throws, and nothing falls back", async () => {
  process.env.GLIMMER_SHARED = "1";
  fake(() => err(400, "invalid_arguments"));
  await assert.rejects(() => askGlimmer({ messages: [{ role: "user", content: "" }] }), (e) => e.status === 400);
  assert.equal(calls.length, 1);
});

test("no Glimmer at all answers with Muse Wonder", async () => {
  fake(() => wonder);
  const got = await askGlimmer({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(got.by, "wonder");
  assert.equal(got.note, "Answered by Muse Wonder while Muse Glimmer is off.");
});

test("the fallback note names the model that really serves Muse Wonder's calls", async () => {
  process.env.NEXT_PUBLIC_MUSE_WONDER_SERVED_BY = "muse-spark-1.3-contributor";
  fake(() => wonder);
  const got = await askGlimmer({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(got.note, "Answered by Muse Spark 1.3 Contributor while Muse Glimmer is off.");
  assert.equal(calls.at(-1).body.model, "muse-wonder-1.0", "the call still names Muse Wonder, which the gateway serves");
});

test("an empty answer (a reply cut off mid-thought) falls back too", async () => {
  process.env.GLIMMER_SHARED = "1";
  fake((url) => (url.includes("/glimmer/") ? chat("") : wonder));
  assert.equal((await askGlimmer({ messages: [{ role: "user", content: "hi" }] })).by, "wonder");
});

test("a build's closed-window test header reaches the gateway, with the visitor's IP", async () => {
  process.env.GLIMMER_SHARED = "1";
  fake(() => chat("ok"));
  const request = { headers: new Headers({ "x-musemuse-glimmer-test": "closed", "x-forwarded-for": "203.0.113.9" }) };
  await askGlimmer({ messages: [{ role: "user", content: "hi" }], request });
  assert.equal(calls[0].headers.get("x-musemuse-glimmer-test"), "closed");
  assert.equal(calls[0].headers.get("x-musemuse-client-ip"), "203.0.113.9");
});
