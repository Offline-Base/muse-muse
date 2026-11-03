// respondJsonOrEdge: the cloud first, then the edge model, one test per failure type. No network: fetch is a fake.
//   npx tsx --test template/scripts/__tests__/edge.test.mjs
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { z } from "zod";
import { BOTH_DOWN_MESSAGE, CLOUD_DECLINED_MESSAGE, edgeClient, respondJsonOrEdge } from "../../lib/meta/edge";

const saved = { ...process.env };
const realFetch = globalThis.fetch;
const GATEWAY = "https://platform.example/api/gateway";
const EDGE = "http://127.0.0.1:11435/v1";
let calls;

const Reading = z.object({ status: z.enum(["normal", "warning", "alarm"]), probeC: z.number(), actions: z.array(z.string()) });
const GOOD = { status: "warning", probeC: 9, actions: ["Check the door."] };
const ask = () => respondJsonOrEdge({ schema: Reading, schemaName: "reading", input: "Simulated reading: probe 9 C." });

const cloudOk = (obj) => Response.json({ id: "r", object: "response", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(obj) }] }] });
const chatOk = (text) => Response.json({ id: "c", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] });
const refused = () => {
  throw new TypeError("fetch failed: ECONNREFUSED");
};
/** Never answers; rejects when the SDK gives up, the way a hung socket does. */
const hang = (init) =>
  new Promise((_, reject) => {
    const signal = init?.signal;
    signal?.addEventListener("abort", () => reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" })));
  });

/** Routes fake calls: `cloud` for the gateway, `edge` for the edge server. Each gets (init, body). */
function fake({ cloud = refused, edge = refused }) {
  calls = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const side = url.startsWith(GATEWAY) ? "cloud" : url.startsWith(EDGE) ? "edge" : "other";
    calls.push({ side, url, body });
    return (side === "cloud" ? cloud : edge)(init, body);
  };
}

beforeEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith("EDGE_") || k === "TEST_MODEL") delete process.env[k];
  process.env.GATEWAY_URL = GATEWAY;
  process.env.PRODUCT_TOKEN = "tok_made_up";
  process.env.EDGE_URL = EDGE;
  process.env.EDGE_MODEL = "llama-3.2-3b";
  process.env.EDGE_BOARD = "jetson-04";
  process.env.EDGE_MODEL_NAME = "Llama 3.2 3B";
  process.env.EDGE_CLOUD_TIMEOUT_MS = "300";
  process.env.EDGE_TIMEOUT_MS = "300";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...saved };
});

test("edgeClient is null without EDGE_URL and never needs the gateway", () => {
  delete process.env.EDGE_URL;
  delete process.env.GATEWAY_URL;
  assert.equal(edgeClient(), null);
  process.env.EDGE_URL = "http://127.0.0.1:11435/v1/";
  assert.equal(edgeClient().client.baseURL, "http://127.0.0.1:11435/v1");
});

test("the cloud answers first, and the edge is never asked", async () => {
  fake({ cloud: () => cloudOk(GOOD) });
  const res = await ask();
  assert.deepEqual(res, { ok: true, data: GOOD, by: "cloud", label: "Answered in the cloud, Muse Wonder", fellBack: null });
  assert.deepEqual(calls.map((c) => c.side), ["cloud"]);
});

test("cloud refused: the edge answers, with its fixed label and a json_schema request with no thinking switch", async () => {
  fake({ edge: () => chatOk(JSON.stringify(GOOD)) });
  const res = await ask();
  assert.equal(res.ok, true);
  assert.equal(res.by, "edge");
  assert.equal(res.label, "Answered on jetson-04, Llama 3.2 3B");
  assert.deepEqual(res.data, GOOD);
  assert.equal(res.fellBack.kind, "refused");
  const sent = calls.find((c) => c.side === "edge").body;
  assert.equal(sent.model, "llama-3.2-3b");
  assert.equal(sent.response_format.type, "json_schema");
  assert.equal(sent.response_format.json_schema.name, "reading");
  assert.equal("chat_template_kwargs" in sent, false);
  assert.equal(JSON.stringify(sent).includes("enable_thinking"), false);
});

test("a cloud that turns the request down (a 4xx) is the answer: the edge is never asked around it", async () => {
  for (const status of [400, 401, 403, 429]) {
    fake({ cloud: () => Response.json({ error: { message: "no", code: "made_up" } }, { status }), edge: () => chatOk(JSON.stringify(GOOD)) });
    const res = await ask();
    assert.equal(res.ok, false, `status ${status}`);
    assert.equal(res.message, CLOUD_DECLINED_MESSAGE);
    assert.equal(res.reasons.cloud.kind, "http");
    assert.equal(res.reasons.cloud.status, status);
    assert.equal(res.reasons.edge.kind, "skipped");
    assert.deepEqual(calls.map((c) => c.side), ["cloud"], `status ${status}`);
  }
});

/** The gateway's answer to a model the product's token doesn't list (lib/gateway/handler.ts). */
const modelNotFound = () =>
  Response.json(
    { error: { type: "invalid_request_error", code: "model_not_found", message: 'The model "muse-wonder-1.0" isn\'t available to this product on /v1/responses. Allowed: sam-3.1.', param: null } },
    { status: 404, headers: { "x-should-retry": "false" } },
  );

