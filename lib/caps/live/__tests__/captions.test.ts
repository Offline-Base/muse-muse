/**
 * Near-live captions at the Meta gateway (docs/CAPABILITIES.md, section 13): the raised per-IP limit only for a chunk from
 * a cap:live token, caption minutes, and nothing at all while deps.liveCaptions is unset.
 */
import assert from "node:assert/strict";
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
const atIpCount = (count: number) => ({ counts: { [`ip:00000000-0000-4000-8000-000000000002:${IP}`]: count } });

describe("the per-IP limit on a live chunk", () => {
  it("is 30 a minute for a cap:live token that sends the header", async () => {
    const under = live(fakeGateway({ token: LIVE_TOKEN, fetch: ok, ...atIpCount(29) }));
    assert.equal((await send(under, chunkRequest({ [LIVE_HEADER]: SESSION }))).status, 200);
    const over = live(fakeGateway({ token: LIVE_TOKEN, fetch: ok, ...atIpCount(30) }));
    assert.equal((await send(over, chunkRequest({ [LIVE_HEADER]: SESSION }))).status, 429);
    assert.equal(over.upstreamCalls.length, 0);
    assert.equal(LIVE_LIMITS.asrPerIpPerMinute, 30);
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

  it("count a chunk's seconds per visitor and refuse past the day's minutes, before Meta", async () => {
    const g = live(fakeGateway({ token: LIVE_TOKEN, fetch: ok }), 1);
    // 3 s a chunk: 20 of them fill one minute.
    for (let i = 0; i < 20; i++) assert.equal((await send(g, chunkRequest(visitorHeaders, chunkForm(96_000)))).status, 200, `chunk ${i}`);
    const over = await send(g, chunkRequest(visitorHeaders, chunkForm(96_000)));
    assert.equal(over.status, 429);
    const body = (await over.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "quota_exceeded");
    assert.match(body.error.message, /1 minutes/);
    assert.equal(g.upstreamCalls.length, 20);
    await g.settled();
  });

  it("are each visitor's own, and an address has five visitors' worth, so a new cookie doesn't give a new day forever", async () => {
    const g = live(fakeGateway({ token: LIVE_TOKEN, fetch: ok }), 1);
    const noOneLimit = async (visitor: string) => send(g, chunkRequest({ [LIVE_HEADER]: SESSION, [VISITOR_HEADER]: visitor }, chunkForm(320_000)));
    // 10 s a chunk: 6 chunks a visitor, 30 an address. Rate limits aren't what's tested, so the fake's count is cleared.
    const counters = g.counters;
    let sent = 0;
    for (let v = 0; v < 6; v++) {
      for (let i = 0; i < 6; i++) {
        counters.clear();
        const res = await noOneLimit(`visitor_${v}_aaaaaaaaaaaaaaaa`);
        if (res.status === 200) sent += 1;
      }
    }
    assert.equal(sent, 30);
    await g.settled();
  });

  it("give the visitor's seconds back when the address is what refused", async () => {
    const g = live(fakeGateway({ token: LIVE_TOKEN, fetch: ok }), 1);
    for (let v = 0; v < 30; v++) {
      g.counters.clear();
      await send(g, chunkRequest({ [LIVE_HEADER]: SESSION, [VISITOR_HEADER]: `visitor_${v % 5}_aaaaaaaaaaaaaaaa` }, chunkForm(320_000)));
    }
    g.counters.clear();
    const fresh = await send(g, chunkRequest({ [LIVE_HEADER]: SESSION, [VISITOR_HEADER]: "visitor_new_aaaaaaaaaaaaaaaa" }, chunkForm(320_000)));
    assert.equal(fresh.status, 429);
    const elsewhere = await send(g, chunkRequest({ [LIVE_HEADER]: SESSION, [VISITOR_HEADER]: "visitor_new_aaaaaaaaaaaaaaaa", [CLIENT_IP_HEADER]: "203.0.113.8" }, chunkForm(320_000)));
    assert.equal(elsewhere.status, 200, "the refused chunk's seconds came back to this visitor");
    await g.settled();
  });

  it("share one wider allowance when a call names nobody", async () => {
    const g = live(fakeGateway({ token: LIVE_TOKEN, fetch: ok }), 1);
    const noOne = () => new Request("https://platform.example/api/gateway/v1/asr/transcribe", { method: "POST", headers: { authorization: `Bearer ${TEST_TOKEN}`, [LIVE_HEADER]: SESSION }, body: chunkForm(320_000) });
    let sent = 0;
    for (let i = 0; i < 31; i++) if ((await send(g, noOne())).status === 200) sent += 1;
    assert.equal(sent, 30);
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
