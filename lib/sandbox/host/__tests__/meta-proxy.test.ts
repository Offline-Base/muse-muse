/**
 * Unit tests for the Meta proxy Modal build sandboxes use (lib/sandbox/host/meta-proxy.ts).
 *   npx tsx --test lib/sandbox/host/__tests__/meta-proxy.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  handleSandboxMeta,
  metaPathFor,
  mintSandboxMetaToken,
  MODAL_META_PATH,
  modalMuseSettings,
  verifySandboxMetaToken,
} from "@/lib/sandbox/host/meta-proxy";
import { BROKERED_META_ROUTES, META_BLOCKED_BODY } from "@/lib/sandbox/policy";

const KEY = "sk-meta-real-key-0123456789";
const NOW = 1_800_000_000_000;
const NAME = "product-bird-finder-0123abcd";
const token = (name = NAME, exp = NOW + 60_000) => mintSandboxMetaToken(KEY, name, exp);

interface Sent {
  url: string;
  init: RequestInit & { duplex?: string };
}

function proxy(opts: { enabled?: boolean; status?: number } = {}) {
  const sent: Sent[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return new Response("upstream body", { status: opts.status ?? 200, headers: { "content-type": "text/event-stream", "set-cookie": "a=b", "x-meta-internal": "1" } });
  }) as unknown as typeof fetch;
  const call = (req: Request, segments: string[]) =>
    handleSandboxMeta(req, segments, { enabled: opts.enabled ?? true, modelApiKey: () => KEY, fetch: fakeFetch, now: () => NOW });
  return { sent, call };
}

function req(method: string, path: string, headers: Record<string, string> = {}, body?: string): Request {
  return new Request(`https://muse-muse.vercel.app${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
}

test("a token names its sandbox, verifies, and never holds the key", () => {
  const t = token();
  assert.ok(!t.includes(KEY));
  assert.deepEqual(verifySandboxMetaToken(KEY, t, NOW), { sandboxName: NAME });
  assert.equal(verifySandboxMetaToken("another-key", t, NOW), null, "signed with the real key");
});

test("an expired, altered or malformed token is refused", () => {
  assert.equal(verifySandboxMetaToken(KEY, token(NAME, NOW - 1), NOW), null);
  const t = token();
  const [p, exp, , sig] = t.split(".");
  assert.equal(verifySandboxMetaToken(KEY, `${p}.${exp}.product-other-0123abcd.${sig}`, NOW), null, "swapped sandbox name");
  const later = (parseInt(exp!, 36) + 10_000_000).toString(36);
  assert.equal(verifySandboxMetaToken(KEY, `${p}.${later}.${NAME}.${sig}`, NOW), null, "pushed-out expiry");
  for (const bad of ["", "mmx", "mmx.a.b", `xx.${exp}.${NAME}.${sig}`, `${t}.extra`, `mmx.${exp}.UPPER.${sig}`]) {
    assert.equal(verifySandboxMetaToken(KEY, bad, NOW), null, bad);
  }
  assert.throws(() => mintSandboxMetaToken(KEY, "Bad Name", NOW + 1));
});

test("Muse Code's settings point at the proxy with the bearer pinned and telemetry off", () => {
  const [endpoint, telemetry] = modalMuseSettings("https://muse-muse.vercel.app/");
  assert.equal(endpoint, `endpoint_transport={"base_url":"https://muse-muse.vercel.app${MODAL_META_PATH}","auth":"bearer"}`);
  assert.equal(telemetry, "telemetry.enabled=false");
});

test("paths: only plain segments", () => {
  assert.equal(metaPathFor(["v1", "responses"]), "/v1/responses");
  for (const bad of [["v1", ".."], ["v1", ""], ["v1", "a%2fb"], ["v1", "a/b"], ["v1", "a\\b"]]) assert.equal(metaPathFor(bad), null);
});

test("off on the default host: 404 and nothing forwarded", async () => {
  const { sent, call } = proxy({ enabled: false });
  const res = await call(req("POST", "/api/sandbox-meta/v1/responses", { authorization: `Bearer ${token()}` }, "{}"), ["v1", "responses"]);
  assert.equal(res.status, 404);
  assert.equal(sent.length, 0);
});

test("each brokered route is forwarded with the real key, and only content-type and accept ride along", async () => {
  for (const route of BROKERED_META_ROUTES) {
    for (const method of route.methods) {
      const { sent, call } = proxy();
      const body = method === "GET" ? undefined : '{"model":"muse-spark-1.3-contributor"}';
      const headers = { authorization: `Bearer ${token()}`, "content-type": "application/json", accept: "text/event-stream", cookie: "s=1", "x-forwarded-host": "evil.example" };
      const res = await call(req(method, `/x${route.path}?leak=1`, headers, body), route.path.slice(1).split("/"));
      assert.equal(res.status, 200, `${method} ${route.path}`);
      assert.equal(sent.length, 1);
      assert.equal(sent[0]!.url, `https://api.meta.ai${route.path}`, "no query string, Meta's host only");
      assert.equal(sent[0]!.init.method, method);
      assert.deepEqual(sent[0]!.init.headers, { authorization: `Bearer ${KEY}`, "content-type": "application/json", accept: "text/event-stream" });
      assert.equal(sent[0]!.init.redirect, "manual");
      assert.equal(res.headers.get("content-type"), "text/event-stream");
      assert.equal(res.headers.get("set-cookie"), null, "upstream headers aren't passed back");
      assert.equal(await res.text(), "upstream body");
    }
  }
});

test("every other route or method is refused before Meta is called", async () => {
  const cases: Array<[string, string[]]> = [
    ["GET", ["v1", "files"]],
    ["DELETE", ["v1", "files"]],
    ["POST", ["v1", "images", "generations"]],
    ["POST", ["v1", "asr", "transcribe"]],
    ["POST", ["muse-code", "telemetry", "logs"]],
    ["GET", ["v1", "responses"]],
    ["POST", ["v1", "models"]],
    ["POST", ["v1", "responses", "x"]],
  ];
  for (const [method, segments] of cases) {
    const { sent, call } = proxy();
    const res = await call(req(method, "/x", { authorization: `Bearer ${token()}` }, method === "GET" ? undefined : "{}"), segments);
    assert.equal(res.status, 403, `${method} /${segments.join("/")}`);
    assert.equal(await res.text(), META_BLOCKED_BODY);
    assert.equal(sent.length, 0);
  }
});

test("no token, the real key itself, or an expired token: 401 and nothing forwarded", async () => {
  for (const auth of [undefined, `Bearer ${KEY}`, `Bearer ${token(NAME, NOW - 5)}`, token(), "Basic abc"]) {
    const { sent, call } = proxy();
    const res = await call(req("POST", "/x", auth ? { authorization: auth } : {}, "{}"), ["v1", "responses"]);
    assert.equal(res.status, 401, String(auth));
    assert.ok(!(await res.text()).includes(KEY));
    assert.equal(sent.length, 0);
  }
});

test("Meta's error status comes back as it is", async () => {
  const { call } = proxy({ status: 429 });
  const res = await call(req("POST", "/x", { authorization: `Bearer ${token()}` }, "{}"), ["v1", "responses"]);
  assert.equal(res.status, 429);
});
