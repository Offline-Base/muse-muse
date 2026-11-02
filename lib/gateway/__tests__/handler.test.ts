import { test } from "node:test";
import assert from "node:assert/strict";
import { AsrInputError, checkAudioUrl } from "@/lib/gateway/asr";
import { handleGateway } from "@/lib/gateway/handler";
import { fakeGateway, gatewayRequest, json, TEST_TOKEN } from "./helpers";

const spark = (extra: Record<string, unknown> = {}) => json({ model: "muse-spark-1.3", input: "hi", ...extra });
const JSON_CT = { "content-type": "application/json" };

async function errorOf(res: Response) {
  const body = (await res.json()) as { error: { type: string; code: string; message: string } };
  return { status: res.status, ...body.error };
}

test("unknown endpoint -> 404 before any auth", async () => {
  const g = fakeGateway();
  const res = await handleGateway(new Request("https://p/api/gateway/v1/models"), ["models"], g.deps);
  const err = await errorOf(res);
  assert.equal(err.status, 404);
  assert.equal(err.code, "unknown_endpoint");
  assert.equal(res.headers.get("x-should-retry"), "false");
});

test("GET on a known endpoint -> 405", async () => {
  const g = fakeGateway();
  const res = await handleGateway(gatewayRequest("responses", null, {}, "GET"), ["responses"], g.deps);
  assert.equal(res.status, 405);
});

test("missing or unknown token -> 401", async () => {
  const g = fakeGateway();
  const none = await handleGateway(
    new Request("https://p/api/gateway/v1/responses", { method: "POST", body: spark(), headers: JSON_CT }),
    ["responses"],
    g.deps,
  );
  assert.equal((await errorOf(none)).code, "invalid_token");
  const wrong = await handleGateway(
    gatewayRequest("responses", spark(), { ...JSON_CT, authorization: "Bearer mm_live_nopenopenopenopenopenope" }),
    ["responses"],
    g.deps,
  );
  assert.equal(wrong.status, 401);
});

test("disabled or failed product -> 403 product_disabled", async () => {
  for (const status of ["disabled", "failed", null] as const) {
    const g = fakeGateway({ productStatus: status });
    const err = await errorOf(await handleGateway(gatewayRequest("responses", spark(), JSON_CT), ["responses"], g.deps));
    assert.equal(err.status, 403);
    assert.equal(err.code, "product_disabled");
  }
  const building = fakeGateway({ productStatus: "building", fetch: async () => Response.json({ ok: true }) });
  assert.equal((await handleGateway(gatewayRequest("responses", spark(), JSON_CT), ["responses"], building.deps)).status, 200);
});

test("model checks: missing -> 400, not on the token or endpoint -> 404 model_not_found", async () => {
  const g = fakeGateway({ token: { allowedModels: ["muse-spark-1.3"] } });
  const missing = await errorOf(
    await handleGateway(gatewayRequest("responses", json({ input: "hi" }), JSON_CT), ["responses"], g.deps),
  );
  assert.equal(missing.status, 400);
  assert.equal(missing.code, "missing_model");

  const wonder = await errorOf(
    await handleGateway(gatewayRequest("responses", spark({ model: "muse-wonder-1.0" }), JSON_CT), ["responses"], g.deps),
  );
  assert.equal(wonder.status, 404);
  assert.equal(wonder.code, "model_not_found");
  assert.match(wonder.message, /Allowed: muse-spark-1\.3/);

  const wrongEndpoint = await errorOf(
    await handleGateway(gatewayRequest("images/generations", spark(), JSON_CT), ["images", "generations"], g.deps),
  );
  assert.equal(wrongEndpoint.code, "model_not_found");
  assert.equal(g.upstreamCalls.length, 0);
});

test("token budget spent -> 429 budget_exceeded; platform cap -> 503 platform_paused", async () => {
  const broke = fakeGateway({ tokenSpend: 3 });
  const err = await errorOf(await handleGateway(gatewayRequest("responses", spark(), JSON_CT), ["responses"], broke.deps));
  assert.equal(err.status, 429);
  assert.equal(err.code, "budget_exceeded");
  assert.equal(err.type, "insufficient_quota");

  const paused = fakeGateway({ platformSpend: 40 });
  const p = await errorOf(await handleGateway(gatewayRequest("responses", spark(), JSON_CT), ["responses"], paused.deps));
  assert.equal(p.status, 503);
  assert.equal(p.code, "platform_paused");
});

