/**
 * Muse Spark Open through the gateway (SPARK_OPEN_PRODUCTS, lib/gateway/spark-open.ts): unknown with the flag off, then the
 * same checks, budget, reservation and meter as a Meta call, on the provider SPARK_OPEN_PROVIDER names. No network: the
 * provider is a fake fetch.
 *
 *   npx tsx --test lib/gateway/__tests__/spark-open.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleGateway } from "@/lib/gateway/handler";
import { RUN_HEADER } from "@/lib/gateway/policy";
import {
  meterSparkOpen,
  SPARK_OPEN_ENDPOINT,
  sparkOpenEstimate,
  sparkOpenRequest,
  SPARK_OPEN_TEMPLATE_TOKENS,
  sparkOpenUpstream,
  usageFromChat,
  type SparkOpenUpstream,
} from "@/lib/gateway/spark-open";
import { SPARK_OPEN_HOST_HEADER, SPARK_OPEN_MODEL, SPARK_OPEN_PROVIDERS, sparkOpenCost } from "@/lib/meta/spark-open";
import { fakeGateway, gatewayRequest, json } from "./helpers";

const JSON_CT = { "content-type": "application/json" };
const PATH = ["chat", "completions"];
const KEY = "made-up-provider-key";
const BASETEN: SparkOpenUpstream = { ...SPARK_OPEN_PROVIDERS.baseten, provider: "baseten", key: KEY };
const PRICE = SPARK_OPEN_PROVIDERS.baseten.price;
const ask = (extra: Record<string, unknown> = {}) => json({ model: SPARK_OPEN_MODEL, messages: [{ role: "user", content: "Sort: buy milk" }], max_tokens: 500, ...extra });

const completion = (usage: Record<string, unknown> | null = { prompt_tokens: 40, completion_tokens: 60, total_tokens: 100, prompt_tokens_details: { cached_tokens: 10 } }) =>
  Response.json({
    id: "chatcmpl-1",
    object: "chat.completion",
    model: BASETEN.model,
    choices: [{ index: 0, message: { role: "assistant", content: "Errand", reasoning_content: "It is a purchase." }, finish_reason: "stop" }],
    ...(usage ? { usage } : {}),
  });

const sse = (events: unknown[], done = true) =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : ""), { headers: { "content-type": "text/event-stream" } });
const delta = (content: string) => ({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content } }] });

async function errorOf(res: Response) {
  const body = (await res.json()) as { error: { code: string; message: string } };
  return { status: res.status, ...body.error };
}

/** A gateway with Muse Spark Open on (deps.sparkOpen set), as gatewayDeps wires it while the flag is on. */
function onGateway(opts: Parameters<typeof fakeGateway>[0] = {}, upstream: SparkOpenUpstream | null = BASETEN) {
  const g = fakeGateway({ token: { allowedModels: [SPARK_OPEN_MODEL] }, fetch: async () => completion(), ...opts });
  g.deps.sparkOpen = () => upstream;
  return g;
}

describe("with SPARK_OPEN_PRODUCTS off (no deps.sparkOpen)", () => {
  it("/v1/chat/completions is an unknown endpoint, with today's list, before any token is read", async () => {
    const g = fakeGateway({ token: { allowedModels: [SPARK_OPEN_MODEL] } });
    let looked = false;
    g.deps.findToken = async () => {
      looked = true;
      return null;
    };
    const err = await errorOf(await handleGateway(gatewayRequest("chat/completions", ask(), JSON_CT), PATH, g.deps));
    assert.equal(err.status, 404);
    assert.equal(err.code, "unknown_endpoint");
    assert.equal(err.message, "The gateway does not serve /v1/chat/completions. It serves /v1/responses, /v1/images/generations, /v1/images/edits, /v1/files, /v1/asr/transcribe.");
    assert.equal(looked, false);
    assert.equal(g.upstreamCalls.length, 0);
  });

  it("naming it on /v1/responses gets today's model_not_found, word for word", async () => {
    const g = fakeGateway({ token: { allowedModels: [SPARK_OPEN_MODEL, "muse-image-1.0"] } });
    const err = await errorOf(await handleGateway(gatewayRequest("responses", json({ model: SPARK_OPEN_MODEL, input: "hi" }), JSON_CT), ["responses"], g.deps));
    assert.equal(err.status, 404);
    assert.equal(err.message, 'The model "muse-spark-open" isn\'t available to this product on /v1/responses. Allowed: muse-image-1.0.');
  });
});

