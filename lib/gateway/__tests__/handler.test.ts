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

test("forward: master key, raw bytes and content type preserved; JSON passes through and is metered", async () => {
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
  assert.equal(new TextDecoder().decode(call.init?.body as Uint8Array), sent);
  assert.ok(!JSON.stringify(headers).includes(TEST_TOKEN), "the product token never goes upstream");

  assert.equal(g.usage.length, 1);
  assert.equal(g.usage[0].ctx.source, "gateway");
  assert.equal(g.usage[0].ctx.endpoint, "responses");
  assert.equal(g.usage[0].items[0].inputTokens, 10);
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