test("a build token's spent budget says the build's budget doesn't reset, so the agent doesn't wait for midnight", async () => {
  const g = fakeGateway({ token: { scope: "build", dailyBudgetUsd: 3 }, tokenSpend: 3 });
  const err = await errorOf(await handleGateway(gatewayRequest("responses", spark(), JSON_CT), ["responses"], g.deps));
  assert.equal(err.status, 429);
  assert.equal(err.code, "budget_exceeded");
  assert.match(err.message, /this build's \$3\.00 Meta budget for tests/);
  assert.match(err.message, /don't wait or retry/);
  assert.doesNotMatch(err.message, /00:00 UTC/);

  const live = fakeGateway({ tokenSpend: 3 });
  const liveErr = await errorOf(await handleGateway(gatewayRequest("responses", spark(), JSON_CT), ["responses"], live.deps));
  assert.match(liveErr.message, /This product used its \$3\.00 daily Meta budget\. It resets at 00:00 UTC\./);
});

test("rate limits: 120/min per token, 20/min per end-user IP", async () => {
  const ok = async () => Response.json({ ok: true });
  const tokenKey = "token:00000000-0000-4000-8000-000000000001";
  const atLimit = fakeGateway({ counts: { [tokenKey]: 119 }, fetch: ok });
  assert.equal((await handleGateway(gatewayRequest("responses", spark(), JSON_CT), ["responses"], atLimit.deps)).status, 200);
  const over = await handleGateway(gatewayRequest("responses", spark(), JSON_CT), ["responses"], atLimit.deps);
  assert.equal(over.status, 429);
  assert.equal((await errorOf(over)).code, "rate_limited");
  assert.ok(Number(over.headers.get("retry-after")) >= 1);

  const ipKey = "ip:00000000-0000-4000-8000-000000000002:203.0.113.7";
  const perIp = fakeGateway({ counts: { [ipKey]: 20 }, fetch: ok });
  const headers = { ...JSON_CT, "x-musemuse-client-ip": "203.0.113.7" };
  const res = await handleGateway(gatewayRequest("responses", spark(), headers), ["responses"], perIp.deps);
  assert.equal(res.status, 429);
  assert.match((await errorOf(res)).message, /this user/);
  assert.deepEqual(perIp.rateKeys[0], [tokenKey, ipKey]);

  const noIp = fakeGateway({ fetch: ok });
  await handleGateway(gatewayRequest("responses", spark(), JSON_CT), ["responses"], noIp.deps);
  assert.deepEqual(noIp.rateKeys[0], [tokenKey]);
});

test("bodies over 4.5 MB -> 413 pointing at /uploads", async () => {
  const g = fakeGateway();
  const big = new Uint8Array(4.5 * 1024 * 1024 + 1);
  const res = await handleGateway(gatewayRequest("files", big, { "content-type": "application/octet-stream" }), ["files"], g.deps);
  const err = await errorOf(res);
  assert.equal(err.status, 413);
  assert.match(err.message, /https:\/\/platform\.example\/api\/gateway\/uploads/);
});

test("forward: master key and content type preserved; a Responses body arrives with its safety id, and is metered", async () => {
  const reply = {
    id: "resp_1",
    model: "muse-wonder-1.0",
    output_text: "hello",
    usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5 },
  };
  const g = fakeGateway({
    token: { allowedModels: ["muse-wonder-1.0"] },
    fetch: async () => new Response(JSON.stringify(reply), { headers: { "content-type": "application/json", "x-request-id": "r1" } }),
  });
  const sent = json({ model: "muse-wonder-1.0", input: "hi", note: "ünïcode ✓" });
  const res = await handleGateway(gatewayRequest("responses", sent, JSON_CT), ["responses"], g.deps);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-request-id"), "r1");
  assert.deepEqual(await res.json(), reply);
  await g.settled();

  const call = g.upstreamCalls[0];
  assert.equal(call.url, "https://api.meta.ai/v1/responses");
  const headers = call.init?.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer test-master-key");
  assert.equal(headers["content-type"], "application/json");
  const upstreamBody = JSON.parse(new TextDecoder().decode(call.init?.body as Uint8Array)) as Record<string, unknown>;
  assert.match(String(upstreamBody.safety_identifier), /^p_[0-9a-f]{40}$/);
  delete upstreamBody.safety_identifier;
  assert.equal(JSON.stringify(upstreamBody), sent, "everything else is unchanged, in order");
  assert.ok(!JSON.stringify(headers).includes(TEST_TOKEN), "the product token never goes upstream");

  assert.equal(g.usage.length, 1);
  assert.equal(g.usage[0].ctx.source, "gateway");
  assert.equal(g.usage[0].ctx.endpoint, "responses");
  assert.equal(g.usage[0].items[0].inputTokens, 10);
});

test("raw bytes are preserved unless the gateway rewrites them: other endpoints go through untouched", async () => {
  const g = fakeGateway({ fetch: async () => Response.json({ created: 1, data: [{ b64_json: "A" }] }) });
  const sent = `{ "model": "muse-image-1.0",  "prompt": "ünïcode ✓" }`;
  const res = await handleGateway(gatewayRequest("images/generations", sent, JSON_CT), ["images", "generations"], g.deps);
  assert.equal(res.headers.get("x-musemuse-note"), null);
  assert.equal(new TextDecoder().decode(g.upstreamCalls[0].init?.body as Uint8Array), sent);
});

test("a product that asks for Muse Spark 1.3 is served and metered as Spark 1.3 Contributor", async () => {
  const reply = {
    id: "resp_2",
    model: "muse-spark-1.3-contributor",
    output_text: "hello",
    usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 500 },
  };
  const g = fakeGateway({ fetch: async () => new Response(JSON.stringify(reply), { headers: { "content-type": "application/json" } }) });
  const res = await handleGateway(gatewayRequest("responses", spark({ note: "ünïcode ✓" }), JSON_CT), ["responses"], g.deps);
  assert.equal(res.status, 200);
  await g.settled();

  const upstream = JSON.parse(new TextDecoder().decode(g.upstreamCalls[0].init?.body as Uint8Array)) as Record<string, unknown>;
  assert.match(String(upstream.safety_identifier), /^p_/);
  delete upstream.safety_identifier;
  assert.deepEqual(upstream, { model: "muse-spark-1.3-contributor", input: "hi", note: "ünïcode ✓" });
  assert.equal(g.usage.length, 1);
  assert.equal(g.usage[0].items[0].model, "muse-spark-1.3-contributor");
  // Contributor prices: $0.10 per million input and $0.20 per million output.
  assert.ok(Math.abs(g.usage[0].items[0].costUsd - (1000 * 0.1 + 500 * 0.2) / 1e6) < 1e-9, String(g.usage[0].items[0].costUsd));
});

test("upstream errors pass through unchanged and unmetered", async () => {
  const g = fakeGateway({
    fetch: async () =>
      Response.json({ error: { type: "invalid_request_error", message: "bad" } }, { status: 400 }),
  });
  const res = await handleGateway(gatewayRequest("responses", spark(), JSON_CT), ["responses"], g.deps);
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { error: { message: string } }).error.message, "bad");
  await g.settled();
  assert.equal(g.usage.length, 0);
});

test("upstream unreachable -> 502", async () => {
  const g = fakeGateway({
    fetch: async () => {
      throw new TypeError("fetch failed");
    },
  });
  const res = await handleGateway(gatewayRequest("responses", spark(), JSON_CT), ["responses"], g.deps);
  assert.equal(res.status, 502);
});

test("images/generations is metered per returned image", async () => {
  const g = fakeGateway({
    fetch: async () => Response.json({ created: 1, data: [{ b64_json: "AAA" }, { b64_json: "BBB" }] }),
  });
  const res = await handleGateway(
    gatewayRequest("images/generations", json({ model: "muse-image-1.0", prompt: "a cat", n: 2 }), JSON_CT),
    ["images", "generations"],
    g.deps,
  );
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  await g.settled();
  assert.equal(g.usage[0].items[0].images, 2);
  assert.ok(Math.abs(g.usage[0].items[0].costUsd - 0.02) < 1e-12);
});

test("metering still completes when the product stops reading the stream", async () => {
  const sse =
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n' +
    'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":3}}}\n\n';
  const g = fakeGateway({ fetch: async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }) });
  const res = await handleGateway(gatewayRequest("responses", spark({ stream: true }), JSON_CT), ["responses"], g.deps);
  assert.equal(res.headers.get("cache-control"), "no-cache, no-transform");
  await res.body?.cancel();
  await g.settled();
  assert.equal(g.usage[0].items[0].inputTokens, 7);
});

test("asr JSON extension: audioUrl must be https on public Vercel Blob", async () => {
  assert.ok(checkAudioUrl("https://abc.public.blob.vercel-storage.com/uploads/a.wav"));
  for (const bad of [
    "http://abc.public.blob.vercel-storage.com/a.wav",
    "https://evil.com/a.wav",
    "https://public.blob.vercel-storage.com/a.wav",
    "https://abc.public.blob.vercel-storage.com.evil.com/a.wav",
    "https://user:pw@abc.public.blob.vercel-storage.com/a.wav",
    "https://abc.public.blob.vercel-storage.com:8443/a.wav",
    "file:///etc/passwd",
    42,
  ]) {
    assert.throws(() => checkAudioUrl(bad), AsrInputError, String(bad));
  }
  const g = fakeGateway();
  const res = await handleGateway(
    gatewayRequest("asr/transcribe", json({ model: "muse-voice-transcribe-1.0", audioUrl: "https://169.254.169.254/x" }), JSON_CT),
    ["asr", "transcribe"],
    g.deps,
  );
  assert.equal(res.status, 400);
  assert.equal((await errorOf(res)).code, "invalid_audio_url");
  assert.equal(g.upstreamCalls.length, 0);
});

