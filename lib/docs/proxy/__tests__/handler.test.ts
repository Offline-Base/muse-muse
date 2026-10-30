import { test } from "node:test";
import assert from "node:assert/strict";
import { handleDocsLimits, handleDocsProxy } from "@/lib/docs/proxy/handler";
import { DOCS_KEYS, dayWindow, minuteStart } from "@/lib/docs/proxy/limits";
import { visitorHash } from "@/lib/docs/proxy/visitor";
import { usageCost } from "@/lib/meta/pricing";
import {
  docsRequest,
  errorOf,
  fakeDocs,
  IP,
  JSON_CT,
  json,
  NEW_VISITOR,
  NOW,
  OTHER_VISITOR,
  sse,
  TEST_KEY,
  VISITOR,
  wavBytes,
} from "./helpers";

const path = (p: string) => p.split("/");
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const run = (g: ReturnType<typeof fakeDocs>, p: string, init: Parameters<typeof docsRequest>[1] = {}) =>
  handleDocsProxy(docsRequest(p, init), path(p), g.deps);
const post = (g: ReturnType<typeof fakeDocs>, p: string, body: unknown, headers: Record<string, string> = {}) =>
  run(g, p, { body: json(body), headers: { ...JSON_CT, ...headers } });

const usage = { input_tokens: 20, input_tokens_details: { cached_tokens: 0 }, output_tokens: 300, output_tokens_details: { reasoning_tokens: 250 } };
const responseReply = (extra: Record<string, unknown> = {}) =>
  Response.json({ id: "resp_new1", object: "response", status: "completed", output: [], usage, ...extra }, { headers: { "x-request-id": "req_1" } });

/** Every header and the body, for checking the key never comes back. */
async function everything(res: Response): Promise<string> {
  return `${[...res.headers.entries()].join("\n")}\n${await res.clone().text()}`;
}

function upstreamBody(g: ReturnType<typeof fakeDocs>, i = -1): Record<string, unknown> {
  return JSON.parse(String(g.upstreamCalls.at(i)!.init!.body)) as Record<string, unknown>;
}

function upstreamHeaders(g: ReturnType<typeof fakeDocs>, i = -1): Record<string, string> {
  return g.upstreamCalls.at(i)!.init!.headers as Record<string, string>;
}

test("unknown methods and paths are 404 unknown_endpoint, before anything else", async () => {
  const g = fakeDocs();
  for (const [method, p] of [
    ["PUT", "responses"],
    ["GET", "responses"],
    ["POST", "embeddings"],
    ["DELETE", "models/muse-wonder-1.0"],
  ]) {
    const res = await handleDocsProxy(docsRequest(p, { method }), path(p), g.deps);
    const err = await errorOf(res);
    assert.equal(err.status, 404, `${method} ${p}`);
    assert.equal(err.type, "not_found_error");
    assert.equal(err.code, "unknown_endpoint");
    assert.match(err.message, /They run: GET \/v1\/status/);
  }
  assert.equal(g.upstreamCalls.length, 0);
});

test("POST and DELETE must come from the docs' own origin; GET may not need to", async () => {
  const g = fakeDocs({ fetch: () => Response.json({ object: "list", data: [] }) });
  const evil = await post(g, "responses", { model: "muse-wonder-1.0", input: "hi" }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" });
  assert.equal((await errorOf(evil)).code, "cross_site");
  assert.equal(evil.status, 403);
  const fetchSite = await post(g, "responses", { model: "muse-wonder-1.0", input: "hi" }, { "sec-fetch-site": "cross-site" });
  assert.equal(fetchSite.status, 403);
  const sameSite = await post(g, "responses", { model: "muse-wonder-1.0", input: "hi" }, { "sec-fetch-site": "same-site", origin: "https://other.mm.example" });
  assert.equal(sameSite.status, 403, "another subdomain is another site here");
  const del = await run(g, "files/file-1", { method: "DELETE", headers: { origin: "https://evil.example" } });
  assert.equal(del.status, 403);
  assert.equal(g.upstreamCalls.length, 0);
  const read = await run(g, "models", { headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } });
  assert.equal(read.status, 200);
});

test("DOCS_LIVE=off pauses every live call with 503 docs_paused", async () => {
  const g = fakeDocs({ config: { live: false } });
  for (const res of [await post(g, "responses", { model: "muse-wonder-1.0", input: "hi" }), await run(g, "models"), await run(g, "status")]) {
    const err = await errorOf(res);
    assert.equal(err.status, 503);
    assert.equal(err.code, "docs_paused");
  }
  assert.equal(g.upstreamCalls.length, 0);
});

test("bodies over 4.5 MB are 413, by declared length or by size", async () => {
  const g = fakeDocs();
  const declared = await run(g, "responses", { body: "{}", headers: { ...JSON_CT, "content-length": String(5 * 1024 * 1024) } });
  assert.equal((await errorOf(declared)).code, "body_too_large");
  const big = await run(g, "responses", { body: json({ model: "muse-wonder-1.0", input: "x".repeat(4.6 * 1024 * 1024) }), headers: JSON_CT });
  const err = await errorOf(big);
  assert.equal(err.status, 413);
  assert.match(err.message, /up to 4\.5 MB/);
  assert.equal(g.upstreamCalls.length, 0);
});

test("bodies that don't parse, and the wrong kind of body, are 400 invalid_body", async () => {
  const g = fakeDocs();
  assert.equal((await errorOf(await run(g, "responses", { body: "{oops", headers: JSON_CT }))).code, "invalid_body");
  assert.equal((await errorOf(await run(g, "responses", { body: "[1,2]", headers: JSON_CT }))).code, "invalid_body");
  const form = new FormData();
  form.set("model", "muse-wonder-1.0");
  assert.match((await errorOf(await run(g, "responses", { body: form }))).message, /takes a JSON body/);
  assert.match((await errorOf(await post(g, "files", { purpose: "user_data" }))).message, /multipart\/form-data/);
});

test("models: missing is 400, outside the docs' list is 404 model_not_found with what's allowed", async () => {
  const g = fakeDocs();
  const missing = await errorOf(await post(g, "responses", { input: "hi" }));
  assert.equal(missing.status, 400);
  assert.equal(missing.code, "missing_model");
  const other = await errorOf(await post(g, "chat/completions", { model: "gpt-5", messages: [] }));
  assert.equal(other.status, 404);
  assert.equal(other.code, "model_not_found");
  assert.match(other.message, /muse-spark-1\.3-contributor, muse-spark-1\.2, muse-spark-1\.2-contributor, muse-spark-1\.1, muse-wonder-1\.0/);
  assert.equal((await errorOf(await post(g, "chat/completions", { model: "muse-image-1.0", messages: [] }))).code, "model_not_found");
  assert.equal((await errorOf(await post(g, "images/generations", { model: "muse-wonder-1.0", prompt: "x" }))).code, "model_not_found");
  assert.equal(g.upstreamCalls.length, 0);
});

