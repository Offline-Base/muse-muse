// askFleetOrMessage: the Jetson fleet through the gateway, with fixed words on any failure and never another model. No
// network: fetch is a fake.
//   npx tsx --test template/scripts/__tests__/fleet.test.mjs
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { readFileSync } from "node:fs";
import { FLEET_LABEL, FLEET_OFFLINE, askFleetOrMessage } from "../../lib/meta/fleet";

const saved = { ...process.env };
const realFetch = globalThis.fetch;
const realError = console.error;
const ASK = { messages: [{ role: "user", content: "hi" }] };
let calls;
let logged;

function fake(answer) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: new Headers(init.headers) });
    const a = answer();
    return new Response(JSON.stringify(a.json), { status: a.status ?? 200, headers: { "content-type": "application/json" } });
  };
}

const chat = (text) => ({ json: { id: "c", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] } });
const err = (status, code) => ({ status, json: { error: { type: "server_error", code, message: "at fleet.example, no node can serve it" } } });

beforeEach(() => {
  delete process.env.TEST_MODEL;
  process.env.GATEWAY_URL = "https://platform.example/api/gateway/";
  process.env.PRODUCT_TOKEN = "tok_made_up";
  logged = [];
  console.error = (...args) => void logged.push(args.map(String).join(" "));
});
afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realError;
  process.env = { ...saved };
});

test("it sends only each message's role and text, so a chat UI's own fields don't get it refused", async () => {
  fake(() => chat("x"));
  await askFleetOrMessage({ messages: [{ id: "m1", role: "user", content: "hi", createdAt: 1 }] });
  assert.deepEqual(calls[0].body.messages, [{ role: "user", content: "hi" }]);
});

test("a failure logs only the status and the gateway's code, never the messages or the error's words", async () => {
  fake(() => err(400, "text_only"));
  await askFleetOrMessage({ messages: [{ role: "user", content: "my secret question" }] });
  assert.deepEqual(logged, ["[fleet] 400 text_only"]);
  globalThis.fetch = async () => {
    throw new TypeError("connect failed at fleet.example");
  };
  await askFleetOrMessage(ASK);
  assert.equal(logged[1], "[fleet] no answer");
  assert.ok(!logged.join("\n").includes("fleet.example"));
});

test("an answer comes with the label, through this product's gateway, naming only the endpoint's one choice", async () => {
  fake(() => chat("From the boards."));
  const got = await askFleetOrMessage(ASK);
  assert.deepEqual(got, { text: "From the boards.", answered: true, label: FLEET_LABEL });
  assert.equal(calls[0].url, "https://platform.example/api/gateway/fleet/v1/chat/completions");
  assert.equal(calls[0].body.model, "jetson-fleet");
  assert.equal(calls[0].headers.get("authorization"), "Bearer tok_made_up");
  assert.ok(!calls[0].body.stream);
});

test("it passes the visitor's address on for the gateway's limit", async () => {
  fake(() => chat("x"));
  await askFleetOrMessage({ ...ASK, request: new Headers({ "x-forwarded-for": "203.0.113.5" }) });
  assert.equal(calls[0].headers.get("x-musemuse-client-ip"), "203.0.113.5");
});

for (const [what, answer] of [
  ["a 503 fleet_closed", () => err(503, "fleet_closed")],
  ["a 404 with the flag off", () => err(404, "unknown_endpoint")],
  ["a 502", () => err(502, "fleet_unavailable")],
  ["a 409 busy", () => err(409, "busy")],
  ["a 429", () => err(429, "rate_limited")],
  ["a 400", () => err(400, "text_only")],
  ["an empty answer", () => chat("  ")],
]) {
  test(`${what} gives the fixed words, once, and no other model is asked`, async () => {
    fake(answer);
    const got = await askFleetOrMessage(ASK);
    assert.deepEqual(got, { text: FLEET_OFFLINE, answered: false, label: null });
    assert.equal(calls.length, 1, "no retries, and no second model");
    assert.ok(calls[0].url.includes("/fleet/v1/"));
  });
}

test("a network failure, or no gateway at all, gives the fixed words and never throws", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("connect failed");
  };
  assert.deepEqual(await askFleetOrMessage(ASK), { text: FLEET_OFFLINE, answered: false, label: null });
  delete process.env.GATEWAY_URL;
  assert.equal((await askFleetOrMessage(ASK)).text, FLEET_OFFLINE);
});

test("the fixed words say the fleet is offline, and carry nothing from the fleet", async () => {
  assert.match(FLEET_OFFLINE, /offline/);
  fake(() => err(502, "fleet_unavailable"));
  assert.ok(!(await askFleetOrMessage(ASK)).text.includes("fleet.example"));
});

test("the helper has no way to another model", () => {
  const source = readFileSync(new URL("../../lib/meta/fleet.ts", import.meta.url), "utf8");
  assert.ok(!/metaClient|respondJson|muse-wonder|responses\.create|GLIMMER/.test(source));
});