test("asr JSON extension: oversized audio -> 413, non-WAV -> 400", async () => {
  const blobUrl = "https://abc.public.blob.vercel-storage.com/uploads/a.wav";
  const big = fakeGateway({
    fetch: async (input) =>
      String(input) === blobUrl
        ? new Response("x", { headers: { "content-length": String(61 * 1024 * 1024) } })
        : new Response("no", { status: 599 }),
  });
  const r1 = await handleGateway(
    gatewayRequest("asr/transcribe", json({ model: "muse-voice-transcribe-1.0", audioUrl: blobUrl }), JSON_CT),
    ["asr", "transcribe"],
    big.deps,
  );
  assert.equal(r1.status, 413);

  const mp3 = fakeGateway({ fetch: async () => new Response(new Uint8Array(1000).fill(7)) });
  const r2 = await handleGateway(
    gatewayRequest("asr/transcribe", json({ model: "muse-voice-transcribe-1.0", audioUrl: blobUrl }), JSON_CT),
    ["asr", "transcribe"],
    mp3.deps,
  );
  assert.equal((await errorOf(r2)).code, "invalid_audio");
});

/** An upstream whose replies wait until `open()` is called. */
function gatedUpstream(reply: () => Response = () => Response.json({ usage: { input_tokens: 10, output_tokens: 5 } })) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { open: () => open(), fetch: (async () => (await gate, reply())) as typeof fetch };
}

const TOKEN_ID = "00000000-0000-4000-8000-000000000001";
const SLOT_KEY = `inflight:${TOKEN_ID}`;

test("in-flight cap: at most 4 calls per token run at once, and slots come back after metering", async () => {
  const upstream = gatedUpstream();
  const g = fakeGateway({ fetch: upstream.fetch });
  const calls = Array.from({ length: 6 }, () =>
    handleGateway(gatewayRequest("responses", spark(), JSON_CT), ["responses"], g.deps),
  );
  // Let every request reach the upstream call or its rejection before the upstream answers.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(g.upstreamCalls.length, 4);
  assert.equal(g.inFlight.get(SLOT_KEY), 4);
  assert.equal(g.reservations.size, 4, "each running call holds a reservation");
  upstream.open();
  const results = await Promise.all(calls);
  const rejected = results.filter((r) => r.status === 429);
  assert.equal(rejected.length, 2);
  assert.equal((await errorOf(rejected[0])).code, "too_many_in_flight");
  assert.ok(Number(rejected[0].headers.get("retry-after")) >= 1);
  assert.equal(rejected[0].headers.get("x-should-retry"), null, "the SDK may retry");
  await Promise.all(results.filter((r) => r.status === 200).map((r) => r.arrayBuffer()));
  await g.settled();
  assert.equal(g.inFlight.get(SLOT_KEY), 0);
  assert.equal(g.reservations.size, 0);
  assert.equal(g.usage.length, 4);
});

test("budget: running calls' estimates count, so a burst can't overshoot before metering", async () => {
  const upstream = gatedUpstream();
  // Wonder with no max_output_tokens is estimated at 8,000 output tokens x $20/M = $0.16.
  const g = fakeGateway({
    token: { allowedModels: ["muse-wonder-1.0"], dailyBudgetUsd: 0.3 },
    fetch: upstream.fetch,
  });
  const wonder = () => gatewayRequest("responses", spark({ model: "muse-wonder-1.0" }), JSON_CT);
  const first = handleGateway(wonder(), ["responses"], g.deps);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const [reservation] = [...g.reservations.values()];
  assert.ok(reservation.costUsd >= 0.16 && reservation.costUsd < 0.17, String(reservation.costUsd));

  const second = await handleGateway(wonder(), ["responses"], g.deps);
  const err = await errorOf(second);
  assert.equal(err.status, 429);
  assert.equal(err.code, "budget_exceeded");
  assert.match(err.message, /estimated at \$0\.16, more than the \$0\.14 left/);
  assert.equal(g.upstreamCalls.length, 1);
  assert.equal(g.inFlight.get(SLOT_KEY), 1, "the rejected call gave its slot back");

  upstream.open();
  await (await first).arrayBuffer();
  await g.settled();
  assert.equal(g.reservations.size, 0);
  assert.equal(g.usage[0].items[0].inputTokens, 10, "the metered usage replaced the estimate");
  assert.equal((await handleGateway(wonder(), ["responses"], g.deps)).status, 200, "real cost was lower");
});

test("platform cap counts this call's estimate too", async () => {
  const g = fakeGateway({ platformSpend: 39.99, token: { allowedModels: ["muse-wonder-1.0"] }, fetch: async () => Response.json({}) });
  const wonder = json({ model: "muse-wonder-1.0", input: "hi" });
  const res = await handleGateway(gatewayRequest("responses", wonder, JSON_CT), ["responses"], g.deps);
  assert.equal((await errorOf(res)).code, "platform_paused");
  assert.equal(g.upstreamCalls.length, 0);
});

test("failed calls drop their reservation and slot", async () => {
  const bad = fakeGateway({ fetch: async () => Response.json({ error: { message: "bad" } }, { status: 400 }) });
  await (await handleGateway(gatewayRequest("responses", spark(), JSON_CT), ["responses"], bad.deps)).arrayBuffer();
  const down = fakeGateway({
    fetch: async () => {
      throw new TypeError("fetch failed");
    },
  });
  await handleGateway(gatewayRequest("responses", spark(), JSON_CT), ["responses"], down.deps);
  const asr = fakeGateway();
  await handleGateway(
    gatewayRequest("asr/transcribe", json({ model: "muse-voice-transcribe-1.0", audioUrl: "https://evil.com/a.wav" }), JSON_CT),
    ["asr", "transcribe"],
    asr.deps,
  );
  const broken = fakeGateway();
  broken.deps.reserveSpend = async () => {
    throw new Error("db down");
  };
  assert.equal((await handleGateway(gatewayRequest("responses", spark(), JSON_CT), ["responses"], broken.deps)).status, 500);
  for (const g of [bad, down, asr, broken]) {
    await g.settled();
    assert.equal(g.reservations.size, 0);
    assert.equal(g.usage.length, 0);
    assert.equal(g.inFlight.get(SLOT_KEY), 0);
  }
});