test("a call goes up with the key and comes back with x-docs-model and x-docs-note, and never the key", async () => {
  const g = fakeDocs({
    fetch: () => {
      const res = responseReply();
      res.headers.set("set-cookie", "upstream=1");
      res.headers.set("x-ratelimit-remaining-tokens", "9");
      return res;
    },
  });
  const res = await post(g, "responses", { model: "muse-spark-1.3", input: "hi" }, { authorization: "Bearer reader-key", "x-api-key": "reader-key" });
  assert.equal(res.status, 200);
  const call = g.upstreamCalls[0];
  assert.equal(call.url, "https://api.meta.test/v1/responses");
  const headers = upstreamHeaders(g);
  assert.equal(headers.authorization, `Bearer ${TEST_KEY}`);
  assert.equal(headers["x-api-key"], undefined, "the reader's key headers are dropped");
  assert.equal(headers.cookie, undefined, "the reader's cookies are dropped");
  assert.equal(upstreamBody(g).model, "muse-spark-1.3-contributor");
  assert.equal(upstreamBody(g).max_output_tokens, 16384);
  assert.equal(res.headers.get("x-docs-model"), "muse-spark-1.3-contributor");
  assert.match(res.headers.get("x-docs-note") ?? "", /never call muse-spark-1\.3.*Set max_output_tokens to 16384/);
  assert.equal(res.headers.get("x-request-id"), "req_1");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("set-cookie"), null, "no upstream cookie and no new visitor cookie");
  assert.equal(res.headers.get("x-ratelimit-remaining-tokens"), "9", "Meta's rate-limit headers come back");
  assert.equal((await everything(res)).includes(TEST_KEY), false);
  assert.equal(((await res.json()) as { id: string }).id, "resp_new1", "the body is Meta's");
});

test("Meta's rate-limit headers come back in every spelling, on JSON and streamed replies, and nothing about auth does", async () => {
  const limits: Record<string, string> = {
    "x-ratelimit-limit-requests": "150",
    "x-ratelimit-remaining-requests": "149",
    "x-ratelimit-limit-tokens": "3000000",
    "x-ratelimit-remaining-tokens": "2999950",
    "x-ratelimit-reset-requests": "0.4s",
    "x-rate-limit-reset": "12",
    "ratelimit-policy": "150;w=60",
    "anthropic-ratelimit-requests-remaining": "149",
  };
  const withHeaders = (res: Response) => {
    for (const [name, value] of Object.entries(limits)) res.headers.set(name, value);
    res.headers.set("set-cookie", "session=upstream");
    res.headers.set("www-authenticate", "Bearer realm=meta");
    res.headers.set("x-ratelimit-key", TEST_KEY);
    res.headers.set("x-meta-internal", "trace");
    return res;
  };
  const json = fakeDocs({ fetch: () => withHeaders(responseReply()) });
  const stream = fakeDocs({
    fetch: () => withHeaders(new Response(sse([{ data: { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } } }, { data: "[DONE]" }]), { headers: { "content-type": "text/event-stream" } })),
  });
  for (const res of [
    await post(json, "responses", { model: "muse-spark-1.3-contributor", input: "hi" }),
    await post(stream, "chat/completions", { model: "muse-spark-1.3-contributor", messages: [{ role: "user", content: "hi" }], stream: true }),
  ]) {
    for (const [name, value] of Object.entries(limits)) assert.equal(res.headers.get(name), value, name);
    for (const name of ["set-cookie", "www-authenticate", "x-ratelimit-key", "x-meta-internal"]) assert.equal(res.headers.get(name), null, name);
    assert.equal((await everything(res)).includes(TEST_KEY), false, "the key never comes back");
  }
  await json.settled();
  await stream.settled();
});

test("GET /v1/status goes up without the key; query strings pass only the documented parameters", async () => {
  const g = fakeDocs({ fetch: () => Response.json({ status: "ok" }) });
  await run(g, "status");
  assert.equal(upstreamHeaders(g).authorization, undefined);
  await handleDocsProxy(docsRequest("models?client=muse-code&evil=1"), ["models"], g.deps);
  assert.equal(g.upstreamCalls.at(-1)!.url, "https://api.meta.test/v1/models?client=muse-code");
  assert.equal(upstreamHeaders(g).authorization, `Bearer ${TEST_KEY}`);
});

test("rewrites reach Meta: images n at most 2, chat streams ask for usage, messages get max_tokens", async () => {
  const g = fakeDocs({
    fetch: (url) =>
      url.endsWith("/chat/completions")
        ? new Response(sse([{ data: "[DONE]" }]), { headers: { "content-type": "text/event-stream" } })
        : Response.json({ created: 1, data: [{ b64_json: "a" }, { b64_json: "b" }] }),
  });
  const img = await post(g, "images/generations", { model: "muse-image-1.0", prompt: "a fox", n: 6 });
  assert.equal(img.status, 200);
  assert.equal(upstreamBody(g).n, 2);
  assert.match(img.headers.get("x-docs-note") ?? "", /Lowered n from 6 to 2/);
  await post(g, "chat/completions", { model: "muse-wonder-1.0", messages: [{ role: "user", content: "hi" }], stream: true });
  assert.deepEqual(upstreamBody(g).stream_options, { include_usage: true });
  assert.equal(upstreamBody(g).max_completion_tokens, 4096);
  await g.settled();
});

test("Messages: anthropic-version passes, the reader's x-api-key doesn't, Meta's bearer auth is sent", async () => {
  const g = fakeDocs({
    fetch: () => Response.json({ id: "msg_1", type: "message", content: [], usage: { input_tokens: 10, output_tokens: 5 } }),
  });
  const res = await post(
    g,
    "messages",
    { model: "muse-spark-1.3-contributor", messages: [{ role: "user", content: "hi" }] },
    { "anthropic-version": "2023-06-01", "x-api-key": "sk-reader" },
  );
  assert.equal(res.status, 200);
  const headers = upstreamHeaders(g);
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(headers["x-api-key"], undefined);
  assert.equal(headers.authorization, `Bearer ${TEST_KEY}`);
  assert.equal(upstreamBody(g).max_tokens, 16384);
  await g.settled();
  assert.equal(g.usage[0].ctx.source, "docs");
  assert.equal(g.usage[0].ctx.endpoint, "messages");
  assert.equal(g.usage[0].items[0].inputTokens, 10);
});

test("per-IP runs a minute: the 21st in a minute is 429 with retry-after", async () => {
  const g = fakeDocs({ fetch: () => Response.json({ object: "list", data: [] }) });
  for (let i = 0; i < 20; i++) assert.equal((await run(g, "models")).status, 200, `run ${i + 1}`);
  const res = await run(g, "models");
  const err = await errorOf(res);
  assert.equal(err.status, 429);
  assert.equal(err.code, "rate_limited");
  assert.equal(err.message, "Live demos are limited to 20 runs a minute. Try again in 30 s.");
  assert.equal(res.headers.get("retry-after"), "30");
  assert.equal(g.upstreamCalls.length, 20);
  assert.equal(g.counter(DOCS_KEYS.minute(IP), minuteStart(NOW)), 21);
});

test("per-IP runs a day, and the limits follow the config", async () => {
  const day = dayWindow(NOW);
  const g = fakeDocs({ counters: { [`${DOCS_KEYS.day(IP)}|${day.toISOString()}`]: 400 } });
  const err = await errorOf(await run(g, "models"));
  assert.equal(err.code, "rate_limited");
  assert.match(err.message, /400 runs a day from one network\. They reset at 00:00 UTC, in 12 h/);
  assert.equal(day.toISOString(), "2026-10-31T00:00:00.000Z", "day rows sit at the day's end");

  const raised = fakeDocs({ config: { perIpRequestsPerMinute: 1000 }, fetch: () => Response.json({ data: [] }) });
  for (let i = 0; i < 30; i++) assert.equal((await run(raised, "models")).status, 200);
});

