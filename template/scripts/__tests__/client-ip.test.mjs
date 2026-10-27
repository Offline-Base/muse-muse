// Unit tests for the visitor IP that the template's gateway calls send. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/*.test.mjs
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import nextHeaders from "next/dist/server/web/spec-extension/adapters/headers.js";
import { z } from "zod";
import { POST as uploadPost } from "../../app/api/upload/route";
import { CLIENT_IP_HEADER, clientIp, clientIpHeaders, metaClient } from "../../lib/meta/client";
import { respondJson } from "../../lib/meta/json";
import { transcribeFile } from "../../lib/meta/voice";

const realFetch = globalThis.fetch;
const env = { GATEWAY_URL: process.env.GATEWAY_URL, PRODUCT_TOKEN: process.env.PRODUCT_TOKEN };
let calls = [];

/** Replaces fetch with one that records each call and answers with `reply`. */
function stubFetch(reply) {
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    calls.push({ url: req.url, headers: req.headers, body: await req.text() });
    return reply();
  };
}

const visitor = (headers) => new Request("https://product.example/api/actions/x", { method: "POST", headers });

beforeEach(() => {
  calls = [];
  process.env.GATEWAY_URL = "https://gateway.example/api/gateway/";
  process.env.PRODUCT_TOKEN = "mm_test_token";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("clientIp takes the first x-forwarded-for entry, then x-real-ip", () => {
  assert.equal(clientIp(visitor({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" })), "203.0.113.7");
  assert.equal(clientIp(visitor({ "x-real-ip": "198.51.100.4" })), "198.51.100.4");
  assert.equal(clientIp(new Headers({ "x-forwarded-for": "2001:db8::1" })), "2001:db8::1");
  assert.equal(clientIp(visitor({ "x-forwarded-for": "203.0.113.7;x=<y>" })), "203.0.113.7");
  assert.equal(clientIp(visitor({})), undefined);
  assert.equal(clientIp(undefined), undefined);
});

test("clientIp reads the object next/headers returns in a server action", () => {
  // Next's adapter has a get() method and also a private `headers` field holding Node's raw headers.
  const { HeadersAdapter } = nextHeaders;
  const fromNext = HeadersAdapter.seal(HeadersAdapter.from({ "x-forwarded-for": "203.0.113.8, 10.0.0.1" }));
  assert.equal(clientIp(fromNext), "203.0.113.8");
});

test("loopback requests (tests and scripts on the build machine) send no IP", () => {
  for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) assert.equal(clientIp(visitor({ "x-forwarded-for": ip })), undefined);
  assert.deepEqual(clientIpHeaders(visitor({ "x-forwarded-for": "::1" })), {});
  assert.deepEqual(clientIpHeaders(visitor({ "x-real-ip": "203.0.113.7" })), { [CLIENT_IP_HEADER]: "203.0.113.7" });
});

test("metaClient(request) sends x-musemuse-client-ip on every gateway call", async () => {
  stubFetch(() => Response.json({ object: "list", data: [] }));
  await metaClient(visitor({ "x-forwarded-for": "203.0.113.7" })).models.list();
  assert.equal(calls[0].url, "https://gateway.example/api/gateway/v1/models");
  assert.equal(calls[0].headers.get(CLIENT_IP_HEADER), "203.0.113.7");
  assert.equal(calls[0].headers.get("authorization"), "Bearer mm_test_token");

  await metaClient().models.list();
  assert.equal(calls[1].headers.get(CLIENT_IP_HEADER), null);
});

test("respondJson passes the request's IP through to the gateway", async () => {
  const text = JSON.stringify({ color: "red" });
  stubFetch(() =>
    Response.json({
      id: "resp_1",
      object: "response",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }],
      output_text: text,
    }),
  );
  const out = await respondJson({
    schema: z.object({ color: z.string() }),
    schemaName: "color",
    input: "What color?",
    request: visitor({ "x-forwarded-for": "203.0.113.9" }),
  });
  assert.deepEqual(out, { color: "red" });
  assert.equal(calls[0].headers.get(CLIENT_IP_HEADER), "203.0.113.9");
});

test("transcribeFile sends the request's IP with the multipart call", async () => {
  stubFetch(() => Response.json({ transcript: "hello​ ", audioDurationMs: 1000, turns: [] }));
  const wav = new Uint8Array(64);
  wav.set(new TextEncoder().encode("RIFF"), 0);
  wav.set(new TextEncoder().encode("WAVE"), 8);
  const t = await transcribeFile({ bytes: wav, request: new Headers({ "x-real-ip": "198.51.100.4" }) });
  assert.equal(t.text, "hello");
  assert.equal(calls[0].url, "https://gateway.example/api/gateway/v1/asr/transcribe");
  assert.equal(calls[0].headers.get(CLIENT_IP_HEADER), "198.51.100.4");
});

const tokenRequest = JSON.stringify({
  type: "blob.generate-client-token",
  payload: { pathname: "uploads/a.wav", clientPayload: null, multipart: false },
});

const uploadRequest = (body, headers = {}) =>
  new Request("https://product.example/api/upload", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });

test("/api/upload forwards the body, the product token and the visitor's IP", async () => {
  stubFetch(() => Response.json({ type: "blob.generate-client-token", clientToken: "vercel_blob_client_x" }));
  const res = await uploadPost(uploadRequest(tokenRequest, { "x-forwarded-for": "203.0.113.7", "sec-fetch-site": "same-origin" }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { type: "blob.generate-client-token", clientToken: "vercel_blob_client_x" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://gateway.example/api/gateway/uploads");
  assert.equal(calls[0].body, tokenRequest);
  assert.equal(calls[0].headers.get("authorization"), "Bearer mm_test_token");
  assert.equal(calls[0].headers.get(CLIENT_IP_HEADER), "203.0.113.7");
});

test("/api/upload rejects non-JSON, non-Blob, oversized and cross-site requests without calling the gateway", async () => {
  stubFetch(() => Response.json({}));
  const statusOf = async (req) => (await uploadPost(req)).status;
  assert.equal(await statusOf(uploadRequest("not json")), 400);
  assert.equal(await statusOf(uploadRequest(JSON.stringify({ type: "something.else", payload: {} }))), 400);
  assert.equal(await statusOf(uploadRequest(JSON.stringify({ type: "blob.generate-client-token" }))), 400);
  assert.equal(await statusOf(uploadRequest(JSON.stringify({ type: "blob.generate-client-token", payload: { pathname: "x".repeat(20_000) } }))), 413);
  assert.equal(await statusOf(uploadRequest(tokenRequest, { "sec-fetch-site": "cross-site" })), 403);
  assert.equal(calls.length, 0);
});

test("/api/upload still accepts Vercel's signed upload-completed callback", async () => {
  stubFetch(() => Response.json({ type: "blob.upload-completed", response: "ok" }));
  const callback = JSON.stringify({ type: "blob.upload-completed", payload: { blob: { url: "https://x" }, tokenPayload: "{}" } });
  const res = await uploadPost(uploadRequest(callback, { "x-vercel-signature": "sig" }));
  assert.equal(res.status, 200);
  assert.equal(calls[0].headers.get("x-vercel-signature"), "sig");
  assert.equal(calls[0].headers.get(CLIENT_IP_HEADER), null);
});