test("a stream cut off mid-way is still metered, with an estimate when no usage arrived", async () => {
  const g = fakeGateway({
    fetch: async () => {
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) return controller.error(new DOMException("timed out", "TimeoutError"));
          sent = true;
          controller.enqueue(new TextEncoder().encode('event: response.output_text.delta\ndata: {"delta":"hello"}\n\n'));
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
  const res = await handleGateway(gatewayRequest("responses", spark({ stream: true }), JSON_CT), ["responses"], g.deps);
  await res.arrayBuffer().catch(() => {});
  await g.settled();
  assert.equal(g.reservations.size, 0);
  assert.equal(g.usage.length, 1);
  assert.equal(g.usage[0].items[0].inputTokens, 1000);
  assert.ok(g.usage[0].items[0].costUsd > 0, "spend is never invisible");
  assert.equal(g.inFlight.get(SLOT_KEY), 0);
});

test("x-musemuse-client-ip: first forwarded entry, IPv6 by /64, junk ignored; never auth", async () => {
  const ok = async () => Response.json({ ok: true });
  const product = "00000000-0000-4000-8000-000000000002";
  const cases: Array<[string, string | null]> = [
    ["203.0.113.7, 10.0.0.1", `ip:${product}:203.0.113.7`],
    ["2001:db8:1:2:aaaa::1", `ip:${product}:2001:db8:1:2::/64`],
    ["2001:db8::9", `ip:${product}:2001:db8:0:0::/64`],
    ["::ffff:198.51.100.4", `ip:${product}:198.51.100.4`],
    ["not-an-ip", null],
    ["1.2.3.4.5", null],
  ];
  for (const [header, key] of cases) {
    const g = fakeGateway({ fetch: ok });
    await handleGateway(gatewayRequest("responses", spark(), { ...JSON_CT, "x-musemuse-client-ip": header }), ["responses"], g.deps);
    assert.deepEqual(g.rateKeys[0], [`token:${TOKEN_ID}`, ...(key ? [key] : [])], header);
  }
  const g = fakeGateway({ fetch: ok });
  const noToken = await handleGateway(
    new Request("https://p/api/gateway/v1/responses", {
      method: "POST",
      body: spark(),
      headers: { ...JSON_CT, "x-musemuse-client-ip": "203.0.113.7" },
    }),
    ["responses"],
    g.deps,
  );
  assert.equal(noToken.status, 401);
});

const wonderToken = { allowedModels: ["muse-wonder-1.0"] };
const agentToken = { allowedModels: ["muse-wonder-1.0", "agent"] };
const wonder = (extra: Record<string, unknown> = {}) => json({ model: "muse-wonder-1.0", input: "hi", max_output_tokens: 100, ...extra });
const search = [{ type: "web_search" }];
const upstreamJson = (g: ReturnType<typeof fakeGateway>, i = 0) =>
  JSON.parse(new TextDecoder().decode(g.upstreamCalls[i].init?.body as Uint8Array)) as Record<string, unknown>;
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
const tokensUsd = (input: number, output: number) => (input * 4 + output * 20) / 1e6;
const SEARCH_USD = 0.0025;
const usageReply = { usage: { input_tokens: 100, output_tokens: 10 } };
const searched = (ids: string[]) => ({
  ...usageReply,
  output: [...ids.map((id) => ({ id, type: "web_search_call", status: "completed" })), { type: "message", content: [] }],
});

test("web_search: a JSON reply pays its search fee on top of tokens, with the searches as units", async () => {
  const g = fakeGateway({ token: wonderToken, fetch: async () => Response.json(searched(["ws_1", "ws_2"])) });
  const res = await handleGateway(gatewayRequest("responses", wonder({ tools: search }), JSON_CT), ["responses"], g.deps);
  assert.equal(res.status, 200, "web_search stays allowed for a product without the agent marker");
  await res.arrayBuffer();
  await g.settled();
  const [item] = g.usage[0].items;
  near(item.costUsd, tokensUsd(100, 10) + 2 * SEARCH_USD);
  assert.equal(item.units, 2);
});

test("web_search: an SSE reply pays its search fee too", async () => {
  const sse =
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"id":"ws_1","type":"web_search_call"}}\n\n' +
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: searched(["ws_1"]) })}\n\n`;
  const g = fakeGateway({ token: wonderToken, fetch: async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }) });
  const res = await handleGateway(gatewayRequest("responses", wonder({ tools: search, stream: true }), JSON_CT), ["responses"], g.deps);
  await res.arrayBuffer();
  await g.settled();
  near(g.usage[0].items[0].costUsd, tokensUsd(100, 10) + SEARCH_USD);
  assert.equal(g.usage[0].items[0].units, 1);
});

test("web_search: the estimate holds the searches a token may run", async () => {
  const upstream = gatedUpstream();
  const g = fakeGateway({ token: wonderToken, fetch: upstream.fetch });
  const body = wonder({ tools: search });
  const running = handleGateway(gatewayRequest("responses", body, JSON_CT), ["responses"], g.deps);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const [reservation] = [...g.reservations.values()];
  // Five searches, each with its fee and 8,000 tokens of results, on top of the 100 output tokens.
  assert.ok(reservation.costUsd >= 5 * SEARCH_USD + tokensUsd(40_000, 100), String(reservation.costUsd));
  assert.ok(reservation.costUsd < 5 * SEARCH_USD + tokensUsd(40_100, 100), String(reservation.costUsd));
  upstream.open();
  await (await running).arrayBuffer();
  await g.settled();
});

test("the clamp per scope: 2 for builds, 5 for live, 8 for live agents, said in the note header", async () => {
  const cases = [
    [{ scope: "build" as const, ...wonderToken }, 2],
    [{ scope: "build" as const, ...agentToken }, 2],
    [{ scope: "live" as const, ...wonderToken }, 5],
    [{ scope: "live" as const, ...agentToken }, 8],
  ] as const;
  for (const [token, cap] of cases) {
    const g = fakeGateway({ token, fetch: async () => Response.json(usageReply) });
    const res = await handleGateway(gatewayRequest("responses", wonder({ tools: search, max_tool_calls: 99 }), JSON_CT), ["responses"], g.deps);
    assert.equal(upstreamJson(g).max_tool_calls, cap);
    assert.match(res.headers.get("x-musemuse-note") ?? "", new RegExp(`Set max_tool_calls to ${cap} \\(it was 99\\)`));
  }
});

test("no note header when nothing the product needs to know changed", async () => {
  const g = fakeGateway({ token: wonderToken, fetch: async () => Response.json(usageReply) });
  const res = await handleGateway(gatewayRequest("responses", wonder(), JSON_CT), ["responses"], g.deps);
  assert.equal(res.headers.get("x-musemuse-note"), null);
});

test("background: true -> 400 background_unsupported for build and live, before anything is held or forwarded", async () => {
  for (const scope of ["build", "live"] as const) {
    const g = fakeGateway({ token: { ...wonderToken, scope } });
    const res = await handleGateway(gatewayRequest("responses", wonder({ background: true }), JSON_CT), ["responses"], g.deps);
    const err = await errorOf(res);
    assert.equal(err.status, 400);
    assert.equal(err.code, "background_unsupported");
    assert.match(err.message, /Stream it with stream: true instead/);
    assert.equal(res.headers.get("x-should-retry"), "false");
    assert.equal(g.upstreamCalls.length, 0);
    assert.equal(g.reservations.size, 0);
    assert.equal(g.rateKeys.length, 0);
  }
});

test("agent tokens never run on Contributor, even when they ask for Muse Spark 1.3", async () => {
  const g = fakeGateway({ token: { allowedModels: ["muse-spark-1.3", "agent"] } });
  const err = await errorOf(await handleGateway(gatewayRequest("responses", spark(), JSON_CT), ["responses"], g.deps));
  assert.equal(err.status, 400);
  assert.equal(err.code, "model_not_for_agents");
  assert.equal(g.upstreamCalls.length, 0);
});

test("the agent marker is never a model anyone can call", async () => {
  const g = fakeGateway({ token: agentToken });
  const err = await errorOf(await handleGateway(gatewayRequest("responses", json({ model: "agent", input: "hi" }), JSON_CT), ["responses"], g.deps));
  assert.equal(err.code, "model_not_found");
  assert.doesNotMatch(err.message, /Allowed:.*agent/);
});

test("safety_identifier: a visitor header wins over the client IP, and each is hashed with the product", async () => {
  const send = async (headers: Record<string, string>, body = wonder()) => {
    const g = fakeGateway({ token: wonderToken, fetch: async () => Response.json(usageReply) });
    await handleGateway(gatewayRequest("responses", body, { ...JSON_CT, ...headers }), ["responses"], g.deps);
    return upstreamJson(g).safety_identifier as string;
  };
  const anon = await send({});
  const ip = await send({ "x-musemuse-client-ip": "203.0.113.7" });
  const visitor = await send({ "x-musemuse-client-ip": "203.0.113.7", "x-musemuse-visitor": "vid_1" });
  const own = await send({ "x-musemuse-visitor": "vid_1" }, wonder({ safety_identifier: "own" }));
  assert.equal(new Set([anon, ip, visitor, own]).size, 4);
  assert.equal(await send({ "x-musemuse-visitor": "vid_1" }), visitor, "stable for one person");
  for (const id of [anon, ip, visitor, own]) {
    assert.match(id, /^p_[0-9a-f]{40}$/);
    assert.ok(!id.includes("vid_1") && !id.includes("203.0.113.7"));
  }
});

test("agent tokens get 8 calls in flight; other tokens stay at 4", async () => {
  const upstream = gatedUpstream();
  const g = fakeGateway({ token: agentToken, fetch: upstream.fetch });
  const calls = Array.from({ length: 10 }, () => handleGateway(gatewayRequest("responses", wonder(), JSON_CT), ["responses"], g.deps));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(g.upstreamCalls.length, 8);
  upstream.open();
  const results = await Promise.all(calls);
  const rejected = results.filter((r) => r.status === 429);
  assert.equal(rejected.length, 2);
  assert.match((await errorOf(rejected[0])).message, /already has 8 Meta calls running/);
  await Promise.all(results.filter((r) => r.status === 200).map((r) => r.arrayBuffer()));
  await g.settled();
});

const RUN = "run_12345678";
const runKeys = {
  turns: `run-turns:${TOKEN_ID}:${RUN}`,
  calls: `run-calls:${TOKEN_ID}:${RUN}`,
  usd: `run-usd:${TOKEN_ID}:${RUN}`,
};
const inRun = { ...JSON_CT, "x-musemuse-run-id": RUN };

test("run caps: a build's seventh model turn -> 429 run_limit, in plain words", async () => {
  const g = fakeGateway({ token: { ...wonderToken, scope: "build" }, fetch: async () => Response.json(usageReply) });
  for (let i = 0; i < 6; i++) {
    const res = await handleGateway(gatewayRequest("responses", wonder(), inRun), ["responses"], g.deps);
    assert.equal(res.status, 200, `turn ${i + 1}`);
    await res.arrayBuffer();
    await g.settled();
  }
  const over = await handleGateway(gatewayRequest("responses", wonder(), inRun), ["responses"], g.deps);
  const err = await errorOf(over);
  assert.equal(err.status, 429);
  assert.equal(err.code, "run_limit");
  assert.match(err.message, /limit of 6 model turns/);
  assert.equal(over.headers.get("x-should-retry"), "false");
  assert.equal(g.upstreamCalls.length, 6);
  assert.equal(g.inFlight.get(SLOT_KEY), 0, "the refused call gave its slot back");
});

test("run caps: a live agent runs 10 turns; a different run starts fresh", async () => {
  const g = fakeGateway({ token: agentToken, fetch: async () => Response.json(usageReply) });
  for (let i = 0; i < 10; i++) {
    const res = await handleGateway(gatewayRequest("responses", wonder(), inRun), ["responses"], g.deps);
    assert.equal(res.status, 200, `turn ${i + 1}`);
    await res.arrayBuffer();
    await g.settled();
  }
  assert.equal((await errorOf(await handleGateway(gatewayRequest("responses", wonder(), inRun), ["responses"], g.deps))).code, "run_limit");
  const other = { ...JSON_CT, "x-musemuse-run-id": "run_other_1" };
  assert.equal((await handleGateway(gatewayRequest("responses", wonder(), other), ["responses"], g.deps)).status, 200);
});

test("run caps: today's live tokens and calls without a run id have none", async () => {
  const live = fakeGateway({ token: wonderToken, fetch: async () => Response.json(usageReply) });
  for (let i = 0; i < 12; i++) {
    const res = await handleGateway(gatewayRequest("responses", wonder(), inRun), ["responses"], live.deps);
    assert.equal(res.status, 200, `turn ${i + 1}`);
    await res.arrayBuffer();
    await live.settled();
  }
  assert.equal(live.counters.size, 0);
  const malformed = await handleGateway(gatewayRequest("responses", wonder(), { ...JSON_CT, "x-musemuse-run-id": "no" }), ["responses"], live.deps);
  assert.equal(malformed.status, 200, "a header it doesn't use can't break a live product");

  const build = fakeGateway({ token: { ...wonderToken, scope: "build" }, fetch: async () => Response.json(usageReply) });
  await handleGateway(gatewayRequest("responses", wonder(), JSON_CT), ["responses"], build.deps);
  assert.equal(build.counters.size, 0);
});

test("run caps: a malformed run id on a token with caps -> 400 invalid_run_id", async () => {
  const g = fakeGateway({ token: { ...wonderToken, scope: "build" } });
  const err = await errorOf(await handleGateway(gatewayRequest("responses", wonder(), { ...JSON_CT, "x-musemuse-run-id": "no" }), ["responses"], g.deps));
  assert.equal(err.status, 400);
  assert.equal(err.code, "invalid_run_id");
  assert.equal(g.upstreamCalls.length, 0);
});

test("run caps: the hold settles to what the call used, once it is metered", async () => {
  const g = fakeGateway({ token: agentToken, fetch: async () => Response.json(searched(["ws_1"])) });
  const res = await handleGateway(gatewayRequest("responses", wonder({ tools: search }), inRun), ["responses"], g.deps);
  await res.arrayBuffer();
  await g.settled();
  assert.equal(g.counters.get(runKeys.turns), 1);
  assert.equal(g.counters.get(runKeys.calls), 1, "held 8, ran 1");
  assert.equal(g.counters.get(runKeys.usd), Math.ceil((tokensUsd(100, 10) + SEARCH_USD) * 1e6));
});

test("run caps: when few tool calls are left, max_tool_calls comes down and the note says why", async () => {
  const g = fakeGateway({ token: { ...wonderToken, scope: "build" }, fetch: async () => Response.json(searched(["ws_1", "ws_2"])) });
  for (let i = 0; i < 3; i++) {
    const res = await handleGateway(gatewayRequest("responses", wonder({ tools: search }), inRun), ["responses"], g.deps);
    assert.equal(res.status, 200);
    await res.arrayBuffer();
    await g.settled();
  }
  assert.equal(g.counters.get(runKeys.calls), 6);
  const oneLeft = fakeGateway({ token: { ...wonderToken, scope: "build" }, fetch: async () => Response.json(searched(["ws_1"])) });
  oneLeft.counters.set(runKeys.calls, 7);
  const low = await handleGateway(gatewayRequest("responses", wonder({ tools: search }), inRun), ["responses"], oneLeft.deps);
  assert.equal(upstreamJson(oneLeft).max_tool_calls, 1);
  assert.match(low.headers.get("x-musemuse-note") ?? "", /Lowered max_tool_calls to 1: that is all this run has room for/);

  const spent = fakeGateway({ token: { ...wonderToken, scope: "build" }, fetch: async () => Response.json(usageReply) });
  spent.counters.set(runKeys.calls, 8);
  const err = await errorOf(await handleGateway(gatewayRequest("responses", wonder({ tools: search }), inRun), ["responses"], spent.deps));
  assert.equal(err.code, "run_limit");
  assert.equal(spent.upstreamCalls.length, 0);
  assert.equal(spent.counters.get(runKeys.turns), 0, "the refused call's turn came back");
  assert.equal((await handleGateway(gatewayRequest("responses", wonder(), inRun), ["responses"], spent.deps)).status, 200, "a turn without built-in tools can finish the run");
});

test("run caps: the dollars held count only the tool calls the run has left", async () => {
  const g = fakeGateway({ token: agentToken, fetch: async () => Response.json(searched(["ws_1"])) });
  g.counters.set(runKeys.calls, 11);
  g.counters.set(runKeys.usd, 650_000);
  const res = await handleGateway(gatewayRequest("responses", wonder({ tools: search }), inRun), ["responses"], g.deps);
  assert.equal(res.status, 200, "eight searches wouldn't fit in the $0.10 left, and the one left does");
  assert.equal(upstreamJson(g).max_tool_calls, 1);
  assert.ok(g.counters.get(runKeys.usd)! < 750_000);
});

test("run caps: when the dollars don't cover every search, the call runs with fewer", async () => {
  // A live agent's default turn on the template: 2,500 output tokens, chained, and no max_tool_calls of its own.
  const body = () => wonder({ input: "go on", tools: search, max_output_tokens: 2_500, previous_response_id: "resp_1" });
  let callsHeld = 0;
  const g = fakeGateway({
    token: agentToken,
    fetch: async () => {
      callsHeld = g.counters.get(runKeys.calls)!;
      return Response.json(searched(["ws_1"]));
    },
  });
  g.counters.set(runKeys.turns, 4);
  g.counters.set(runKeys.calls, 3);
  g.counters.set(runKeys.usd, 400_000);
  const res = await handleGateway(gatewayRequest("responses", body(), inRun), ["responses"], g.deps);
  assert.equal(res.status, 200);
  const lowered = upstreamJson(g).max_tool_calls as number;
  assert.ok(lowered >= 1 && lowered < 8, `max_tool_calls ${lowered}`);
  assert.equal(callsHeld, 3 + lowered, "the calls it can't pay for went back before Meta ran");
  assert.ok(g.counters.get(runKeys.usd)! <= 750_000);
  assert.match(res.headers.get("x-musemuse-note") ?? "", new RegExp(`Lowered max_tool_calls to ${lowered}: that is all this run has room for`));
  await res.arrayBuffer();
  await g.settled();
  assert.equal(g.counters.get(runKeys.calls), 4, "settled to the one search it ran");

  const broke = fakeGateway({ token: agentToken, fetch: async () => Response.json(usageReply) });
  broke.counters.set(runKeys.usd, 749_000);
  const err = await errorOf(await handleGateway(gatewayRequest("responses", body(), inRun), ["responses"], broke.deps));
  assert.equal(err.code, "run_limit");
  assert.match(err.message, /\$0\.75 limit/);
  assert.equal(broke.upstreamCalls.length, 0);
  assert.equal(broke.counters.get(runKeys.calls), 0, "the refused call's calls came back");
});

test("run caps: a third call in parallel is told its tool calls are held, not used", async () => {
  let finish = () => {};
  const open = new Promise<void>((resolve) => (finish = resolve));
  const g = fakeGateway({
    token: agentToken,
    fetch: async () => {
      await open;
      return Response.json(usageReply);
    },
  });
  const send = () => handleGateway(gatewayRequest("responses", wonder({ tools: search, max_output_tokens: 300 }), inRun), ["responses"], g.deps);
  const first = send();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = send();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(g.counters.get(runKeys.calls), 12, "the first holds 8 and the second holds 4");
  const err = await errorOf(await send());
  assert.equal(err.code, "run_limit");
  assert.match(err.message, /none of its 12 built-in tool calls left, counting calls still running/);
  assert.match(err.message, /Wait for them to finish/);
  finish();
  const replies = await Promise.all([first, second]);
  for (const res of replies) await res.arrayBuffer();
  await g.settled();
  assert.equal(g.counters.get(runKeys.calls), 0, "settling gave the unused calls back");
});

test("run caps: a call estimated past the run's dollars -> 429 run_limit before the budget check", async () => {
  const g = fakeGateway({ token: { ...wonderToken, scope: "build" }, fetch: async () => Response.json(usageReply) });
  const err = await errorOf(await handleGateway(gatewayRequest("responses", wonder({ max_output_tokens: 32_000 }), inRun), ["responses"], g.deps));
  assert.equal(err.status, 429);
  assert.equal(err.code, "run_limit");
  assert.match(err.message, /\$0\.40 limit/);
  assert.equal(g.reservations.size, 0);
  assert.equal(g.upstreamCalls.length, 0);
});

test("run caps: calls Meta never ran or never billed give the whole hold back", async () => {
  const failures: Array<[string, Parameters<typeof fakeGateway>[0]]> = [
    ["an upstream error", { fetch: async () => Response.json({ error: { message: "bad" } }, { status: 400 }) }],
    ["upstream unreachable", { fetch: async () => { throw new TypeError("fetch failed"); } }],
    ["the token's budget", { tokenSpend: 3 }],
    ["the platform cap", { platformSpend: 40 }],
  ];
  for (const [what, opts] of failures) {
    const g = fakeGateway({ token: { ...wonderToken, scope: "build" }, ...opts });
    await (await handleGateway(gatewayRequest("responses", wonder({ tools: search }), inRun), ["responses"], g.deps)).arrayBuffer();
    await g.settled();
    for (const key of Object.values(runKeys)) assert.equal(g.counters.get(key), 0, `${what}: ${key}`);
    assert.equal(g.inFlight.get(SLOT_KEY), 0, what);
    assert.equal(g.reservations.size, 0, what);
  }
});

test("run caps: a stream cut off keeps the tool calls it held", async () => {
  const g = fakeGateway({
    token: { ...wonderToken, scope: "build" },
    fetch: async () => new Response('event: response.output_text.delta\ndata: {"delta":"hello"}\n\n', { headers: { "content-type": "text/event-stream" } }),
  });
  const res = await handleGateway(gatewayRequest("responses", wonder({ tools: search, stream: true }), inRun), ["responses"], g.deps);
  await res.arrayBuffer();
  await g.settled();
  assert.equal(g.counters.get(runKeys.calls), 2);
  assert.equal(g.counters.get(runKeys.turns), 1);
});

test("run caps count image calls as turns, and never the files endpoint", async () => {
  const g = fakeGateway({ token: { scope: "build", allowedModels: ["muse-image-1.0"] }, fetch: async () => Response.json({ created: 1, data: [{ b64_json: "A" }] }) });
  const res = await handleGateway(gatewayRequest("images/generations", json({ model: "muse-image-1.0", prompt: "cat" }), inRun), ["images", "generations"], g.deps);
  await res.arrayBuffer();
  await g.settled();
  assert.equal(g.counters.get(runKeys.turns), 1);
  assert.equal(g.counters.get(runKeys.usd), 10_000);

  const files = fakeGateway({ token: { scope: "build" }, fetch: async () => Response.json({ id: "file-1" }) });
  const uploaded = await handleGateway(gatewayRequest("files", new Uint8Array(4), { "content-type": "application/octet-stream", "x-musemuse-run-id": "no" }), ["files"], files.deps);
  assert.equal(uploaded.status, 200);
  assert.equal(files.counters.size, 0);
});

test("/v1/responses refuses a multipart body, since its guards read JSON", async () => {
  const send = (form: FormData, path: string[], g: ReturnType<typeof fakeGateway>) =>
    handleGateway(
      new Request(`https://p/api/gateway/v1/${path.join("/")}`, { method: "POST", headers: { authorization: `Bearer ${TEST_TOKEN}` }, body: form }),
      path,
      g.deps,
    );
  const form = new FormData();
  form.set("model", "muse-spark-1.3");
  form.set("background", "true");
  form.set("input", "hi");
  for (const token of [{ allowedModels: ["muse-spark-1.3", "agent"] }, { allowedModels: ["muse-spark-1.3"] }]) {
    const g = fakeGateway({ token, fetch: async () => Response.json(usageReply) });
    const res = await send(form, ["responses"], g);
    const err = await errorOf(res);
    assert.equal(err.status, 400);
    assert.equal(err.code, "invalid_body");
    assert.equal(err.message, "/v1/responses takes a JSON body.");
    assert.equal(res.headers.get("x-should-retry"), "false");
    assert.equal(g.upstreamCalls.length, 0);
    assert.equal(g.reservations.size, 0);
  }

  const edit = new FormData();
  edit.set("model", "muse-image-1.0");
  edit.set("prompt", "a cat");
  const g = fakeGateway({ token: { allowedModels: ["muse-image-1.0"] }, fetch: async () => Response.json({ created: 1, data: [{ b64_json: "A" }] }) });
  assert.equal((await send(edit, ["images", "edits"], g)).status, 200, "images/edits still takes multipart");
  assert.equal(g.upstreamCalls.length, 1);
});

