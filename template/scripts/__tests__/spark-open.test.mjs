// askSparkOpen and sparkOpenStream: Muse Spark Open through the product's gateway address and token, with the label the
// gateway's header names and no key of the product's own. No network: fetch is a fake.
//   npx tsx --test template/scripts/__tests__/spark-open.test.mjs
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { SPARK_OPEN_CREDIT, SPARK_OPEN_MODEL, askSparkOpen, sparkOpenLabel, sparkOpenStream } from "../../lib/meta/spark-open";

const saved = { ...process.env };
const realFetch = globalThis.fetch;
const ASK = { messages: [{ role: "user", content: "Sort: buy milk" }] };
let calls;

function fake(reply) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: new Headers(init.headers) });
    return reply();
  };
}

const chat = (content, { host = "Baseten", finish = "stop" } = {}) => () =>
  new Response(JSON.stringify({ id: "c", object: "chat.completion", model: "x", choices: [{ index: 0, message: { role: "assistant", content, reasoning_content: "thinking" }, finish_reason: finish }] }), {
    headers: { "content-type": "application/json", ...(host ? { "x-musemuse-served-on": host } : {}) },
  });

beforeEach(() => {
  delete process.env.TEST_MODEL;
  process.env.GATEWAY_URL = "https://platform.example/api/gateway/";
  process.env.PRODUCT_TOKEN = "tok_made_up";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...saved };
});

test("one answer goes through this product's gateway and token, with its reasoning kept low and room for it", async () => {
  fake(chat("Errand"));
  const got = await askSparkOpen(null, { instructions: "Sort tasks.", ...ASK });
  assert.deepEqual(got, { text: "Errand", label: "Muse Spark Open, on Baseten" });
  assert.equal(calls[0].url, "https://platform.example/api/gateway/v1/chat/completions");
  assert.equal(calls[0].headers.get("authorization"), "Bearer tok_made_up");
  assert.equal(calls[0].body.model, SPARK_OPEN_MODEL);
  assert.deepEqual(calls[0].body.messages, [{ role: "system", content: "Sort tasks." }, { role: "user", content: "Sort: buy milk" }]);
  assert.equal(calls[0].body.max_tokens, 2000);
  assert.equal(calls[0].body.reasoning_effort, "low");
  assert.ok(!calls[0].body.stream);
  assert.ok(!("response_format" in calls[0].body));
});

test("the label names only a provider it knows, and says just the model when the gateway didn't say", async () => {
  fake(chat("x", { host: "Fireworks" }));
  assert.equal((await askSparkOpen(null, ASK)).label, "Muse Spark Open, on Fireworks");
  fake(chat("x", { host: null }));
  assert.equal((await askSparkOpen(null, ASK)).label, "Muse Spark Open");
  assert.equal(sparkOpenLabel("<script>"), "Muse Spark Open");
});

test("its text has no em dashes, and json asks for a JSON object", async () => {
  fake(chat("Errand \u2014 a quick one"));
  const got = await askSparkOpen(null, { ...ASK, json: true, maxTokens: 900, reasoning: "medium" });
  assert.ok(!got.text.includes("\u2014"));
  assert.deepEqual(calls[0].body.response_format, { type: "json_object" });
  assert.equal(calls[0].body.max_tokens, 900);
  assert.equal(calls[0].body.reasoning_effort, "medium");
});

test("no answer (the reasoning used every token) throws a plain reason, so the route shows its error", async () => {
  fake(chat(null, { finish: "length" }));
  await assert.rejects(askSparkOpen(null, ASK), /reasoned through all of maxTokens/);
  fake(chat("  "));
  await assert.rejects(askSparkOpen(null, ASK), /gave no answer/);
});

test("a failed call isn't retried, since a call that timed out may still have been billed", async () => {
  let n = 0;
  globalThis.fetch = async () => {
    n++;
    return new Response(JSON.stringify({ error: { message: "busy" } }), { status: 503, headers: { "content-type": "application/json" } });
  };
  await assert.rejects(askSparkOpen(null, ASK));
  assert.equal(n, 1);
});

test("it passes the visitor's address on for the gateway's limit", async () => {
  fake(chat("x"));
  await askSparkOpen(new Headers({ "x-forwarded-for": "203.0.113.5" }), ASK);
  assert.equal(calls[0].headers.get("x-musemuse-client-ip"), "203.0.113.5");
});

test("a test build's swap leaves it alone: only Muse Wonder is swapped", async () => {
  process.env.TEST_MODEL = "muse-spark-1.3-contributor";
  fake(chat("x"));
  await askSparkOpen(null, ASK);
  assert.equal(calls[0].body.model, SPARK_OPEN_MODEL);
});

test("the stream gives only the answer's words, without em dashes, and the label", async () => {
  const chunk = (delta) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta }] })}\n\n`;
  fake(() =>
    new Response(chunk({ reasoning_content: "thinking" }) + chunk({ content: "Err" }) + chunk({ content: "and \u2014 now" }) + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream", "x-musemuse-served-on": "Baseten" },
    }),
  );
  const { stream, label } = await sparkOpenStream(null, ASK);
  assert.equal(label, "Muse Spark Open, on Baseten");
  assert.equal(await new Response(stream).text(), "Errand ,  now");
  assert.equal(calls[0].body.stream, true);
});

test("the credit is the license's line and the age point, word for word", () => {
  assert.equal(SPARK_OPEN_CREDIT, "Built with Muse Spark Open. For people 18 and over only.");
});