test("calls in flight: a fifth at once is 429 too_many_in_flight; slots come back after metering", async () => {
  const g = fakeDocs();
  g.inFlight.set(DOCS_KEYS.inFlight(IP), 4);
  const err = await errorOf(await run(g, "models"));
  assert.equal(err.status, 429);
  assert.equal(err.code, "too_many_in_flight");

  const h = fakeDocs({ fetch: () => responseReply() });
  await post(h, "responses", { model: "muse-wonder-1.0", input: "hi" });
  await h.settled();
  assert.equal(h.inFlight.get(DOCS_KEYS.inFlight(IP)), 0);
});

test("per-IP dollars: a run that doesn't fit what's left today is 429 ip_budget; free calls still run", async () => {
  const usdKey = `${DOCS_KEYS.usd(IP)}|${dayWindow(NOW).toISOString()}`;
  const g = fakeDocs({ counters: { [usdKey]: 1_999_000 }, fetch: () => Response.json({ data: [] }) });
  const res = await post(g, "responses", { model: "muse-wonder-1.0", input: "hi" });
  const err = await errorOf(res);
  assert.equal(err.status, 429);
  assert.equal(err.type, "insufficient_quota");
  assert.equal(err.code, "ip_budget");
  assert.match(err.message, /estimated at \$0\.08, more than the \$0\.00 left of today's \$2\.00/);
  assert.equal(res.headers.get("retry-after"), String(12 * 3600 - 30), "until 00:00 UTC");
  assert.equal(g.reservations.size, 0);
  assert.equal(g.counter(DOCS_KEYS.usd(IP), dayWindow(NOW)), 1_999_000, "nothing was added");
  assert.equal((await run(g, "models")).status, 200, "listing models costs nothing");

  const spent = fakeDocs({ counters: { [usdKey]: 2_000_000 } });
  assert.match((await errorOf(await post(spent, "responses", { model: "muse-wonder-1.0", input: "hi" }))).message, /You've used today's \$2\.00/);
});

test("the docs' daily cap is 503 docs_budget; the platform's cap is 503 platform_paused", async () => {
  const docs = fakeDocs({ docsSpend: 25 });
  const a = await errorOf(await post(docs, "responses", { model: "muse-wonder-1.0", input: "hi" }));
  assert.equal(a.status, 503);
  assert.equal(a.code, "docs_budget");
  const platform = fakeDocs({ platformSpend: 100 });
  const b = await errorOf(await post(platform, "responses", { model: "muse-wonder-1.0", input: "hi" }));
  assert.equal(b.status, 503);
  assert.equal(b.code, "platform_paused");
  assert.equal(docs.upstreamCalls.length + platform.upstreamCalls.length, 0);
});

test("metering: the estimate is held, then replaced by the metered usage, here and on the IP's counter", async () => {
  let held: { reservations: number; ipMicros: number } | null = null;
  const g: ReturnType<typeof fakeDocs> = fakeDocs({
    fetch: () => {
      held = { reservations: g.reservations.size, ipMicros: g.counter(DOCS_KEYS.usd(IP), dayWindow(NOW)) };
      return responseReply();
    },
  });
  const res = await post(g, "responses", { model: "muse-spark-1.3-contributor", input: "hi" });
  assert.equal(res.status, 200);
  // Held while the call ran: one usage row and the estimate on the IP's counter (16,384 output tokens at $0.20/M).
  assert.deepEqual(held, { reservations: 1, ipMicros: 3277 });
  await g.settled();
  assert.equal(g.reservations.size, 0);
  const cost = usageCost({ model: "muse-spark-1.3-contributor", inputTokens: 20, cachedInputTokens: 0, outputTokens: 300 });
  assert.deepEqual(g.usage.map((u) => [u.ctx.source, u.ctx.endpoint, u.items[0].costUsd]), [["docs", "responses", cost]]);
  assert.equal(g.counter(DOCS_KEYS.usd(IP), dayWindow(NOW)), Math.ceil(cost * 1e6 - 1e-6));
});

test("a refused or failed call gives the estimate back and passes Meta's own error through", async () => {
  const g = fakeDocs({ fetch: () => Response.json({ error: { type: "invalid_request_error", message: "bad input" } }, { status: 400 }) });
  const res = await post(g, "responses", { model: "muse-wonder-1.0", input: "hi" });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { error: { message: string } }).error.message, "bad input");
  assert.equal(g.reservations.size, 0);
  assert.equal(g.counter(DOCS_KEYS.usd(IP), dayWindow(NOW)), 0);

  const down = fakeDocs({ fetch: () => Promise.reject(new Error("ECONNRESET")) });
  const err = await errorOf(await post(down, "responses", { model: "muse-wonder-1.0", input: "hi" }));
  assert.equal(err.code, "upstream_unreachable");
  assert.equal(down.reservations.size, 0);

  // A refused key is ours to explain, and Meta's words about it never reach the reader.
  const key = fakeDocs({ fetch: () => Response.json({ error: { message: `Invalid key ${TEST_KEY}` } }, { status: 401 }) });
  const refused = await post(key, "responses", { model: "muse-wonder-1.0", input: "hi" });
  assert.equal((await errorOf(refused.clone())).code, "upstream_auth");
  assert.equal((await everything(refused)).includes(TEST_KEY), false);
});

test("a deploy without a key fails with 500 and charges nothing", async () => {
  const g = fakeDocs();
  g.deps.upstreamKey = () => {
    throw new Error("MODEL_API_KEY is not set. See .env.example.");
  };
  const res = await post(g, "responses", { model: "muse-wonder-1.0", input: "hi" });
  const err = await errorOf(res);
  assert.equal(err.status, 500);
  assert.equal(err.code, "docs_error");
  assert.equal(err.message.includes("MODEL_API_KEY"), false, "the reason stays in the server's log");
  assert.equal(g.reservations.size, 0);
  assert.equal(g.counter(DOCS_KEYS.usd(IP), dayWindow(NOW)), 0);
  assert.equal(g.inFlight.get(DOCS_KEYS.inFlight(IP)), 0, "the slot is given back");
});

/** Spark 1.3 Contributor's worst case with no tools: its whole context window in, its output cap out. */
const CONTRIBUTOR_WORST = usageCost({ model: "muse-spark-1.3-contributor", inputTokens: 1_048_576, cachedInputTokens: 0, outputTokens: 16_384 });
const queued = (id = "resp_bg1") => Response.json({ id, object: "response", status: "queued", background: true, output: [], usage: null });

test("background responses hold their worst case, owned by the visitor, until they finish", async () => {
  const g = fakeDocs({ fetch: () => queued() });
  const res = await post(g, "responses", { model: "muse-spark-1.3-contributor", input: "a long job", background: true });
  assert.equal(res.status, 200);
  await g.settled();
  assert.equal(g.reservations.size, 1, "the hold stays while the response runs");
  const [reservation] = [...g.reservations.values()];
  close(reservation.costUsd, CONTRIBUTOR_WORST);
  assert.equal(g.counter(DOCS_KEYS.usd(IP), dayWindow(NOW)), Math.ceil(CONTRIBUTOR_WORST * 1e6 - 1e-6));
  assert.equal(g.objects.length, 1);
  assert.equal(g.objects[0].id, "resp_bg1");
  assert.equal(g.objects[0].hold?.reservation, [...g.reservations.keys()][0], "the row keeps the hold to settle later");
  assert.equal(g.usage.length, 0);
});