const wonderReply = {
  id: "resp_t",
  model: "muse-spark-1.3-contributor",
  output_text: "hello",
  usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 500 },
};
const wonderCall = () => json({ model: "muse-wonder-1.0", input: "hi" });
const replyFetch = async () => new Response(JSON.stringify(wonderReply), { headers: { "content-type": "application/json" } });
const sentModel = (g: ReturnType<typeof fakeGateway>) =>
  (JSON.parse(new TextDecoder().decode(g.upstreamCalls[0].init?.body as Uint8Array)) as { model: string }).model;
const TEST_MODEL_NAME = "muse-spark-1.3-contributor";

test("in a test build, a build token's Muse Wonder call runs and is metered on the test model, and says so", async () => {
  const g = fakeGateway({
    fetch: replyFetch,
    buildTestModel: TEST_MODEL_NAME,
    token: { scope: "build", allowedModels: ["muse-wonder-1.0"] },
  });
  const res = await handleGateway(gatewayRequest("responses", wonderCall(), JSON_CT), ["responses"], g.deps);
  assert.equal(res.status, 200);
  await g.settled();
  assert.equal(sentModel(g), TEST_MODEL_NAME);
  assert.equal(g.usage[0].items[0].model, TEST_MODEL_NAME);
  assert.match(res.headers.get("x-musemuse-note") ?? "", /this is a test build/);
});

