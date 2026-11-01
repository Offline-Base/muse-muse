/**
 * Near-live captions at the Meta gateway (docs/CAPABILITIES.md, section 13): the raised per-IP limit only for a chunk from
 * a cap:live token, caption minutes, and nothing at all while deps.liveCaptions is unset.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { handleGateway } from "@/lib/gateway/handler";
import { fakeGateway, gatewayRequest, TEST_TOKEN } from "@/lib/gateway/__tests__/helpers";
import { LIVE_HEADER, liveProofKey } from "@/lib/caps/live/captions";
import { LIVE_LIMITS } from "@/lib/caps/live/limits";
import { DEFAULT_LIMITS, CLIENT_IP_HEADER, VISITOR_HEADER } from "@/lib/gateway/policy";

process.env.GATEWAY_TOKEN_PEPPER ??= "test-pepper-for-live";

const LIVE_TOKEN = { allowedModels: ["muse-voice-transcribe-1.0", "cap:live"] };
const IP = "203.0.113.7";
const VISITOR = "visitor_aaaaaaaaaaaaaaaa";
const SESSION = "session_12345678";
const ok = async () => Response.json({ transcript: "hello", audioDurationMs: 2500 });

/** A WAV-shaped multipart body with this many bytes of audio. */
function chunkForm(bytes = 80_000): FormData {
  const form = new FormData();
  form.append("request", JSON.stringify({ model: "muse-voice-transcribe-1.0", audioEncoding: "WAV" }));
  form.append("audio", new Blob([new Uint8Array(bytes)], { type: "audio/wav" }), "chunk.wav");
  return form;
}

function chunkRequest(headers: Record<string, string> = {}, form: FormData = chunkForm()) {
  return new Request("https://platform.example/api/gateway/v1/asr/transcribe", {
    method: "POST",
    headers: { authorization: `Bearer ${TEST_TOKEN}`, [CLIENT_IP_HEADER]: IP, ...headers },
    body: form,
  });
}

const send = (g: ReturnType<typeof fakeGateway>, req: Request) => handleGateway(req, ["asr", "transcribe"], g.deps);
const live = (g: ReturnType<typeof fakeGateway>, minutesPerDay = 10) => {
  g.deps.liveCaptions = { minutesPerDay };
  return g;
};
const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

/** The fake's per-IP count already at `count`, so the next call is count + 1. */
const PRODUCT = "00000000-0000-4000-8000-000000000002";
const atIpCount = (count: number) => ({ counts: { [`ip:${PRODUCT}:${IP}`]: count } });
/** The same for a chunk's own key. */
const atChunkCount = (count: number) => ({ counts: { [`live-ip:${PRODUCT}:${IP}`]: count } });

describe("the per-IP limit on a live chunk", () => {
  it("is 30 a minute for a cap:live token that sends the header", async () => {
    const under = live(fakeGateway({ token: LIVE_TOKEN, fetch: ok, ...atChunkCount(29) }));
    assert.equal((await send(under, chunkRequest({ [LIVE_HEADER]: SESSION }))).status, 200);
    const over = live(fakeGateway({ token: LIVE_TOKEN, fetch: ok, ...atChunkCount(30) }));
    assert.equal((await send(over, chunkRequest({ [LIVE_HEADER]: SESSION }))).status, 429);
    assert.equal(over.upstreamCalls.length, 0);
    assert.equal(LIVE_LIMITS.asrPerIpPerMinute, 30);
  });

  it("keeps chunks and a person's other calls apart, so neither uses up the other", async () => {
    const both = { allowedModels: ["muse-voice-transcribe-1.0", "muse-wonder-1.0", "cap:live"] };
    const g = live(fakeGateway({ token: both, fetch: ok }));
    const chunk = () => send(g, chunkRequest({ [LIVE_HEADER]: SESSION, [VISITOR_HEADER]: VISITOR }));
    const call = () => handleGateway(gatewayRequest("responses", JSON.stringify({ model: "muse-wonder-1.0", input: "summarize so far" }), { "content-type": "application/json", [CLIENT_IP_HEADER]: IP }), ["responses"], g.deps);
    for (let i = 0; i < LIVE_LIMITS.asrPerIpPerMinute; i++) assert.equal((await chunk()).status, 200, `chunk ${i}`);
    assert.equal((await call()).status, 200, "a minute of captions leaves the person's other calls alone");
    for (let i = 1; i < DEFAULT_LIMITS.perIpRequestsPerMinute; i++) assert.equal((await call()).status, 200, `call ${i}`);
    const overCalls = await call();
    assert.equal(overCalls.status, 429, "other calls keep their own 20");
    assert.match(((await overCalls.json()) as { error: { message: string } }).error.message, /this user: the limit is 20/);
    const overChunks = await chunk();
    assert.equal(overChunks.status, 429, "and chunks their own 30");
    assert.match(((await overChunks.json()) as { error: { message: string } }).error.message, /this user: the limit is 30/);
    await g.settled();
  });

  it("stays 20 with the header but no cap:live, and its caption minutes aren't touched", async () => {
    const g = live(fakeGateway({ token: { allowedModels: ["muse-voice-transcribe-1.0"] }, fetch: ok, ...atIpCount(DEFAULT_LIMITS.perIpRequestsPerMinute) }));
    assert.equal((await send(g, chunkRequest({ [LIVE_HEADER]: SESSION }))).status, 429);
    const allowed = live(fakeGateway({ token: { allowedModels: ["muse-voice-transcribe-1.0"] }, fetch: ok }));
    assert.equal((await send(allowed, chunkRequest({ [LIVE_HEADER]: "x" }))).status, 200, "the header means nothing here, so it isn't even checked");
    assert.equal(await allowed.deps.counterValue("anything", new Date()), 0);
  });

  it("stays 20 for a cap:live token without the header, and for another endpoint", async () => {
    const g = live(fakeGateway({ token: LIVE_TOKEN, fetch: ok, ...atIpCount(DEFAULT_LIMITS.perIpRequestsPerMinute) }));
    assert.equal((await send(g, chunkRequest())).status, 429);
    const responses = live(fakeGateway({ token: { allowedModels: ["muse-wonder-1.0", "cap:live"] }, fetch: ok, ...atIpCount(DEFAULT_LIMITS.perIpRequestsPerMinute) }));
    const res = await handleGateway(gatewayRequest("responses", JSON.stringify({ model: "muse-wonder-1.0", input: "hi" }), { "content-type": "application/json", [LIVE_HEADER]: SESSION, [CLIENT_IP_HEADER]: IP }), ["responses"], responses.deps);
    assert.equal(res.status, 429);
  });

  it("stays 20, and the header means nothing, while the live cap isn't served", async () => {
    const off = fakeGateway({ token: LIVE_TOKEN, fetch: ok, ...atIpCount(DEFAULT_LIMITS.perIpRequestsPerMinute) });
    assert.equal(off.deps.liveCaptions, undefined);
    assert.equal((await send(off, chunkRequest({ [LIVE_HEADER]: SESSION }))).status, 429);
    const bad = fakeGateway({ token: LIVE_TOKEN, fetch: ok });
    assert.equal((await send(bad, chunkRequest({ [LIVE_HEADER]: "not a session!" }))).status, 200);
  });
});

