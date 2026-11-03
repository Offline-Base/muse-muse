/**
 * Product uploads through {GATEWAY_URL}/uploads with a presigned URL: the path that works on a Blob store connected by
 * OIDC only, with no read-write token. The delegation is faked; the presigning itself is @vercel/blob's own.
 *
 *   npx tsx --test lib/gateway/__tests__/uploads.test.ts
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { GatewayToken } from "@/lib/gateway/handler";
import { DEFAULT_LIMITS } from "@/lib/gateway/policy";
import { UPLOAD_CONTENT_TYPES, handleGatewayUpload, type UploadDeps } from "@/lib/gateway/uploads";

/** Stand-in for the per-issuance signing key the Blob API returns. Not a real one. */
const FAKE_SIGNING_KEY = "test-client-signing-key";
const NOW = new Date("2026-11-03T08:00:00Z");
const TOKEN: GatewayToken = { id: "tok_1", productId: "prod_1", scope: "product", allowedModels: null, dailyBudgetUsd: null } as unknown as GatewayToken;
const b64url = (s: string) => Buffer.from(s).toString("base64url");

let signed: Array<Record<string, unknown>> = [];
let status: string | null = "live";
let rwToken: string | undefined;

function deps(over: Partial<UploadDeps> = {}): UploadDeps {
  return {
    findToken: async (t) => (t === "product-token" ? TOKEN : null),
    productStatus: async () => status as never,
    blobToken: () => rwToken,
    hitRateLimits: async (keys) => Object.fromEntries(keys.map((k) => [k, 1])),
    now: () => NOW,
    signedToken: async (input) => {
      signed.push(input);
      return { delegationToken: `${b64url(JSON.stringify({ storeId: "teststore", ...input }))}.sig`, clientSigningToken: FAKE_SIGNING_KEY, validUntil: input.validUntil } as never;
    },
    ...over,
  };
}

const presign = (pathname: string) => ({ type: "blob.generate-presigned-url", payload: { pathname, multipart: false, clientPayload: null } });

function post(body: unknown, auth = "Bearer product-token"): Request {
  return new Request("https://muse.example.com/api/gateway/uploads", {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(body),
  });
}

describe("gateway presigned uploads", () => {
  beforeEach(() => {
    signed = [];
    status = "live";
    rwToken = undefined;
  });

  it("issues a presigned PUT for one uploads/ pathname with the product limits, with no read-write token", async () => {
    const res = await handleGatewayUpload(post(presign("uploads/abc-clip.mp4")), deps());
    assert.equal(res.status, 200, await res.clone().text());
    const body = (await res.json()) as { type: string; presignedUrlPayload: { delegationToken: string; params: Record<string, string> } };
    assert.equal(body.type, "blob.generate-presigned-url");
    assert.equal(signed.length, 1);
    assert.deepEqual(signed[0], {
      pathname: "uploads/abc-clip.mp4",
      operations: ["put"],
      validUntil: NOW.getTime() + DEFAULT_LIMITS.uploadTicketValidMs,
      allowedContentTypes: UPLOAD_CONTENT_TYPES,
      maximumSizeInBytes: DEFAULT_LIMITS.uploadMaxBytes,
    });
    assert.ok(body.presignedUrlPayload.delegationToken.endsWith(".sig"));
  });

  it("refuses a pathname outside uploads/ before asking Blob for anything", async () => {
    const res = await handleGatewayUpload(post(presign("inspo/x.png")), deps());
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "invalid_pathname");
    assert.equal(signed.length, 0);
  });

  it("needs a live product's token", async () => {
    assert.equal((await handleGatewayUpload(post(presign("uploads/a.png"), ""), deps())).status, 401);
    assert.equal((await handleGatewayUpload(post(presign("uploads/a.png"), "Bearer nope"), deps())).status, 401);
    status = "disabled";
    assert.equal((await handleGatewayUpload(post(presign("uploads/a.png")), deps())).status, 403);
    assert.equal(signed.length, 0);
  });

  it("keeps the ticket rate limit", async () => {
    const res = await handleGatewayUpload(post(presign("uploads/a.png")), deps({ hitRateLimits: async (keys) => Object.fromEntries(keys.map((k) => [k, 10_000])) }));
    assert.equal(res.status, 429);
    assert.equal(signed.length, 0);
  });

  it("still answers a client-token request with 503 when there is no read-write token", async () => {
    const res = await handleGatewayUpload(post({ type: "blob.generate-client-token", payload: { pathname: "uploads/a.png", callbackUrl: "", clientPayload: null, multipart: false } }), deps());
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "uploads_unavailable");
  });

  it("503 uploads_unavailable when the store can't issue", async () => {
    const res = await handleGatewayUpload(
      post(presign("uploads/a.png")),
      deps({
        signedToken: async () => {
          throw new Error("No blob credentials found: OIDC token missing");
        },
      }),
    );
    assert.equal(res.status, 503);
  });
});