test("a live product's Muse Wonder call stays on Muse Wonder when the test model is set", async () => {
  const g = fakeGateway({
    fetch: replyFetch,
    buildTestModel: TEST_MODEL_NAME,
    token: { scope: "live", allowedModels: ["muse-wonder-1.0"] },
  });
  const res = await handleGateway(gatewayRequest("responses", wonderCall(), JSON_CT), ["responses"], g.deps);
  assert.equal(res.status, 200);
  await g.settled();
  assert.equal(sentModel(g), "muse-wonder-1.0");
});

test("BUILDS_ON_CONTRIBUTOR: a live token with the marker runs on Contributor, even as an agent, and says so", async () => {
  const g = fakeGateway({ fetch: replyFetch, contributorRuntime: true, token: { scope: "live", allowedModels: ["muse-wonder-1.0", "agent", "runtime:contributor"] } });
  const res = await handleGateway(gatewayRequest("responses", wonderCall(), JSON_CT), ["responses"], g.deps);
  assert.equal(res.status, 200);
  await g.settled();
  assert.equal(sentModel(g), TEST_MODEL_NAME);
  assert.equal(g.usage[0].items[0].model, TEST_MODEL_NAME);
  assert.match(res.headers.get("x-musemuse-note") ?? "", /builds and products run on it/);
});