test("a background response settles from its usage when the reader retrieves it finished, once", async () => {
  const done = { id: "resp_bg1", object: "response", status: "completed", background: true, output: [], usage };
  let reply: Response = queued();
  const g = fakeDocs({ fetch: () => reply.clone() });
  await post(g, "responses", { model: "muse-spark-1.3-contributor", input: "a long job", background: true });
  await g.settled();
  // Still running: nothing changes.
  reply = Response.json({ ...done, status: "in_progress", usage: null });
  assert.equal((await run(g, "responses/resp_bg1")).status, 200);
  await g.settled();
  assert.equal(g.reservations.size, 1);
  // Finished: the worst case is replaced by what it used, here and on the IP's counter.
  reply = Response.json(done);
  const res = await run(g, "responses/resp_bg1");
  assert.equal(((await res.json()) as { status: string }).status, "completed", "the reader gets Meta's reply");
  await g.settled();
  const cost = usageCost({ model: "muse-spark-1.3-contributor", inputTokens: 20, cachedInputTokens: 0, outputTokens: 300 });
  assert.equal(g.reservations.size, 0);
  assert.deepEqual(g.usage.map((u) => [u.ctx.endpoint, u.items[0].costUsd]), [["responses", cost]]);
  assert.equal(g.counter(DOCS_KEYS.usd(IP), dayWindow(NOW)), Math.ceil(cost * 1e6 - 1e-6));
  assert.equal(g.objects[0].hold, undefined);
  // Reading it again settles nothing twice.
  await run(g, "responses/resp_bg1");
  await g.settled();
  assert.equal(g.usage.length, 1);
});

test("a background response settles from a streamed retrieval's final event, a cancel, or just before its delete", async () => {
  const held = async () => {
    const g = fakeDocs({ fetch: () => queued() });
    await post(g, "responses", { model: "muse-spark-1.3-contributor", input: "a long job", background: true });
    await g.settled();
    return g;
  };
  const final = { id: "resp_bg1", status: "completed", output: [], usage };
  const cost = usageCost({ model: "muse-spark-1.3-contributor", inputTokens: 20, cachedInputTokens: 0, outputTokens: 300 });

  const streamed = await held();
  const stream = sse([
    { event: "response.created", data: { type: "response.created", response: { id: "resp_bg1", status: "in_progress" } } },
    { event: "response.completed", data: { type: "response.completed", response: final } },
    { data: "[DONE]" },
  ]);
  streamed.deps.fetch = (async () => new Response(stream, { headers: { "content-type": "text/event-stream" } })) as typeof fetch;
  const res = await handleDocsProxy(docsRequest("responses/resp_bg1?stream=true"), ["responses", "resp_bg1"], streamed.deps);
  assert.equal(await res.text(), stream, "the stream passes through untouched");
  await streamed.settled();
  assert.equal(streamed.reservations.size, 0);
  assert.equal(streamed.usage[0].items[0].costUsd, cost);

  const cancelled = await held();
  cancelled.deps.fetch = (async () => Response.json({ ...final, status: "cancelled" })) as typeof fetch;
  assert.equal((await run(cancelled, "responses/resp_bg1/cancel", { method: "POST" })).status, 200);
  await cancelled.settled();
  assert.equal(cancelled.reservations.size, 0);
  assert.equal(cancelled.usage[0].items[0].costUsd, cost);

  const deleted = await held();
  const methods: string[] = [];
  deleted.deps.fetch = (async (_url: string, init?: RequestInit) => {
    methods.push(init?.method ?? "GET");
    return init?.method === "DELETE" ? Response.json({ id: "resp_bg1", object: "response", deleted: true }) : Response.json(final);
  }) as typeof fetch;
  assert.equal((await run(deleted, "responses/resp_bg1", { method: "DELETE" })).status, 200);
  await deleted.settled();
  assert.deepEqual(methods, ["GET", "DELETE"], "read once to settle, then deleted");
  assert.equal(deleted.reservations.size, 0);
  assert.equal(deleted.usage[0].items[0].costUsd, cost);
  assert.equal(deleted.objects.length, 0);
});

test("a background response cancelled before it ran settles at zero: read back after the cancel, on retrieval, or before its delete", async () => {
  const held = async () => {
    const g = fakeDocs({ fetch: () => queued() });
    await post(g, "responses", { model: "muse-spark-1.3-contributor", input: "a long job", background: true });
    await g.settled();
    assert.equal(g.reservations.size, 1);
    assert.ok(g.counter(DOCS_KEYS.usd(IP), dayWindow(NOW)) > 0, "the worst case is held");
    return g;
  };
  /** The cancel endpoint's reply: the lifecycle fields only, never usage (api-reference/responses/schemas). */
  const cancelReply = (status = "cancelled") => Response.json({ id: "resp_bg1", object: "response", status, model: "muse-spark-1.3-contributor", background: true, output: [] });
  /** The response read back: cancelled before it ran, so Meta reports usage null. */
  const unrun = { id: "resp_bg1", object: "response", status: "cancelled", background: true, output: [], usage: null, completed_at: null };
  const atZero = (g: ReturnType<typeof fakeDocs>, why: string) => {
    assert.equal(g.reservations.size, 0, `${why}: the hold is settled`);
    assert.equal(g.usage.length, 0, `${why}: nothing was used`);
    assert.equal(g.counter(DOCS_KEYS.usd(IP), dayWindow(NOW)), 0, `${why}: the IP's dollars come back`);
  };

  // The cancel's own reply says nothing about usage, so the response is read back, and settles at zero.
  const cancelled = await held();
  const calls: string[] = [];
  cancelled.deps.fetch = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    return init?.method === "POST" ? cancelReply() : Response.json(unrun);
  }) as typeof fetch;
  const res = await run(cancelled, "responses/resp_bg1/cancel", { method: "POST" });
  assert.equal(((await res.json()) as { status: string }).status, "cancelled", "the reader gets Meta's reply");
  await cancelled.settled();
  assert.deepEqual(calls, ["POST /v1/responses/resp_bg1/cancel", "GET /v1/responses/resp_bg1"]);
  atZero(cancelled, "cancel");
  assert.equal(cancelled.objects[0].hold, undefined);

  // A cancel still taking hold says in_progress: nothing is read or settled yet, and the hold waits for the next read.
  const stopping = await held();
  stopping.deps.fetch = (async () => cancelReply("in_progress")) as typeof fetch;
  await run(stopping, "responses/resp_bg1/cancel", { method: "POST" });
  await stopping.settled();
  assert.equal(stopping.reservations.size, 1);
  assert.ok(stopping.objects[0].hold);
  // ...which is the reader's next retrieval: cancelled, usage null, settled at zero.
  stopping.deps.fetch = (async () => Response.json(unrun)) as typeof fetch;
  await run(stopping, "responses/resp_bg1");
  await stopping.settled();
  atZero(stopping, "retrieval");

  // Failed without usage settles at zero too; completed without usage keeps its worst case.
  const failed = await held();
  failed.deps.fetch = (async () => Response.json({ ...unrun, status: "failed", error: { code: "server_error", message: "boom" } })) as typeof fetch;
  await run(failed, "responses/resp_bg1");
  await failed.settled();
  atZero(failed, "failed");
  const silent = await held();
  silent.deps.fetch = (async () => Response.json({ id: "resp_bg1", object: "response", status: "completed", output: [] })) as typeof fetch;
  await run(silent, "responses/resp_bg1");
  await silent.settled();
  assert.equal(silent.reservations.size, 1, "a completed reply without usage keeps the worst case");

  // Deleted after a cancel: read once, settled at zero, then deleted, and the row goes with nothing left to settle.
  const deleted = await held();
  const methods: string[] = [];
  deleted.deps.fetch = (async (_url: string, init?: RequestInit) => {
    methods.push(init?.method ?? "GET");
    return init?.method === "DELETE" ? Response.json({ id: "resp_bg1", object: "response", deleted: true }) : Response.json(unrun);
  }) as typeof fetch;
  assert.equal((await run(deleted, "responses/resp_bg1", { method: "DELETE" })).status, 200);
  await deleted.settled();
  assert.deepEqual(methods, ["GET", "DELETE"]);
  atZero(deleted, "delete");
  assert.equal(deleted.objects.length, 0);
});

