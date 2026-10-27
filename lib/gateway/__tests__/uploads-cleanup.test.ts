import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { getPayloadFromClientToken } from "@vercel/blob/client";
import { cronAuthorized, runCleanup } from "@/lib/gateway/cleanup";
import { checkUploadPathname, handleGatewayUpload, type UploadDeps } from "@/lib/gateway/uploads";
import type { ProductStatus } from "@/lib/types";
import { TEST_TOKEN } from "./helpers";

/** A well-formed but fake read-write token: client tokens are signed locally, so no Blob store is needed. */
const FAKE_BLOB_TOKEN = "vercel_blob_rw_teststore123_secretsecretsecretsecret";

function deps(status: ProductStatus = "live", counters = new Map<string, number>()): UploadDeps & { rateKeys: string[][] } {
  const rateKeys: string[][] = [];
  return {
    rateKeys,
    findToken: async (t) =>
      t === TEST_TOKEN
        ? { id: "tok-1", productId: "prod-1", scope: "live", allowedModels: [], dailyBudgetUsd: 1 }
        : null,
    productStatus: async () => status,
    blobToken: () => FAKE_BLOB_TOKEN,
    callbackUrl: "https://platform.example/api/gateway/uploads",
    hitRateLimits: async (keys, windowStart) => {
      rateKeys.push([...keys, windowStart.toISOString()]);
      return Object.fromEntries(keys.map((k) => [k, counters.set(k, (counters.get(k) ?? 0) + 1).get(k)!]));
    },
    now: () => new Date("2026-10-27T12:34:56Z"),
  };
}

const tokenEvent = (pathname: string) => ({
  type: "blob.generate-client-token",
  payload: { pathname, multipart: false, clientPayload: null },
});