test("BUILDS_ON_CONTRIBUTOR: the marker with the flag off stays on Muse Wonder, as today", async () => {
  const g = fakeGateway({ fetch: replyFetch, contributorRuntime: false, token: { scope: "live" as const, allowedModels: ["muse-wonder-1.0", "runtime:contributor"] } });
  const res = await handleGateway(gatewayRequest("responses", wonderCall(), JSON_CT), ["responses"], g.deps);
  assert.equal(res.status, 200);
  await g.settled();
  assert.equal(sentModel(g), "muse-wonder-1.0");
});

test("BUILDS_ON_CONTRIBUTOR: a live token without the marker is refused in plain words, and nothing goes upstream", async () => {
  const g = fakeGateway({ fetch: replyFetch, contributorRuntime: true, token: { scope: "live" as const, allowedModels: ["muse-wonder-1.0"] } });
  const res = await handleGateway(gatewayRequest("responses", wonderCall(), JSON_CT), ["responses"], g.deps);
  assert.equal(res.status, 403);
  assert.match(await res.text(), /off for now/);
  assert.equal(g.upstreamCalls.length, 0);
});

test("BUILDS_ON_CONTRIBUTOR: gadgets and boards stay on Muse Wonder, audio included, and are metered at its price", async () => {
  for (const marker of ["muse-gadget", "board-tools"]) {
    const g = fakeGateway({ fetch: replyFetch, contributorRuntime: true, token: { scope: "live" as const, allowedModels: ["muse-wonder-1.0", marker] } });
    const res = await handleGateway(gatewayRequest("responses", json({ model: "muse-wonder-1.0", input: [{ content: [{ type: "input_audio" }] }] }), JSON_CT), ["responses"], g.deps);
    assert.equal(res.status, 200, marker);
    await g.settled();
    assert.equal(sentModel(g), "muse-wonder-1.0");
    assert.equal(g.usage[0]?.items[0]?.model, "muse-wonder-1.0");
  }
});