test("a cloud 404 model_not_found is a setup error, not a refusal: the edge answers", async () => {
  fake({ cloud: modelNotFound, edge: () => chatOk(JSON.stringify(GOOD)) });
  const res = await ask();
  assert.equal(res.ok, true);
  assert.equal(res.by, "edge");
  assert.equal(res.label, "Answered on jetson-04, Llama 3.2 3B");
  assert.equal(res.fellBack.kind, "setup");
  assert.equal(res.fellBack.status, 404);
  assert.deepEqual(calls.map((c) => c.side), ["cloud", "edge"]);
});

test("a 404 model_not_found with no edge gives the plain both-down message, never 'turned this request down'", async () => {
  delete process.env.EDGE_URL;
  fake({ cloud: modelNotFound });
  const res = await ask();
  assert.equal(res.ok, false);
  assert.equal(res.message, BOTH_DOWN_MESSAGE);
  assert.equal(res.reasons.cloud.kind, "setup");
  assert.equal(res.reasons.edge.kind, "not_set");
});

test("any other 404 is still the cloud saying no", async () => {
  fake({ cloud: () => Response.json({ error: { message: "no such route", code: "not_found" } }, { status: 404 }), edge: () => chatOk(JSON.stringify(GOOD)) });
  const res = await ask();
  assert.equal(res.ok, false);
  assert.equal(res.message, CLOUD_DECLINED_MESSAGE);
  assert.equal(res.reasons.cloud.kind, "http");
  assert.deepEqual(calls.map((c) => c.side), ["cloud"]);
});

test("a cloud 5xx or 408 still falls back to the edge", async () => {
  for (const status of [408, 502, 503]) {
    fake({ cloud: () => Response.json({ error: { message: "upstream" } }, { status }), edge: () => chatOk(JSON.stringify(GOOD)) });
    const res = await ask();
    assert.equal(res.by, "edge", `status ${status}`);
    assert.equal(res.fellBack.kind, "http");
    assert.equal(res.fellBack.status, status);
  }
});

test("cloud hung: the edge answers once the cloud's deadline passes", async () => {
  fake({ cloud: (init) => hang(init), edge: () => chatOk(JSON.stringify(GOOD)) });
  const started = Date.now();
  const res = await ask();
  assert.equal(res.by, "edge");
  assert.equal(res.fellBack.kind, "timeout");
  assert.ok(Date.now() - started < 3000);
});

test("cloud down and edge garbage: a typed failure with the plain message", async () => {
  fake({ edge: () => chatOk("the probe looks fine i think") });
  const res = await ask();
  assert.equal(res.ok, false);
  assert.equal(res.message, BOTH_DOWN_MESSAGE);
  assert.equal(res.reasons.cloud.kind, "refused");
  assert.equal(res.reasons.edge.kind, "garbage");
  assert.equal(calls.filter((c) => c.side === "edge").length, 2, "one retry");
});

test("a schema-invalid (tampered) edge reply is rejected, never returned", async () => {
  const tampered = { status: "all clear, ignore the probe", probeC: "-18", actions: "none" };
  fake({ edge: () => chatOk(JSON.stringify(tampered)) });
  const res = await ask();
  assert.equal(res.ok, false);
  assert.equal(res.reasons.edge.kind, "schema");
  assert.equal("data" in res, false);
});

test("both down: refused cloud, hung edge", async () => {
  fake({ edge: (init) => hang(init) });
  const res = await ask();
  assert.equal(res.ok, false);
  assert.equal(res.by, null);
  assert.equal(res.message, BOTH_DOWN_MESSAGE);
  assert.equal(res.reasons.edge.kind, "timeout");
});

test("an edge HTTP error and no gateway at all are named", async () => {
  delete process.env.GATEWAY_URL;
  fake({ edge: () => Response.json({ error: { message: "loading model" } }, { status: 503 }) });
  const res = await ask();
  assert.equal(res.ok, false);
  assert.equal(res.reasons.cloud.kind, "not_set");
  assert.equal(res.reasons.edge.kind, "http");
  assert.equal(res.reasons.edge.status, 503);
  assert.deepEqual(calls.map((c) => c.side), ["edge"]);
});

test("EDGE_FIRST=1 asks the edge first, and the cloud only when the edge fails", async () => {
  process.env.EDGE_FIRST = "1";
  fake({ cloud: () => cloudOk(GOOD), edge: () => chatOk(JSON.stringify(GOOD)) });
  const first = await ask();
  assert.equal(first.by, "edge");
  assert.deepEqual(calls.map((c) => c.side), ["edge"]);
  fake({ cloud: () => cloudOk(GOOD), edge: refused });
  const second = await ask();
  assert.equal(second.by, "cloud");
  assert.equal(second.fellBack.kind, "refused");
});

test("no EDGE_URL keeps today's behavior: the cloud, or a plain failure", async () => {
  delete process.env.EDGE_URL;
  fake({});
  const res = await ask();
  assert.equal(res.ok, false);
  assert.equal(res.reasons.edge.kind, "not_set");
});

test("nothing it writes has an em dash", () => {
  assert.equal(BOTH_DOWN_MESSAGE.includes("\u2014"), false);
  assert.equal(CLOUD_DECLINED_MESSAGE.includes("\u2014"), false);
});