test("deleting a background response settles it first: a running one is cancelled and read back, an unreadable one keeps its worst case", async () => {
  const held = async () => {
    const g = fakeDocs({ fetch: () => queued() });
    await post(g, "responses", { model: "muse-spark-1.3-contributor", input: "a long job", background: true });
    await g.settled();
    return g;
  };
  // Still queued when the reader deletes it: cancelled first, read back once the cancel takes hold, then deleted.
  const running = await held();
  const calls: string[] = [];
  let cancelled = false;
  running.deps.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${new URL(url).pathname}`);
    if (method === "POST") {
      cancelled = true;
      return Response.json({ id: "resp_bg1", object: "response", status: "cancelled", background: true, output: [] });
    }
    if (method === "DELETE") return Response.json({ id: "resp_bg1", object: "response", deleted: true });
    return Response.json({ id: "resp_bg1", object: "response", status: cancelled ? "cancelled" : "queued", background: true, output: [], usage: null });
  }) as typeof fetch;
  const res = await run(running, "responses/resp_bg1", { method: "DELETE" });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("x-docs-note") ?? "", /still running, so it was cancelled before the delete/);
  await running.settled();
  assert.deepEqual(calls, ["GET /v1/responses/resp_bg1", "POST /v1/responses/resp_bg1/cancel", "GET /v1/responses/resp_bg1", "DELETE /v1/responses/resp_bg1"]);
  assert.equal(running.reservations.size, 0, "settled at zero before the row went");
  assert.equal(running.counter(DOCS_KEYS.usd(IP), dayWindow(NOW)), 0);
  assert.equal(running.objects.length, 0);

  // Meta can't be read before the delete: the delete goes ahead, and the worst case stays as the settled charge.
  const unreadable = await held();
  unreadable.deps.fetch = (async (_url: string, init?: RequestInit) =>
    init?.method === "DELETE" ? Response.json({ id: "resp_bg1", object: "response", deleted: true }) : new Response("upstream error", { status: 502 })) as typeof fetch;
  const claimed: string[] = [];
  const claim = unreadable.deps.claimHold;
  unreadable.deps.claimHold = async (id) => {
    claimed.push(id);
    return claim(id);
  };
  assert.equal((await run(unreadable, "responses/resp_bg1", { method: "DELETE" })).status, 200);
  await unreadable.settled();
  assert.deepEqual(claimed, ["resp_bg1"], "the hold is taken off its row before the row goes");
  assert.equal(unreadable.reservations.size, 1, "the worst case stays as the charge");
  close([...unreadable.reservations.values()][0].costUsd, CONTRIBUTOR_WORST);
  assert.equal(unreadable.objects.length, 0);

  // A delete Meta refuses changes nothing: the row and its hold stay for the sweep.
  const refused = await held();
  refused.deps.fetch = (async (_url: string, init?: RequestInit) =>
    init?.method === "DELETE" ? Response.json({ error: { message: "nope" } }, { status: 500 }) : Response.json({ id: "resp_bg1", status: "completed", output: [] })) as typeof fetch;
  assert.equal((await run(refused, "responses/resp_bg1", { method: "DELETE" })).status, 500);
  await refused.settled();
  assert.ok(refused.objects[0]?.hold, "kept for the sweep");
});

test("background is refused where its cost can't be bounded or read back", async () => {
  const g = fakeDocs({ fetch: () => queued() });
  const refused = async (body: Record<string, unknown>) => errorOf(await post(g, "responses", { input: "a long job", ...body }));
  // Not a boolean: Meta might read "true" or 1 as true and run it in the background unseen.
  for (const background of ["true", 1, "yes"]) {
    const err = await refused({ model: "muse-spark-1.3-contributor", background });
    assert.equal(err.status, 400, String(background));
    assert.equal(err.code, "unsupported_background");
    assert.match(err.message, /must be true or false/);
  }
  // Muse Wonder's worst case (its whole context window) is more than a reader's $2 a day.
  const wonder = await refused({ model: "muse-wonder-1.0", background: true });
  assert.equal(wonder.code, "unsupported_background");
  assert.match(wonder.message, /\$4\.28 on muse-wonder-1\.0: more than the \$2\.00 a day/);
  assert.match(wonder.message, /muse-spark-1\.3-contributor/, "names the models that fit");
  // Muse Image and SAM bill per image and per frame.
  assert.match((await refused({ model: "sam-3.1", background: true })).message, /text models only/);
  assert.match((await refused({ model: "muse-image-1.0", background: true })).message, /text models only/);
  // Unstored, it could never be read back and settled.
  assert.match((await refused({ model: "muse-spark-1.3-contributor", background: true, store: false })).message, /"store": true/);
  assert.equal(g.upstreamCalls.length, 0);
  assert.equal(g.reservations.size, 0);
  // background: false and null run as usual.
  const g2 = fakeDocs({ fetch: () => responseReply() });
  assert.equal((await post(g2, "responses", { model: "muse-wonder-1.0", input: "hi", background: false })).status, 200);
  assert.equal((await post(g2, "responses", { model: "muse-wonder-1.0", input: "hi", background: null })).status, 200);
  await g2.settled();
});

test("a reply that runs in the background, or shows no usage, keeps its estimate instead of settling at nothing", async () => {
  // Meta queued it though the request didn't ask: the hold stays and the row keeps it for the sweep.
  const coerced = fakeDocs({ fetch: () => queued("resp_q") });
  await post(coerced, "responses", { model: "muse-spark-1.3-contributor", input: "hi" });
  await coerced.settled();
  assert.equal(coerced.reservations.size, 1);
  assert.ok(coerced.counter(DOCS_KEYS.usd(IP), dayWindow(NOW)) > 0);
  assert.ok(coerced.objects[0].hold, "kept for the sweep");

  for (const [p, body, reply] of [
    ["responses", { model: "muse-wonder-1.0", input: "hi" }, { id: "resp_x", object: "response", status: "completed", output: [] }],
    ["chat/completions", { model: "muse-wonder-1.0", messages: [{ role: "user", content: "hi" }] }, { id: "c1", choices: [] }],
    ["messages", { model: "muse-wonder-1.0", messages: [{ role: "user", content: "hi" }] }, { id: "m1", type: "message", content: [] }],
  ] as const) {
    const g = fakeDocs({ fetch: () => Response.json(reply) });
    await post(g, p, body);
    await g.settled();
    assert.equal(g.reservations.size, 1, `${p}: the estimate stays`);
    assert.equal(g.usage.length, 0, p);
  }
  // Images say what they used by the images themselves: none back is nothing to pay.
  const none = fakeDocs({ fetch: () => Response.json({ created: 1, data: [] }) });
  await post(none, "images/generations", { model: "muse-image-1.0", prompt: "a fox" });
  await none.settled();
  assert.equal(none.reservations.size, 0);
  assert.equal(none.counter(DOCS_KEYS.usd(IP), dayWindow(NOW)), 0);
});

test("GET /v1/files looks up at most 20 of the visitor's files", async () => {
  const objects = Array.from({ length: 30 }, (_, i) => ({ id: `file-${i}`, kind: "file" as const }));
  const g = fakeDocs({
    objects,
    fetch: (url) => Response.json({ id: url.split("/").at(-1), object: "file", bytes: 1, created_at: 1, filename: "a", purpose: "user_data" }),
  });
  const list = (await (await run(g, "files")).json()) as { data: unknown[] };
  assert.equal(g.upstreamCalls.length, 20);
  assert.equal(list.data.length, 20);
});

test("multipart ids are checked like JSON ones: a bracketed file_id must be the visitor's", async () => {
  const g = fakeDocs({ objects: [{ id: "file-theirs", kind: "file", visitor: visitorHash(OTHER_VISITOR) }] });
  const form = new FormData();
  form.set("model", "muse-image-1.0");
  form.set("prompt", "a hat");
  form.set("images[0][file_id]", "file-theirs");
  const err = await errorOf(await run(g, "images/edits", { body: form }));
  assert.equal(err.code, "not_found");
  assert.equal(g.upstreamCalls.length, 0);
  // A repeated n is refused before anything else happens.
  const twice = new FormData();
  twice.set("model", "muse-image-1.0");
  twice.append("n", "1");
  twice.append("n", "10");
  const repeated = await errorOf(await run(g, "images/edits", { body: twice }));
  assert.equal(repeated.code, "invalid_body");
  assert.match(repeated.message, /Send n once/);
});

test("every reader together: runs a minute per model, and uploads an hour", async () => {
  const minute = minuteStart(NOW).toISOString();
  const g = fakeDocs({
    counters: { [`docs-model:muse-spark-1.3-contributor|${minute}`]: 50 },
    fetch: () => responseReply(),
  });
  const busy = await post(g, "responses", { model: "muse-spark-1.3", input: "hi" });
  const err = await errorOf(busy.clone());
  assert.equal(err.status, 429);
  assert.equal(err.code, "model_busy");
  assert.match(err.message, /muse-spark-1\.3-contributor are busy: every reader together gets 50 runs a minute/);
  assert.equal(busy.headers.get("retry-after"), "30");
  assert.equal(g.upstreamCalls.length, 0);
  // Another model still runs, and counts on its own.
  assert.equal((await post(g, "responses", { model: "muse-spark-1.2", input: "hi" })).status, 200);
  assert.equal(g.counter("docs-model:muse-spark-1.2", minuteStart(NOW)), 1);
  // Calls with no model (listing, files) don't count toward any.
  await run(g, "models");
  await g.settled();

  const hour = new Date(Math.floor(NOW.getTime() / 3_600_000) * 3_600_000).toISOString();
  const u = fakeDocs({ counters: { [`docs-uploads|${hour}`]: 1000 } });
  const form = new FormData();
  form.set("purpose", "user_data");
  form.set("file", new Blob(["x"]), "a.txt");
  const full = await errorOf(await run(u, "files", { body: form }));
  assert.equal(full.code, "uploads_busy");
  assert.match(full.message, /1,000 uploads an hour across every reader/);
  assert.equal(u.upstreamCalls.length, 0);
});

test("a stream cut off before its final usage keeps the estimate, which counted the input", async () => {
  const input = "x".repeat(400_000);
  const cut = new ReadableStream<Uint8Array>({
    start(controller) {
      const text = sse([
        { event: "response.created", data: { type: "response.created", response: { id: "resp_cut", status: "in_progress" } } },
        { event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "Hello" } },
      ]);
      controller.enqueue(new TextEncoder().encode(text));
      controller.error(new Error("upstream deadline"));
    },
  });
  const g: ReturnType<typeof fakeDocs> = fakeDocs({ fetch: () => new Response(cut, { headers: { "content-type": "text/event-stream" } }) });
  let estimate = 0;
  const realReserve = g.deps.reserveSpend;
  g.deps.reserveSpend = async (ctx, model, costUsd) => {
    estimate = costUsd;
    return realReserve(ctx, model, costUsd);
  };
  const res = await post(g, "responses", { model: "muse-wonder-1.0", input, stream: true });
  await res.text().catch(() => "");
  await g.settled();
  assert.ok(estimate > 0.4, `100,000 input tokens on Wonder: ${estimate}`);
  assert.equal(g.reservations.size, 1, "the estimate stays as the charge");
  assert.equal(g.usage.length, 0);
  assert.equal(g.counter(DOCS_KEYS.usd(IP), dayWindow(NOW)), Math.ceil(estimate * 1e6 - 1e-6));
  // A stream that finished settles at its usage as before.
  const whole = fakeDocs({
    fetch: () =>
      new Response(
        sse([{ event: "response.completed", data: { type: "response.completed", response: { id: "r", status: "completed", output: [], usage } } }]),
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  await (await post(whole, "responses", { model: "muse-wonder-1.0", input, stream: true })).text();
  await whole.settled();
  assert.equal(whole.reservations.size, 0);
  assert.equal(whole.usage[0].items[0].inputTokens, 20);
});

test("the daily caps are read after the call's own hold, so calls arriving together can't all pass", async () => {
  // $24.95 spent; each call holds about $0.08 (Wonder, 4,096 output tokens). Ten at once: at most one fits.
  const g = fakeDocs({ docsSpend: 24.95, config: { perIpInFlight: 20, perIpRequestsPerMinute: 100 }, fetch: () => responseReply() });
  const results = await Promise.all(Array.from({ length: 10 }, () => post(g, "responses", { model: "muse-wonder-1.0", input: "hi" })));
  const passed = results.filter((r) => r.status === 200).length;
  assert.ok(passed <= 1, `${passed} passed`);
  for (const r of results.filter((r) => r.status !== 200)) assert.equal((await errorOf(r)).code, "docs_budget");
  await g.settled();
  assert.equal(g.reservations.size, 0, "refused calls give their hold back");
  // The platform's cap the same way.
  const p = fakeDocs({ platformSpend: 99.95, config: { perIpInFlight: 20, perIpRequestsPerMinute: 100 }, fetch: () => responseReply() });
  const platform = await Promise.all(Array.from({ length: 10 }, () => post(p, "responses", { model: "muse-wonder-1.0", input: "hi" })));
  assert.ok(platform.filter((r) => r.status === 200).length <= 1);
  await p.settled();
});

test("a dollar cap of 0 pauses paid demos and leaves free calls running", async () => {
  for (const config of [{ docsDailyCapUsd: 0 }, { perIpDailyUsd: 0 }]) {
    const g = fakeDocs({ config, fetch: () => Response.json({ object: "list", data: [] }) });
    const err = await errorOf(await post(g, "responses", { model: "muse-spark-1.3-contributor", input: "hi" }));
    assert.equal(err.status, 503, JSON.stringify(config));
    assert.equal(err.code, "paid_paused");
    assert.match(err.message, /cost money are paused/);
    assert.equal((await run(g, "models")).status, 200, "listing models is free");
    // A background request says the same, rather than that its worst case doesn't fit.
    assert.match((await errorOf(await post(g, "responses", { model: "muse-spark-1.3-contributor", input: "hi", background: true }))).message, /cost money are paused/);
  }
});

test("ids from JSON replies are recorded before the reply returns; store:false records nothing", async () => {
  const g = fakeDocs({ fetch: () => responseReply() });
  await post(g, "responses", { model: "muse-wonder-1.0", input: "hi" });
  assert.deepEqual(g.objects, [{ id: "resp_new1", kind: "response", visitor: visitorHash(VISITOR) }]);
  const unstored = fakeDocs({ fetch: () => responseReply() });
  await post(unstored, "responses", { model: "muse-wonder-1.0", input: "hi", store: false });
  await unstored.settled();
  assert.deepEqual(unstored.objects, []);
});

test("ids from a stream are recorded from response.created, and the stream passes through untouched", async () => {
  const stream = sse([
    { event: "response.created", data: { type: "response.created", response: { id: "resp_s1", status: "in_progress" } } },
    { event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "Hello" } },
    { event: "response.completed", data: { type: "response.completed", response: { id: "resp_s1", status: "completed", output: [], usage } } },
    { data: "[DONE]" },
  ]);
  const g = fakeDocs({ fetch: () => new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8" } }) });
  const res = await post(g, "responses", { model: "muse-wonder-1.0", input: "hi", stream: true });
  assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "no-cache, no-transform");
  assert.equal(res.headers.get("x-accel-buffering"), "no");
  assert.equal(await res.text(), stream);
  await g.settled();
  assert.deepEqual(g.objects, [{ id: "resp_s1", kind: "response", visitor: visitorHash(VISITOR) }]);
  assert.equal(g.usage[0].items[0].outputTokens, 300);
});

test("files: an upload is owned by its visitor; the list shows only theirs; others' ids are 404", async () => {
  const meta: Record<string, Record<string, unknown>> = {
    "file-mine2": { id: "file-mine2", object: "file", bytes: 3, created_at: 200, filename: "b.png", purpose: "user_data" },
    "file-mine1": { id: "file-mine1", object: "file", bytes: 3, created_at: 100, filename: "a.png", purpose: "user_data" },
  };
  const g = fakeDocs({
    objects: [
      { id: "file-mine1", kind: "file" },
      { id: "file-theirs", kind: "file", visitor: visitorHash(OTHER_VISITOR) },
      { id: "file-gone", kind: "file" },
    ],
    fetch: (url, init) => {
      if (init?.method === "POST") return Response.json(meta["file-mine2"]);
      const id = url.split("/").at(-1)!;
      return meta[id] ? Response.json(meta[id]) : Response.json({ error: { message: "No such file" } }, { status: 404 });
    },
  });
  const form = new FormData();
  form.set("purpose", "user_data");
  form.set("file", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "b.png");
  const upload = await run(g, "files", { body: form });
  assert.equal(upload.status, 200);
  assert.ok(g.objects.some((o) => o.id === "file-mine2" && o.visitor === visitorHash(VISITOR)));
  // Every upload goes up with an hour's expiry, so Meta deletes it even if the cleanup can't.
  const sent = g.upstreamCalls.at(-1)!.init!.body as FormData;
  assert.ok(sent instanceof FormData, "rebuilt, and encoded by fetch with its own boundary");
  assert.equal(upstreamHeaders(g)["content-type"], undefined);
  assert.deepEqual([...sent.keys()], ["purpose", "expires_after[anchor]", "expires_after[seconds]", "file"]);
  assert.equal(sent.get("expires_after[seconds]"), "3600");
  assert.match(upload.headers.get("x-docs-note") ?? "", /expires_after/);

  const listed = await run(g, "files");
  const list = (await listed.json()) as { data: Array<{ id: string }>; first_id: string; last_id: string; has_more: boolean };
  assert.deepEqual(
    list.data.map((f) => f.id),
    ["file-mine2", "file-mine1"],
    "newest first, only this visitor's",
  );
  assert.equal(list.first_id, "file-mine2");
  assert.equal(list.has_more, false);
  assert.match(listed.headers.get("x-docs-note") ?? "", /only the files uploaded from this browser/);
  assert.equal(g.upstreamCalls.some((c) => c.url.endsWith("/files/file-theirs")), false, "never looks up another visitor's file");
  assert.equal(g.objects.some((o) => o.id === "file-gone"), false, "a file Meta no longer has is forgotten");

  const asc = (await (await handleDocsProxy(docsRequest("files?order=asc&limit=1"), ["files"], g.deps)).json()) as typeof list;
  assert.deepEqual(asc.data.map((f) => f.id), ["file-mine1"]);
  assert.equal(asc.has_more, true);

  const calls = g.upstreamCalls.length;
  for (const [method, p] of [
    ["GET", "files/file-theirs"],
    ["GET", "files/file-theirs/content"],
    ["DELETE", "files/file-theirs"],
  ]) {
    const err = await errorOf(await run(g, p, { method }));
    assert.equal(err.status, 404, `${method} ${p}`);
    assert.equal(err.code, "not_found");
    assert.match(err.message, /uploaded from this browser/);
  }
  assert.equal(g.upstreamCalls.length, calls, "no upstream call for someone else's file");

  const del = await run(g, "files/file-mine1", { method: "DELETE" });
  assert.equal(del.status, 200);
  assert.equal(g.objects.some((o) => o.id === "file-mine1"), false, "forgotten once deleted");
});

test("uploads must be user_data files", async () => {
  const g = fakeDocs();
  const form = new FormData();
  form.set("purpose", "batch");
  form.set("file", new Blob(["{}"]), "batch.jsonl");
  assert.match((await errorOf(await run(g, "files", { body: form }))).message, /purpose "user_data"/);
  const noFile = new FormData();
  noFile.set("purpose", "user_data");
  assert.match((await errorOf(await run(g, "files", { body: noFile }))).message, /"file" part/);
});

test("file content passes through as bytes for its owner", async () => {
  const g = fakeDocs({
    objects: [{ id: "file-1", kind: "file" }],
    fetch: () => new Response(new Uint8Array([9, 8, 7]), { headers: { "content-type": "application/octet-stream", "content-disposition": "attachment" } }),
  });
  const res = await run(g, "files/file-1/content");
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [9, 8, 7]);
  assert.equal(res.headers.get("content-disposition"), "attachment");
});

test("responses: retrieve, delete and cancel only this visitor's", async () => {
  const g = fakeDocs({
    objects: [
      { id: "resp_mine", kind: "response" },
      { id: "resp_theirs", kind: "response", visitor: visitorHash(OTHER_VISITOR) },
    ],
    fetch: () => Response.json({ id: "resp_mine", object: "response", status: "cancelled" }),
  });
  for (const [method, p] of [
    ["GET", "responses/resp_theirs"],
    ["DELETE", "responses/resp_theirs"],
    ["POST", "responses/resp_theirs/cancel"],
    ["GET", "responses/resp_nobody"],
  ]) {
    assert.equal((await errorOf(await run(g, p, { method }))).code, "not_found", `${method} ${p}`);
  }
  assert.equal(g.upstreamCalls.length, 0);
  assert.equal((await run(g, "responses/resp_mine/cancel", { method: "POST" })).status, 200);
  assert.equal(g.upstreamCalls.at(-1)!.url, "https://api.meta.test/v1/responses/resp_mine/cancel");
  await handleDocsProxy(docsRequest("responses/resp_mine?stream=true&starting_after=3&x=1"), ["responses", "resp_mine"], g.deps);
  assert.equal(g.upstreamCalls.at(-1)!.url, "https://api.meta.test/v1/responses/resp_mine?stream=true&starting_after=3");
  // A visitor with no cookie owns nothing.
  assert.equal((await errorOf(await run(g, "responses/resp_mine", { visitor: null }))).code, "not_found");
});

test("ids a body points at must be this visitor's: previous_response_id and every file_id", async () => {
  const g = fakeDocs({
    objects: [
      { id: "resp_mine", kind: "response" },
      { id: "file-mine", kind: "file" },
      { id: "file-theirs", kind: "file", visitor: visitorHash(OTHER_VISITOR) },
    ],
    fetch: () => responseReply(),
  });
  const notMine = await errorOf(await post(g, "responses", { model: "muse-wonder-1.0", input: "more", previous_response_id: "resp_other" }));
  assert.equal(notMine.code, "not_found");
  assert.match(notMine.message, /No response "resp_other"/);
  const theirFile = await errorOf(
    await post(g, "responses", {
      model: "muse-wonder-1.0",
      input: [{ role: "user", content: [{ type: "input_file", file_id: "file-theirs" }] }],
    }),
  );
  assert.match(theirFile.message, /No file "file-theirs"/);
  // A response id passed as a file is not a file.
  assert.equal(
    (await errorOf(await post(g, "chat/completions", { model: "muse-wonder-1.0", messages: [{ role: "user", content: [{ type: "file", file: { file_id: "resp_mine" } }] }] }))).code,
    "not_found",
  );
  assert.equal((await errorOf(await post(g, "responses", { model: "muse-wonder-1.0", input: [{ type: "item_reference", id: "msg_1" }] }))).code, "unsupported_reference");
  const many = Array.from({ length: 65 }, (_, i) => ({ type: "input_file", file_id: `file-${i}` }));
  const tooMany = await errorOf(await post(g, "responses", { model: "muse-wonder-1.0", input: [{ role: "user", content: many }] }));
  assert.equal(tooMany.code, "unsupported_reference");
  assert.match(tooMany.message, /at most 64/);
  assert.equal(g.upstreamCalls.length, 0);

  const ok = await post(g, "responses", {
    model: "muse-wonder-1.0",
    previous_response_id: "resp_mine",
    input: [{ role: "user", content: [{ type: "input_text", text: "and this" }, { type: "input_file", file_id: "file-mine" }] }],
  });
  assert.equal(ok.status, 200);
  await g.settled();
});

test("transcription: the WAV is checked, the form goes up as sent, and the estimate is the clip's length", async () => {
  let estimate = 0;
  const g: ReturnType<typeof fakeDocs> = fakeDocs({
    fetch: () => {
      estimate = [...g.reservations.values()][0]?.costUsd ?? 0;
      return Response.json({ sessionId: "s1", transcript: "hello\u200b", audioDurationMs: 2000, turns: [] });
    },
  });
  const form = new FormData();
  form.set("request", JSON.stringify({ model: "muse-voice-transcribe-1.0", audioEncoding: "WAV" }));
  form.set("audio", new Blob([wavBytes(16_000, 2_000)], { type: "audio/wav" }), "clip.wav");
  const res = await handleDocsProxy(docsRequest("asr/transcribe?sessionId=docs-1", { body: form }), ["asr", "transcribe"], g.deps);
  assert.equal(res.status, 200);
  assert.equal(g.upstreamCalls[0].url, "https://api.meta.test/v1/asr/transcribe?sessionId=docs-1");
  assert.ok(g.upstreamCalls[0].init!.body instanceof Uint8Array, "forwarded byte for byte");
  assert.ok(Math.abs(estimate - (2 / 3600) * 0.18) < 1e-12, "the clip's two seconds, not its byte count");
  await g.settled();
  assert.equal(g.usage[0].items[0].audioSeconds, 2);

  const notWav = new FormData();
  notWav.set("request", JSON.stringify({ model: "muse-voice-transcribe-1.0", audioEncoding: "WAV" }));
  notWav.set("audio", new Blob([new Uint8Array(100)], { type: "audio/mpeg" }), "clip.mp3");
  const err = await errorOf(await run(g, "asr/transcribe", { body: notWav }));
  assert.equal(err.code, "invalid_audio");
  assert.match(err.message, /must be a WAV file/);
});

test("a first-time visitor gets the mm_docs cookie: random, httpOnly, Lax, Secure on https, 30 days", async () => {
  const g = fakeDocs({ fetch: () => Response.json({ data: [] }) });
  const res = await run(g, "models", { visitor: null });
  const cookie = res.headers.get("set-cookie") ?? "";
  assert.match(cookie, new RegExp(`^mm_docs=${NEW_VISITOR}; Path=/api/docs; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure$`));
  const http = await run(g, "models", { visitor: null, headers: { "x-forwarded-proto": "http" } });
  assert.equal(http.headers.get("set-cookie")?.includes("Secure"), false);
  // Errors carry it too, so the next call is the same visitor.
  const refused = await run(g, "responses", { body: "{}", headers: JSON_CT, visitor: "not-a-valid-id" });
  assert.match(refused.headers.get("set-cookie") ?? "", /^mm_docs=visitorN/);
});

test("errors keep the gateway's shape", async () => {
  const g = fakeDocs();
  const res = await post(g, "responses", { input: "hi" });
  assert.deepEqual(await res.json(), {
    error: { type: "invalid_request_error", code: "missing_model", message: 'POST /v1/responses needs a "model".', param: null },
  });
  assert.equal(res.headers.get("x-should-retry"), "false");
});

test("GET /api/docs/limits says what the UI shows, sets the cookie, and holds no secrets", async () => {
  const usdKey = `${DOCS_KEYS.usd(IP)}|${dayWindow(NOW).toISOString()}`;
  const g = fakeDocs({ counters: { [usdKey]: 250_000 }, docsSpend: 3.5 });
  const res = await handleDocsLimits(new Request("https://mm.example/api/docs/limits", { headers: { "x-real-ip": IP } }), g.deps);
  assert.equal((await everything(res)).includes(TEST_KEY), false);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.live, true);
  assert.equal(body.ipSpentUsd, 0.25);
  assert.equal(body.docsSpentUsd, 3.5);
  assert.equal(body.perIpDailyUsd, 2);
  assert.equal(body.docsDailyCapUsd, 25);
  assert.equal(body.maxBodyBytes, 4.5 * 1024 * 1024);
  assert.equal(body.resetsAt, "2026-10-31T00:00:00.000Z");
  assert.ok((body.models as { text: string[] }).text.includes("muse-spark-1.3-contributor"));
  assert.match(res.headers.get("set-cookie") ?? "", /^mm_docs=/);
});
