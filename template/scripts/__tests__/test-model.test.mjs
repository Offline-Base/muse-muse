// Unit tests for the test build's model swap in metaClient. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/*.test.mjs
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { z } from "zod";
import { CLIENT_IP_HEADER, metaClient, TEST_MODEL, testModelFor } from "../../lib/meta/client";
import { respondJson } from "../../lib/meta/json";

const realFetch = globalThis.fetch;
const saved = { GATEWAY_URL: process.env.GATEWAY_URL, PRODUCT_TOKEN: process.env.PRODUCT_TOKEN, TEST_MODEL: process.env.TEST_MODEL };
let calls = [];

const WONDER = "muse-wonder-1.0";
const CONTRIBUTOR = "muse-spark-1.3-contributor";

/** Replaces fetch with one that records each call (url, headers, raw body, the body's type) and answers with `reply`. */
function stubFetch(reply = () => Response.json({ id: "x", object: "response", output: [], output_text: "" })) {
  globalThis.fetch = async (input, init) => {
    // Before a multipart call the SDK fetches "data:," to check FormData support. That isn't a model call.
    if (String(input).startsWith("data:")) return realFetch(input, init);
    const req = new Request(input, init);
    calls.push({ url: req.url, headers: req.headers, body: await req.text(), sent: init?.body });
    return reply();
  };
}

const sse = () => new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
const visitor = new Request("https://product.example/api/chat", { headers: { "x-forwarded-for": "203.0.113.7" } });
const chatRequest = { model: WONDER, instructions: "Say hi in muse-wonder-1.0 style.", input: "Hi", reasoning: { effort: "low" } };