describe("what counts as a live chunk", () => {
  it("refuses a bad session, a link to audio, no audio part and a long file, before Meta", async () => {
    const g = live(fakeGateway({ token: LIVE_TOKEN, fetch: ok }));
    assert.equal(await errorCode(await send(g, chunkRequest({ [LIVE_HEADER]: "no spaces!" }))), "invalid_live_session");
    const link = gatewayRequest("asr/transcribe", JSON.stringify({ model: "muse-voice-transcribe-1.0", audioUrl: "https://a.public.blob.vercel-storage.com/x.wav" }), { "content-type": "application/json", [LIVE_HEADER]: SESSION });
    assert.equal(await errorCode(await send(g, link)), "invalid_live_chunk");
    const noAudio = new FormData();
    noAudio.append("request", JSON.stringify({ model: "muse-voice-transcribe-1.0" }));
    assert.equal(await errorCode(await send(g, chunkRequest({ [LIVE_HEADER]: SESSION }, noAudio))), "invalid_live_chunk");
    assert.equal(await errorCode(await send(g, chunkRequest({ [LIVE_HEADER]: SESSION }, chunkForm(32_000 * LIVE_LIMITS.chunkMaxSeconds + 1)))), "live_chunk_too_long");
    assert.equal(g.upstreamCalls.length, 0);
  });

  it("takes ten full seconds and no more, the same number the product's route allows", async () => {
    const route = readFileSync(new URL("../../../../template/caps/live/files/app/api/musemuse/live-caption/route.ts", import.meta.url), "utf8");
    const most = Number(route.match(/const MOST_BYTES = ([\d_]+);/)![1]!.replace(/_/g, ""));
    const g = live(fakeGateway({ token: LIVE_TOKEN, fetch: ok }));
    assert.equal((await send(g, chunkRequest({ [LIVE_HEADER]: SESSION }, chunkForm(most)))).status, 200, "the largest piece the route lets through is a chunk");
    assert.equal(await errorCode(await send(g, chunkRequest({ [LIVE_HEADER]: SESSION }, chunkForm(most + 1)))), "live_chunk_too_long");
    await g.settled();
  });

  it("forwards a good chunk to Meta unchanged", async () => {
    const g = live(fakeGateway({ token: LIVE_TOKEN, fetch: ok }));
    const res = await send(g, chunkRequest({ [LIVE_HEADER]: SESSION, [VISITOR_HEADER]: VISITOR }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { transcript: "hello", audioDurationMs: 2500 });
    assert.equal(g.upstreamCalls.length, 1);
    assert.match(g.upstreamCalls[0]!.url, /\/asr\/transcribe$/);
    await g.settled();
  });
});

describe("caption minutes", () => {
  const visitorHeaders = { [LIVE_HEADER]: SESSION, [VISITOR_HEADER]: VISITOR };

  /** Per-minute limits aren't what these test, so they never bite. g.counters is the caption minutes, and stays. */
  const noRateLimit = (g: ReturnType<typeof fakeGateway>) => {
    g.deps.hitRateLimits = async (keys) => Object.fromEntries(keys.map((k) => [k, 1]));
    return g;
  };
  // 5.4 s with 0.4 s of overlap: 5 s of new talk. 12 fill one minute, 60 fill an address's five.
  const FIVE_SECONDS = 172_800;

  it("count only a chunk's new audio per visitor, not its overlap, and refuse past the day's minutes, before Meta", async () => {
    const g = noRateLimit(live(fakeGateway({ token: LIVE_TOKEN, fetch: ok }), 1));
    // A usual piece: 2.9 s with 0.4 s of overlap, so 2.5 s of new talk. 24 of them are the minute.
    for (let i = 0; i < 24; i++) assert.equal((await send(g, chunkRequest(visitorHeaders, chunkForm(92_800)))).status, 200, `chunk ${i}`);
    const over = await send(g, chunkRequest(visitorHeaders, chunkForm(92_800)));
    assert.equal(over.status, 429);
    const body = (await over.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "quota_exceeded");
    assert.match(body.error.message, /1 minutes for this person/);
    assert.equal(g.upstreamCalls.length, 24);
    await g.settled();
  });

  it("charge at least a second, so very short pieces aren't free", async () => {
    const g = noRateLimit(live(fakeGateway({ token: LIVE_TOKEN, fetch: ok }), 1));
    for (let i = 0; i < 60; i++) assert.equal((await send(g, chunkRequest(visitorHeaders, chunkForm(100)))).status, 200, `chunk ${i}`);
    assert.equal((await send(g, chunkRequest(visitorHeaders, chunkForm(100)))).status, 429);
    await g.settled();
  });

  it("are each visitor's own, and an address has five visitors' worth, so a new cookie doesn't give a new day forever", async () => {
    const g = noRateLimit(live(fakeGateway({ token: LIVE_TOKEN, fetch: ok }), 1));
    let sent = 0;
    let lastRefusal: Response | null = null;
    for (let v = 0; v < 6; v++) {
      for (let i = 0; i < 13; i++) {
        const res = await send(g, chunkRequest({ [LIVE_HEADER]: SESSION, [VISITOR_HEADER]: `visitor_${v}_aaaaaaaaaaaaaaaa` }, chunkForm(FIVE_SECONDS)));
        if (res.status === 200) sent += 1;
        else lastRefusal = res;
      }
    }
    assert.equal(sent, 60);
    const body = (await lastRefusal!.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "quota_exceeded");
    assert.match(body.error.message, /this network/, "an address's limit says it's shared, and doesn't blame this person");
    assert.doesNotMatch(body.error.message, /this person/);
    await g.settled();
  });

  it("give the visitor's seconds back when the address is what refused", async () => {
    const g = noRateLimit(live(fakeGateway({ token: LIVE_TOKEN, fetch: ok }), 1));
    for (let v = 0; v < 60; v++) await send(g, chunkRequest({ [LIVE_HEADER]: SESSION, [VISITOR_HEADER]: `visitor_${v % 5}_aaaaaaaaaaaaaaaa` }, chunkForm(FIVE_SECONDS)));
    const headers = { [LIVE_HEADER]: SESSION, [VISITOR_HEADER]: "visitor_new_aaaaaaaaaaaaaaaa" };
    assert.equal((await send(g, chunkRequest(headers, chunkForm(FIVE_SECONDS)))).status, 429);
    // The refused chunk's seconds came back, so this visitor still has all 12 elsewhere.
    for (let i = 0; i < 12; i++) assert.equal((await send(g, chunkRequest({ ...headers, [CLIENT_IP_HEADER]: "203.0.113.8" }, chunkForm(FIVE_SECONDS)))).status, 200, `chunk ${i}`);
    await g.settled();
  });

  it("share one wider allowance when a call names nobody", async () => {
    const g = noRateLimit(live(fakeGateway({ token: LIVE_TOKEN, fetch: ok }), 1));
    const noOne = () => new Request("https://platform.example/api/gateway/v1/asr/transcribe", { method: "POST", headers: { authorization: `Bearer ${TEST_TOKEN}`, [LIVE_HEADER]: SESSION }, body: chunkForm(FIVE_SECONDS) });
    let sent = 0;
    for (let i = 0; i < 61; i++) if ((await send(g, noOne())).status === 200) sent += 1;
    assert.equal(sent, 60);
    await g.settled();
  });

  it("record a build's chunk for its proof, and not a live product's", async () => {
    const build = live(fakeGateway({ token: { ...LIVE_TOKEN, scope: "build", buildId: "11111111-1111-4111-8111-111111111111" } as never, fetch: ok }));
    await send(build, chunkRequest(visitorHeaders));
    assert.ok(build.rateKeys.flat().includes(liveProofKey("chunks", "11111111-1111-4111-8111-111111111111")));
    const product = live(fakeGateway({ token: LIVE_TOKEN, fetch: ok }));
    await send(product, chunkRequest(visitorHeaders));
    assert.ok(!product.rateKeys.flat().some((k) => k.startsWith("live-proof:")));
    await build.settled();
    await product.settled();
  });
});