function post(body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TEST_TOKEN}` }) {
  return new Request("https://platform.example/api/gateway/uploads", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("checkUploadPathname", () => {
  assert.equal(checkUploadPathname("uploads/clip.mp4"), null);
  assert.equal(checkUploadPathname("uploads/a/b/c.wav"), null);
  assert.ok(checkUploadPathname("inspo/x.png"));
  assert.ok(checkUploadPathname("uploads/"));
  assert.ok(checkUploadPathname("uploads/../inspo/x.png"));
  assert.ok(checkUploadPathname("uploads/a..b"));
  assert.ok(checkUploadPathname("uploads//x"));
});

test("token request: product token required, product must be on", async () => {
  assert.equal((await handleGatewayUpload(post(tokenEvent("uploads/a.png"), {}), deps())).status, 401);
  assert.equal((await handleGatewayUpload(post(tokenEvent("uploads/a.png")), deps("disabled"))).status, 403);
  assert.equal((await handleGatewayUpload(post("{nope"), deps())).status, 400);
  assert.equal((await handleGatewayUpload(post({ type: "other", payload: {} }), deps())).status, 400);
});

test("token request: bad pathname -> 400", async () => {
  const res = await handleGatewayUpload(post(tokenEvent("uploads/../x.png")), deps());
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, "invalid_pathname");
});

test("token request: returns a client token carrying the limits, productId and callback", async () => {
  const res = await handleGatewayUpload(post(tokenEvent("uploads/clip.mp4")), deps());
  assert.equal(res.status, 200);
  const body = (await res.json()) as { type: string; clientToken: string };
  assert.equal(body.type, "blob.generate-client-token");
  const payload = getPayloadFromClientToken(body.clientToken) as unknown as {
    pathname: string;
    allowedContentTypes: string[];
    maximumSizeInBytes: number;
    addRandomSuffix: boolean;
    onUploadCompleted?: { callbackUrl: string; tokenPayload: string };
  };
  assert.equal(payload.pathname, "uploads/clip.mp4");
  assert.ok(payload.allowedContentTypes.includes("video/mp4"));
  assert.ok(payload.allowedContentTypes.includes("text/plain"));
  assert.ok(payload.allowedContentTypes.includes("image/jpeg"));
  assert.ok(!payload.allowedContentTypes.some((t) => t === "image/*" || t.includes("svg")), "no SVG on the public Blob domain");
  assert.equal(payload.maximumSizeInBytes, 100 * 1024 * 1024);
  assert.equal(payload.addRandomSuffix, true);
  assert.equal(payload.onUploadCompleted?.callbackUrl, "https://platform.example/api/gateway/uploads");
  assert.deepEqual(JSON.parse(payload.onUploadCompleted!.tokenPayload), { productId: "prod-1" });
});

test("token request: short-lived tickets", async () => {
  const before = Date.now();
  const res = await handleGatewayUpload(post(tokenEvent("uploads/clip.mp4")), deps());
  const { clientToken } = (await res.json()) as { clientToken: string };
  const { validUntil } = getPayloadFromClientToken(clientToken) as unknown as { validUntil: number };
  assert.ok(validUntil - before <= 5 * 60_000 + 1000 && validUntil > before, String(validUntil - before));
});

test("token request: 30 tickets per token and 10 per end user every 10 minutes", async () => {
  const counters = new Map<string, number>();
  const d = deps("live", counters);
  for (let i = 0; i < 30; i++) assert.equal((await handleGatewayUpload(post(tokenEvent("uploads/a.png")), d)).status, 200);
  const over = await handleGatewayUpload(post(tokenEvent("uploads/a.png")), d);
  assert.equal(over.status, 429);
  const err = ((await over.json()) as { error: { code: string; message: string } }).error;
  assert.equal(err.code, "rate_limited");
  assert.match(err.message, /this product/);
  assert.equal(over.headers.get("retry-after"), "304", "the window ends at 12:40");
  assert.deepEqual(d.rateKeys[0], ["upload:token:tok-1", "2026-10-27T12:30:00.000Z"]);

  const user = deps("live", new Map([["upload:ip:prod-1:203.0.113.7", 10]]));
  const headers = { authorization: `Bearer ${TEST_TOKEN}`, "x-musemuse-client-ip": "203.0.113.7, 10.1.1.1" };
  const res = await handleGatewayUpload(post(tokenEvent("uploads/a.png"), headers), user);
  assert.equal(res.status, 429);
  assert.match(((await res.json()) as { error: { message: string } }).error.message, /this user/);
  assert.deepEqual(user.rateKeys[0], ["upload:token:tok-1", "upload:ip:prod-1:203.0.113.7", "2026-10-27T12:30:00.000Z"]);

  // The header never stands in for the product token, and bad tokens don't spend the product's tickets.
  const anon = deps();
  const noToken = await handleGatewayUpload(post(tokenEvent("uploads/a.png"), { "x-musemuse-client-ip": "203.0.113.7" }), anon);
  assert.equal(noToken.status, 401);
  assert.equal(anon.rateKeys.length, 0);
});

test("upload-completed callback: no bearer needed, but the signature must match", async () => {
  const event = {
    type: "blob.upload-completed",
    payload: {
      blob: { url: "https://teststore.public.blob.vercel-storage.com/uploads/a.png", pathname: "uploads/a.png" },
      tokenPayload: '{"productId":"prod-1"}',
    },
  };
  const raw = JSON.stringify(event);
  const good = createHmac("sha256", FAKE_BLOB_TOKEN).update(raw).digest("hex");
  const ok = await handleGatewayUpload(post(raw, { "x-vercel-signature": good }), deps());
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { type: "blob.upload-completed", response: "ok" });

  const bad = await handleGatewayUpload(post(raw, { "x-vercel-signature": "00".repeat(32) }), deps());
  assert.equal(bad.status, 400);
  const missing = await handleGatewayUpload(post(raw, {}), deps());
  assert.equal(missing.status, 400);
});

test("missing BLOB_READ_WRITE_TOKEN -> 500, not a client error", async () => {
  const res = await handleGatewayUpload(post(tokenEvent("uploads/a.png")), {
    ...deps(),
    blobToken: () => {
      throw new Error("BLOB_READ_WRITE_TOKEN is not set.");
    },
  });
  assert.equal(res.status, 500);
});

test("cronAuthorized", () => {
  assert.equal(cronAuthorized("Bearer s3cret", "s3cret"), true);
  assert.equal(cronAuthorized("Bearer nope", "s3cret"), false);
  assert.equal(cronAuthorized(null, "s3cret"), false);
  assert.equal(cronAuthorized("Bearer ", undefined), false);
});

test("runCleanup: cutoffs per task, and one failure doesn't stop the rest", async () => {
  const now = new Date("2026-10-27T12:00:00Z");
  const seen: Record<string, string> = {};
  const results = await runCleanup(
    {
      deleteBlobsOlderThan: async (prefix, olderThan) => {
        seen[prefix] = olderThan.toISOString();
        if (prefix === "screens") throw new Error("blob down");
        return 4;
      },
      deleteRateLimitsBefore: async (before) => {
        seen.rateLimits = before.toISOString();
        return 9;
      },
      revokeExpiredBuildTokens: async (at) => {
        seen.tokens = at.toISOString();
        return 2;
      },
    },
    now,
  );
  assert.deepEqual(seen, {
    uploads: "2026-10-26T12:00:00.000Z",
    screens: "2026-10-20T12:00:00.000Z",
    rateLimits: "2026-10-27T11:00:00.000Z",
    tokens: "2026-10-27T12:00:00.000Z",
  });
  assert.deepEqual(results, {
    uploads: { ok: true, count: 4 },
    screens: { ok: false, error: "blob down" },
    rateLimits: { ok: true, count: 9 },
    expiredBuildTokens: { ok: true, count: 2 },
  });
});