beforeEach(() => {
  calls = [];
  process.env.GATEWAY_URL = "https://api.meta.ai";
  process.env.PRODUCT_TOKEN = "mm_test_token";
  delete process.env.TEST_MODEL;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("TEST_MODEL is the one model the swap may name", () => {
  assert.equal(TEST_MODEL, CONTRIBUTOR);
});

test("with TEST_MODEL set, a Muse Wonder call goes out on Spark 1.3 Contributor, on any endpoint, streaming or not", async () => {
  process.env.TEST_MODEL = CONTRIBUTOR;
  stubFetch();
  const meta = metaClient(visitor);
  await meta.responses.create(chatRequest);

  stubFetch(sse);
  await meta.responses.create({ ...chatRequest, stream: true });
  await meta.chat.completions.create({ model: WONDER, messages: [{ role: "user", content: "Hi" }], stream: true });
  await meta.post("/some/new/endpoint", { body: { model: WONDER, prompt: "Hi" } });

  assert.equal(calls.length, 4);
  assert.deepEqual(
    calls.map((c) => JSON.parse(c.body).model),
    [CONTRIBUTOR, CONTRIBUTOR, CONTRIBUTOR, CONTRIBUTOR],
  );
  // Only the model changes: every other field, the key order, the path and the headers are the SDK's own.
  assert.equal(calls[0].body, JSON.stringify({ ...chatRequest, model: CONTRIBUTOR }));
  assert.equal(calls[1].body, JSON.stringify({ ...chatRequest, stream: true, model: CONTRIBUTOR }));
  assert.equal(calls[0].url, "https://api.meta.ai/v1/responses");
  assert.equal(calls[2].url, "https://api.meta.ai/v1/chat/completions");
  assert.equal(calls[3].url, "https://api.meta.ai/v1/some/new/endpoint");
  for (const c of calls) {
    assert.equal(c.headers.get("authorization"), "Bearer mm_test_token");
    assert.equal(c.headers.get(CLIENT_IP_HEADER), "203.0.113.7");
    assert.equal(c.headers.get("content-type"), "application/json");
  }
});

test("a .env.local value with surrounding whitespace still counts, the same as respondJson", async () => {
  process.env.TEST_MODEL = ` ${CONTRIBUTOR}\n`;
  stubFetch();
  await metaClient().responses.create(chatRequest);
  assert.equal(JSON.parse(calls[0].body).model, CONTRIBUTOR);
  assert.equal(testModelFor(WONDER), CONTRIBUTOR);
});

test("without TEST_MODEL, or with any other value, nothing changes", async () => {
  const bodies = [];
  for (const value of [undefined, "", "muse-spark-1.3", "muse-image-1.0", WONDER, `${CONTRIBUTOR}-x`, "MUSE-SPARK-1.3-CONTRIBUTOR"]) {
    if (value === undefined) delete process.env.TEST_MODEL;
    else process.env.TEST_MODEL = value;
    calls = [];
    stubFetch();
    const meta = metaClient();
    // No fetch of ours: the SDK uses the global fetch it always did.
    assert.equal(meta.fetch, globalThis.fetch, `TEST_MODEL=${JSON.stringify(value)}`);
    await meta.responses.create(chatRequest);
    stubFetch(sse);
    await meta.chat.completions.create({ model: WONDER, messages: [{ role: "user", content: "Hi" }], stream: true });
    assert.equal(testModelFor(WONDER), WONDER);
    bodies.push(calls.map((c) => c.body));
  }
  assert.equal(bodies[0][0], JSON.stringify(chatRequest));
  for (const b of bodies) assert.deepEqual(b, bodies[0]);
  assert.equal(JSON.parse(bodies[0][1]).model, WONDER);
});

test("with TEST_MODEL set, calls on other models are left alone", async () => {
  process.env.TEST_MODEL = CONTRIBUTOR;
  stubFetch(() => Response.json({ created: 1, data: [] }));
  const meta = metaClient();
  const others = ["muse-image-1.0", "muse-spark-1.3", "muse-wonder-1.0-preview", "Muse-Wonder-1.0", "muse-glimmer"];
  for (const model of others) await meta.post("/images/generations", { body: { model, prompt: "A muse-wonder-1.0 cat" } });
  // No model at all, and Muse Wonder named somewhere other than `model`.
  await meta.post("/images/generations", { body: { prompt: "A cat", notes: { model: WONDER }, alt: [WONDER] } });
  assert.deepEqual(
    calls.map((c) => JSON.parse(c.body).model),
    [...others, undefined],
  );
  assert.equal(calls[0].body, JSON.stringify({ model: "muse-image-1.0", prompt: "A muse-wonder-1.0 cat" }));
  assert.equal(calls.at(-1).body, JSON.stringify({ prompt: "A cat", notes: { model: WONDER }, alt: [WONDER] }));
  for (const model of others) assert.equal(testModelFor(model), model);
});

test("with TEST_MODEL set, bodies that aren't one JSON object are sent untouched", async () => {
  process.env.TEST_MODEL = CONTRIBUTOR;
  stubFetch(() => Response.json({ text: "hi" }));
  const meta = metaClient();

  // Multipart: the SDK sends FormData, and a model field in it stays as it is.
  const file = new File([new Uint8Array(16)], "a.wav", { type: "audio/wav" });
  await meta.audio.transcriptions.create({ file, model: WONDER });
  assert.equal(Object.prototype.toString.call(calls[0].sent), "[object FormData]");
  assert.match(calls[0].body, /name="model"\r\n\r\nmuse-wonder-1\.0\r\n/);

  // Plain text, a form, JSON that isn't valid, a JSON array and raw bytes.
  const raw = [
    ["text/plain", `model: ${WONDER}`],
    ["application/x-www-form-urlencoded", `model=${WONDER}`],
    ["application/json", `{"model":"${WONDER}",`],
    ["application/json", JSON.stringify([{ model: WONDER }])],
    ["application/json", JSON.stringify(WONDER)],
  ];
  for (const [type, body] of raw) await meta.post("/raw", { body, headers: { "content-type": type } });
  const bytes = new TextEncoder().encode(JSON.stringify({ model: WONDER }));
  await meta.post("/raw", { body: bytes, headers: { "content-type": "application/json" } });

  assert.deepEqual(
    calls.slice(1).map((c) => c.body),
    [...raw.map(([, body]) => body), JSON.stringify({ model: WONDER })],
  );
  for (const [i, [, body]] of raw.entries()) assert.equal(calls[i + 1].sent, body);
  assert.equal(calls.at(-1).sent, bytes);
});

test("respondJson through metaClient lands on Contributor once, with or without its own swap", async () => {
  process.env.TEST_MODEL = CONTRIBUTOR;
  const text = JSON.stringify({ line: "Hi." });
  stubFetch(() =>
    Response.json({
      id: "resp_1",
      object: "response",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }],
      output_text: text,
    }),
  );
  const out = await respondJson({ schema: z.object({ line: z.string() }), schemaName: "nudge", input: "Hi" });
  assert.deepEqual(out, { line: "Hi." });
  assert.equal(JSON.parse(calls[0].body).model, CONTRIBUTOR);

  delete process.env.TEST_MODEL;
  await respondJson({ schema: z.object({ line: z.string() }), schemaName: "nudge", input: "Hi" });
  assert.equal(JSON.parse(calls[1].body).model, WONDER);
});