describe("with SPARK_OPEN_PRODUCTS on", () => {
  it("the unknown-endpoint list names it, and Meta's endpoints point a product to it", async () => {
    const g = onGateway();
    const unknown = await errorOf(await handleGateway(gatewayRequest("models", null), ["models"], g.deps));
    assert.match(unknown.message, /\/v1\/asr\/transcribe, \/v1\/chat\/completions\.$/);
    const wrong = await errorOf(await handleGateway(gatewayRequest("responses", json({ model: SPARK_OPEN_MODEL, input: "hi" }), JSON_CT), ["responses"], g.deps));
    assert.equal(wrong.code, "model_not_found");
    assert.match(wrong.message, /muse-spark-open answers on \/v1\/chat\/completions\.$/);
  });

  it("a token without it, or another model, gets model_not_found and nothing goes out", async () => {
    const without = onGateway({ token: { allowedModels: ["muse-image-1.0"] } });
    const err = await errorOf(await handleGateway(gatewayRequest("chat/completions", ask(), JSON_CT), PATH, without.deps));
    assert.equal(err.status, 404);
    assert.match(err.message, /No models are allowed here for this product\./);
    const other = onGateway();
    const llama = await errorOf(await handleGateway(gatewayRequest("chat/completions", ask({ model: "llama-3.2-3b" }), JSON_CT), PATH, other.deps));
    assert.equal(llama.code, "model_not_found");
    assert.match(llama.message, /Allowed: muse-spark-open\./);
    assert.equal(without.upstreamCalls.length + other.upstreamCalls.length, 0);
  });

  it("no provider or key: 503 spark_open_closed, with no slot, reservation or call", async () => {
    const g = onGateway({}, null);
    const err = await errorOf(await handleGateway(gatewayRequest("chat/completions", ask(), JSON_CT), PATH, g.deps));
    assert.equal(err.status, 503);
    assert.equal(err.code, "spark_open_closed");
    assert.equal(g.upstreamCalls.length, 0);
    assert.equal(g.reservations.size, 0);
    assert.equal(g.rateKeys.length, 0);
  });

  it("a whole reply: the provider gets its own id and key, the product gets the reply, the meter gets the usage", async () => {
    const g = onGateway();
    const res = await handleGateway(gatewayRequest("chat/completions", ask({ user: "visitor-7", safety_identifier: "s", metadata: { a: "b" }, stream_options: { include_usage: true } }), JSON_CT), PATH, g.deps);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get(SPARK_OPEN_HOST_HEADER), "Baseten");
    const reply = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    assert.equal(reply.choices[0]!.message.content, "Errand");
    await g.settled();

    assert.equal(g.upstreamCalls.length, 1);
    const sent = g.upstreamCalls[0]!;
    assert.equal(sent.url, "https://inference.baseten.co/v1/chat/completions");
    assert.equal(new Headers(sent.init?.headers).get("authorization"), `Bearer ${KEY}`);
    const body = JSON.parse(String(new TextDecoder().decode(sent.init?.body as Uint8Array))) as Record<string, unknown>;
    assert.equal(body.model, "meta-models/muse-spark-open");
    assert.equal(body.max_tokens, 500);
    for (const gone of ["user", "safety_identifier", "metadata", "stream_options", "max_completion_tokens"]) assert.ok(!(gone in body), gone);

    assert.equal(g.reservations.size, 0, "the reservation was settled");
    assert.equal(g.usage.length, 1);
    const item = g.usage[0]!.items[0]!;
    assert.equal(g.usage[0]!.ctx.endpoint, SPARK_OPEN_ENDPOINT);
    assert.deepEqual({ ...item, costUsd: undefined }, { model: SPARK_OPEN_MODEL, inputTokens: 40, cachedInputTokens: 10, outputTokens: 60, costUsd: undefined });
    assert.equal(item.costUsd, sparkOpenCost(PRICE, item));
    assert.equal(g.inFlight.get(`inflight:00000000-0000-4000-8000-000000000001`), 0, "the slot was given back");
    // The key never reaches the product.
    assert.ok(![...res.headers.values()].some((v) => v.includes(KEY)));
  });

  it("max_tokens is always set to a ceiling, and the note says so", async () => {
    const g = onGateway();
    const none = await handleGateway(gatewayRequest("chat/completions", json({ model: SPARK_OPEN_MODEL, messages: [{ role: "user", content: "hi" }] }), JSON_CT), PATH, g.deps);
    assert.match(none.headers.get("x-musemuse-note") ?? "", /Set max_tokens to 8000/);
    const huge = await handleGateway(gatewayRequest("chat/completions", ask({ max_tokens: undefined, max_completion_tokens: 900_000 }), JSON_CT), PATH, g.deps);
    assert.match(huge.headers.get("x-musemuse-note") ?? "", /Set max_tokens to 32000/);
    await g.settled();
    const bodies = g.upstreamCalls.map((c) => JSON.parse(new TextDecoder().decode(c.init?.body as Uint8Array)) as Record<string, unknown>);
    assert.deepEqual(bodies.map((b) => b.max_tokens), [8000, 32000]);
  });

  it("a stream asks for its usage and is metered on it, and passes through as an event stream", async () => {
    const g = onGateway({ fetch: async () => sse([delta("Err"), delta("and"), { id: "c", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 30, completion_tokens: 200 } }]) });
    const res = await handleGateway(gatewayRequest("chat/completions", ask({ stream: true }), JSON_CT), PATH, g.deps);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    assert.equal(res.headers.get("cache-control"), "no-cache, no-transform");
    assert.match(await res.text(), /data: \[DONE\]/);
    await g.settled();
    const body = JSON.parse(new TextDecoder().decode(g.upstreamCalls[0]!.init?.body as Uint8Array)) as Record<string, unknown>;
    assert.deepEqual(body.stream_options, { include_usage: true });
    const item = g.usage[0]!.items[0]!;
    assert.equal(item.inputTokens, 30);
    assert.equal(item.outputTokens, 200);
  });

  it("a stream cut off before its usage keeps the whole reservation", async () => {
    const g = onGateway({ fetch: async () => sse([delta("Err")], false) });
    const res = await handleGateway(gatewayRequest("chat/completions", ask({ stream: true }), JSON_CT), PATH, g.deps);
    await res.text();
    await g.settled();
    const item = g.usage[0]!.items[0]!;
    const estimate = sparkOpenEstimate({ kind: "json", model: SPARK_OPEN_MODEL, json: { messages: [{ role: "user", content: "Sort: buy milk" }], max_tokens: 500 } }, PRICE);
    assert.ok(estimate > 0);
    assert.ok(Math.abs(item.costUsd - estimate) < 1e-12, `${item.costUsd} vs ${estimate}`);
  });

  it("the provider's own refusal passes through and spends nothing", async () => {
    const g = onGateway({ fetch: async () => Response.json({ error: { message: "Account is suspended" } }, { status: 412 }) });
    const res = await handleGateway(gatewayRequest("chat/completions", ask(), JSON_CT), PATH, g.deps);
    assert.equal(res.status, 412);
    await g.settled();
    assert.equal(g.reservations.size, 0);
    assert.equal(g.usage.length, 0);
  });

  it("an unreachable provider is named in a 502, and the reservation goes", async () => {
    const g = onGateway({ fetch: async () => { throw new TypeError("connect ECONNREFUSED"); } });
    const err = await errorOf(await handleGateway(gatewayRequest("chat/completions", ask(), JSON_CT), PATH, g.deps));
    assert.equal(err.status, 502);
    assert.equal(err.message, "Couldn't reach Muse Spark Open on Baseten. Try again.");
    assert.equal(g.reservations.size, 0);
  });

  it("the product's daily budget and the platform's cap hold, before anything goes out", async () => {
    const broke = onGateway({ tokenSpend: 3 });
    assert.equal((await errorOf(await handleGateway(gatewayRequest("chat/completions", ask(), JSON_CT), PATH, broke.deps))).code, "budget_exceeded");
    const paused = onGateway({ platformSpend: 40 });
    assert.equal((await errorOf(await handleGateway(gatewayRequest("chat/completions", ask(), JSON_CT), PATH, paused.deps))).code, "platform_paused");
    assert.equal(broke.upstreamCalls.length + paused.upstreamCalls.length, 0);
  });

  it("a build token's run caps count it, and its model is never swapped for the test model", async () => {
    const g = onGateway({ token: { scope: "build", allowedModels: [SPARK_OPEN_MODEL] }, buildTestModel: "muse-spark-1.3-contributor" });
    const res = await handleGateway(gatewayRequest("chat/completions", ask(), { ...JSON_CT, [RUN_HEADER]: "run_12345678" }), PATH, g.deps);
    assert.equal(res.status, 200);
    await res.text();
    await g.settled();
    const body = JSON.parse(new TextDecoder().decode(g.upstreamCalls[0]!.init?.body as Uint8Array)) as Record<string, unknown>;
    assert.equal(body.model, "meta-models/muse-spark-open");
    const turnsKey = [...g.counters.keys()].find((k) => k.startsWith("run-turns:"));
    assert.ok(turnsKey, "the run's turn was counted");
    assert.equal(g.counters.get(turnsKey!), 1);
    const usdKey = [...g.counters.keys()].find((k) => k.startsWith("run-usd:"))!;
    assert.equal(g.counters.get(usdKey), Math.ceil(g.usage[0]!.items[0]!.costUsd * 1e6), "settled to the metered cost");
  });

  it("a Muse Code session's token can't use it: sessions call only /v1/responses", async () => {
    const g = onGateway({ token: { scope: "code_session", allowedModels: ["muse-wonder-1.0"] } });
    const err = await errorOf(await handleGateway(gatewayRequest("chat/completions", ask(), JSON_CT), PATH, g.deps));
    assert.equal(err.status, 403);
    assert.equal(err.code, "session_scope");
  });

  it("refuses what would change the bill or the model's job, and nothing goes out", async () => {
    const g = onGateway();
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ n: 2 }, /n must be 1/],
      [{ service_tier: "priority" }, /doesn't take "service_tier"/],
      [{ tools: [{ type: "web_search" }] }, /function tools only/],
      [{ messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: "x", format: "wav" } }] }] }, /text and images here/],
      [{ messages: [] }, /at least one message/],
      [{ messages: [{ role: "robot", content: "hi" }] }, /needs a role/],
    ];
    for (const [extra, message] of cases) {
      const err = await errorOf(await handleGateway(gatewayRequest("chat/completions", ask(extra), JSON_CT), PATH, g.deps));
      assert.equal(err.status, 400, JSON.stringify(extra));
      assert.match(err.message, message);
    }
    const form = new FormData();
    form.set("model", SPARK_OPEN_MODEL);
    const multipart = await errorOf(await handleGateway(gatewayRequest("chat/completions", form), PATH, g.deps));
    assert.equal(multipart.code, "invalid_body");
    assert.equal(g.upstreamCalls.length, 0);
    assert.equal(g.reservations.size, 0);
  });

  it("text, images and function tools pass", async () => {
    const g = onGateway();
    const messages = [
      { role: "system", content: "Be brief." },
      { role: "user", content: [{ type: "text", text: "What is this?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
    ];
    const tools = [{ type: "function", function: { name: "save", parameters: { type: "object", properties: {} } } }];
    const res = await handleGateway(gatewayRequest("chat/completions", ask({ messages, tools }), JSON_CT), PATH, g.deps);
    assert.equal(res.status, 200);
  });
});

describe("the provider setting", () => {
  it("baseten when unset, fireworks when named, each with its own address, id and key", () => {
    assert.deepEqual(sparkOpenUpstream({ BASETEN_API_KEY: " bk " }), { ...SPARK_OPEN_PROVIDERS.baseten, provider: "baseten", key: "bk" });
    const fw = sparkOpenUpstream({ SPARK_OPEN_PROVIDER: "Fireworks", FIREWORKS_API_KEY: "fk", BASETEN_API_KEY: "bk" });
    assert.equal(fw?.baseUrl, "https://api.fireworks.ai/inference/v1");
    assert.equal(fw?.model, "accounts/fireworks/models/muse-spark-open");
    assert.equal(fw?.key, "fk");
  });

  it("an unknown provider, or the chosen one's key missing, closes it: nothing is guessed", () => {
    assert.equal(sparkOpenUpstream({ SPARK_OPEN_PROVIDER: "together", BASETEN_API_KEY: "bk" }), null);
    assert.equal(sparkOpenUpstream({ SPARK_OPEN_PROVIDER: "toString", BASETEN_API_KEY: "bk" }), null);
    assert.equal(sparkOpenUpstream({ SPARK_OPEN_PROVIDER: "fireworks", BASETEN_API_KEY: "bk" }), null);
    assert.equal(sparkOpenUpstream({}), null);
  });

  it("every provider serves Meta's model and nothing else", () => {
    for (const p of Object.values(SPARK_OPEN_PROVIDERS)) assert.match(p.model, /\/muse-spark-open$/);
  });
});

describe("estimate and meter", () => {
  it("counts text by characters, an image part at the gateway's guess, and max_tokens of output", () => {
    const text = sparkOpenEstimate({ kind: "json", model: SPARK_OPEN_MODEL, json: { messages: [{ role: "user", content: "x".repeat(4000) }], max_tokens: 1000 } }, PRICE);
    const image = sparkOpenEstimate({ kind: "json", model: SPARK_OPEN_MODEL, json: { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x.example/a.png" } }] }], max_tokens: 1000 } }, PRICE);
    assert.ok(text > sparkOpenCost(PRICE, { inputTokens: SPARK_OPEN_TEMPLATE_TOKENS + 1000, cachedInputTokens: 0, outputTokens: 1000 }) - 1e-9);
    assert.ok(image >= sparkOpenCost(PRICE, { inputTokens: SPARK_OPEN_TEMPLATE_TOKENS + 3000, cachedInputTokens: 0, outputTokens: 1000 }) - 1e-9);
    // The smoke call's real bill (152 in, 37 out) is under what the gateway reserved for it (512 out).
    const smoke = sparkOpenEstimate({ kind: "json", model: SPARK_OPEN_MODEL, json: { messages: [{ role: "user", content: "Reply with one word: ready." }], max_tokens: 512 } }, PRICE);
    assert.ok(smoke > sparkOpenCost(PRICE, { inputTokens: 152, cachedInputTokens: 0, outputTokens: 37 }));
  });

  it("reads usage from a whole reply, cached tokens included, and says when it saw none", async () => {
    assert.equal(usageFromChat(null, PRICE), null);
    const item = usageFromChat({ prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 40 } }, PRICE)!;
    assert.equal(item.costUsd, (60 * PRICE.input + 40 * PRICE.cachedInput + 50 * PRICE.output) / 1e6);
    const seen = await meterSparkOpen("application/json", completion().body!, PRICE);
    assert.equal(seen.builtInCalls, 0);
    const unseen = await meterSparkOpen("application/json", completion(null).body!, PRICE);
    assert.equal(unseen.builtInCalls, null, "no usage: the handler keeps the reservation");
    const broken = await meterSparkOpen("application/json", new Response("{not json").body!, PRICE);
    assert.equal(broken.builtInCalls, null);
  });

  it("shapes only a JSON body", () => {
    assert.equal(sparkOpenRequest({ kind: "raw", model: null }, BASETEN).refusal?.code, "invalid_body");
  });
});