test("BUILDS_ON_CONTRIBUTOR: the three demos stay on Muse Wonder by slug, marker or not, and any other slug gets the plain 403", async () => {
  for (const productSlug of ["voice-memo-tasks", "class-capture-notes", "gym-snap-coach"]) {
    for (const allowedModels of [["muse-wonder-1.0"], ["muse-wonder-1.0", "runtime:contributor"]]) {
      const g = fakeGateway({ fetch: replyFetch, contributorRuntime: true, productSlug, token: { scope: "live" as const, allowedModels } });
      const res = await handleGateway(gatewayRequest("responses", wonderCall(), JSON_CT), ["responses"], g.deps);
      assert.equal(res.status, 200, productSlug);
      await g.settled();
      assert.equal(sentModel(g), "muse-wonder-1.0");
    }
  }
  const other = fakeGateway({ fetch: replyFetch, contributorRuntime: true, productSlug: "voice-memo-tasks-2", token: { scope: "live" as const, allowedModels: ["muse-wonder-1.0"] } });
  const refused = await handleGateway(gatewayRequest("responses", wonderCall(), JSON_CT), ["responses"], other.deps);
  assert.equal(refused.status, 403);
  assert.match(await refused.text(), /off for now/);
  assert.equal(other.upstreamCalls.length, 0);
});

test("BUILDS_ON_CONTRIBUTOR: a demo's or gadget's build token runs on Contributor", async () => {
  const g = fakeGateway({ fetch: replyFetch, contributorRuntime: true, buildTestModel: TEST_MODEL_NAME, productSlug: "gym-snap-coach", token: { scope: "build" as const, allowedModels: ["muse-wonder-1.0", "muse-gadget"] } });
  const res = await handleGateway(gatewayRequest("responses", wonderCall(), JSON_CT), ["responses"], g.deps);
  assert.equal(res.status, 200);
  await g.settled();
  assert.equal(sentModel(g), TEST_MODEL_NAME);
});

test("BUILDS_ON_CONTRIBUTOR: TRUST_SPARK_TO_WONDER can't take a live call to Muse Wonder", async () => {
  for (const [allowedModels, status] of [[["muse-spark-1.3", "runtime:contributor"], 200], [["muse-spark-1.3"], 403]] as const) {
    const g = fakeGateway({ fetch: replyFetch, contributorRuntime: true, sparkToWonder: true, token: { scope: "live" as const, allowedModels: [...allowedModels] } });
    const res = await handleGateway(gatewayRequest("responses", json({ model: "muse-spark-1.3", input: "hi" }), JSON_CT), ["responses"], g.deps);
    assert.equal(res.status, status);
    if (status === 200) {
      await g.settled();
      assert.equal(sentModel(g), TEST_MODEL_NAME);
    } else assert.equal(g.upstreamCalls.length, 0);
  }
});

test("BUILDS_ON_CONTRIBUTOR: audio input is refused rather than sent to Muse Wonder", async () => {
  const body = json({ model: "muse-wonder-1.0", input: [{ role: "user", content: [{ type: "input_audio", data: "x" }] }] });
  const g = fakeGateway({ fetch: replyFetch, contributorRuntime: true, token: { scope: "live" as const, allowedModels: ["muse-wonder-1.0", "runtime:contributor"] } });
  const res = await handleGateway(gatewayRequest("responses", body, JSON_CT), ["responses"], g.deps);
  assert.equal(res.status, 403);
  assert.match(await res.text(), /Audio input is off/);
  assert.equal(g.upstreamCalls.length, 0);
});

test("BUILDS_ON_CONTRIBUTOR: a metered key or a session naming Muse Wonder runs on Contributor", async () => {
  const g = fakeGateway({ fetch: replyFetch, contributorRuntime: true, token: { scope: "power_key" as never, allowedModels: ["muse-wonder-1.0"] } });
  const res = await handleGateway(gatewayRequest("responses", wonderCall(), JSON_CT), ["responses"], g.deps);
  assert.equal(res.status, 200);
  await g.settled();
  assert.equal(sentModel(g), TEST_MODEL_NAME);
  assert.equal(g.usage[0].items[0].model, TEST_MODEL_NAME);
});

test("a build token stays on Muse Wonder when no test model is set", async () => {
  const g = fakeGateway({ fetch: replyFetch, token: { scope: "build", allowedModels: ["muse-wonder-1.0"] } });
  const res = await handleGateway(gatewayRequest("responses", wonderCall(), JSON_CT), ["responses"], g.deps);
  assert.equal(res.status, 200);
  await g.settled();
  assert.equal(sentModel(g), "muse-wonder-1.0");
});

test("a test build's agent runs on the test model, but a live agent is still refused Contributor", async () => {
  const agentBuild = fakeGateway({
    fetch: replyFetch,
    buildTestModel: TEST_MODEL_NAME,
    token: { scope: "build", allowedModels: ["muse-wonder-1.0", "agent"] },
  });
  const res = await handleGateway(gatewayRequest("responses", wonderCall(), JSON_CT), ["responses"], agentBuild.deps);
  assert.equal(res.status, 200);
  await agentBuild.settled();
  assert.equal(sentModel(agentBuild), TEST_MODEL_NAME);

  const liveAgent = fakeGateway({
    buildTestModel: TEST_MODEL_NAME,
    token: { scope: "live", allowedModels: ["muse-spark-1.3", "agent"] },
  });
  const err = await errorOf(await handleGateway(gatewayRequest("responses", spark(), JSON_CT), ["responses"], liveAgent.deps));
  assert.equal(err.code, "model_not_for_agents");
});
