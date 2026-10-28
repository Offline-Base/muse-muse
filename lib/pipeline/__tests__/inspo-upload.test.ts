/**
 * POST /api/inspirations/upload, the presigned inspo upload route. It answers only blob.generate-presigned-url, for
 * exactly the requested pathname under inspo/, with the inspo content types, the 100 MB limit, 15 minutes of validity
 * and Blob's random suffix, using whichever Blob credential is set (the read-write token when there is one, OIDC with
 * BLOB_STORE_ID otherwise). Sign-in and the guest limits are as before. Auth, the rate-limit store and the Blob API's
 * issueSignedToken are faked; the presigning itself is @vercel/blob's own.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/pipeline/__tests__/inspo-upload.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { INSPO_CONTENT_TYPES, MAX_REFERENCE_BYTES } from "@/lib/pipeline/references";

/** A stand-in for BLOB_READ_WRITE_TOKEN, not a real one. */
const FAKE_RW_TOKEN = "vercel_blob_rw_teststore_notarealtoken";
const FAKE_STORE_ID = "store_teststore";
/** Stand-in for the per-issuance signing key the Blob API returns. Not a real one. */
const FAKE_SIGNING_KEY = "test-client-signing-key";
const MIN = 60_000;

class FakeAuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message);
  }
}

type User = { id: string; email: string; isAdmin: boolean; openAccess?: boolean };

const canMock = typeof (mock as { module?: unknown }).module === "function";
const savedEnv = { ...process.env };
let user: User | null = { id: "u1", email: "u@x", isAdmin: false };
let hits: Record<string, number> = {};
let rateKeys: string[][] = [];
let issued: Array<Record<string, unknown>> = [];
let issueImpl: ((opts: Record<string, unknown>) => Promise<unknown>) | null = null;
let blob: typeof import("@vercel/blob");
let POST: (req: Request) => Promise<Response>;

const b64url = (s: string) => Buffer.from(s).toString("base64url");

/** What the Blob API's POST /signed-token answers: a delegation whose payload carries the scope it was asked for. */
async function fakeIssue(opts: Record<string, unknown>) {
  issued.push(opts);
  if (issueImpl) return issueImpl(opts);
  const scope = {
    storeId: "teststore",
    pathname: opts.pathname,
    operations: opts.operations,
    validUntil: opts.validUntil,
    allowedContentTypes: opts.allowedContentTypes,
    maximumSizeInBytes: opts.maximumSizeInBytes,
  };
  return { delegationToken: `${b64url(JSON.stringify(scope))}.sig`, clientSigningToken: FAKE_SIGNING_KEY, validUntil: opts.validUntil };
}

const presignEvent = (pathname: unknown, type = "blob.generate-presigned-url") => ({
  type,
  payload: { pathname, multipart: false, clientPayload: null },
});

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://muse.example.com/api/inspirations/upload", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** The signature @vercel/blob's presign computes, so the test can tell the URL is bound to the pathname and options. */
function expectedSignature(pathname: string, params: Record<string, string>): string {
  const lines = [`operation=put`, `pathname=${pathname}`, ...Object.entries(params).map(([k, v]) => `${k}=${v}`)];
  lines.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return createHmac("sha256", FAKE_SIGNING_KEY).update(lines.join("\n")).digest("base64url");
}

describe("inspo upload route", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    blob = await import("@vercel/blob");
    mock.module("@vercel/blob", { namedExports: { ...blob, issueSignedToken: fakeIssue } });
    mock.module(new URL("../../auth.ts", import.meta.url).href, {
      namedExports: {
        AuthError: FakeAuthError,
        requireUser: async () => {
          if (!user) throw new FakeAuthError("signed_out", 401);
          return user;
        },
      },
    });
    mock.module(new URL("../../gateway/store.ts", import.meta.url).href, {
      namedExports: {
        hitRateLimits: async (keys: string[], windowStart: Date) => {
          rateKeys.push([...keys, windowStart.toISOString()]);
          return Object.fromEntries(keys.map((k) => [k, (hits[k] = (hits[k] ?? 0) + 1)]));
        },
      },
    });
    ({ POST } = await import(new URL("../../../app/api/inspirations/upload/route.ts", import.meta.url).href));
  });

  after(() => {
    mock.restoreAll();
    process.env = savedEnv;
  });

  beforeEach(() => {
    user = { id: "u1", email: "u@x", isAdmin: false };
    hits = {};
    rateKeys = [];
    issued = [];
    issueImpl = null;
    process.env.BLOB_STORE_ID = FAKE_STORE_ID;
    process.env.VERCEL = "1";
    delete process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.BLOB_WEBHOOK_PUBLIC_KEY;
  });

  it("issues a presigned PUT for exactly the requested inspo/ pathname, with the inspo limits and a random suffix", async () => {
    const pathname = "inspo/0b6f2a8e-1c1d-4e5f-9a7b-1234567890ab-photo.png";
    const before = Date.now();
    const res = await POST(post(presignEvent(pathname)));
    const afterMs = Date.now();
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      type: string;
      presignedUrlPayload: { delegationToken: string; signature: string; params: Record<string, string> };
    };
    assert.equal(body.type, "blob.generate-presigned-url");

    // The delegation the Blob API was asked for: one pathname, put only, the inspo limits, 15 minutes.
    assert.equal(issued.length, 1);
    const asked = issued[0]!;
    assert.equal(asked.pathname, pathname);
    assert.deepEqual(asked.operations, ["put"]);
    assert.deepEqual(asked.allowedContentTypes, [...INSPO_CONTENT_TYPES]);
    assert.equal(asked.maximumSizeInBytes, MAX_REFERENCE_BYTES);
    const validUntil = asked.validUntil as number;
    assert.ok(validUntil >= before + 15 * MIN && validUntil <= afterMs + 15 * MIN, String(validUntil - before));
    assert.equal("token" in asked, false, "BLOB_STORE_ID only: no token, so @vercel/blob signs in with OIDC");

    // The presigned URL repeats the limits, turns on the random suffix, asks for no callback, and is signed for them.
    const { delegationToken, signature, params } = body.presignedUrlPayload;
    assert.equal(delegationToken.split(".")[0], b64url(JSON.stringify({
      storeId: "teststore",
      pathname,
      operations: ["put"],
      validUntil,
      allowedContentTypes: [...INSPO_CONTENT_TYPES],
      maximumSizeInBytes: MAX_REFERENCE_BYTES,
    })));
    assert.deepEqual(params, {
      "vercel-blob-allowed-content-types": [...INSPO_CONTENT_TYPES].sort().join(","),
      "vercel-blob-maximum-size-in-bytes": String(MAX_REFERENCE_BYTES),
      "vercel-blob-add-random-suffix": "true",
    });
    assert.equal(signature, expectedSignature(pathname, params));
    assert.notEqual(signature, expectedSignature("inspo/other.png", params), "the signature covers the pathname");
  });

  it("uses BLOB_READ_WRITE_TOKEN when it is set, with no webhook key needed", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = FAKE_RW_TOKEN;
    delete process.env.BLOB_STORE_ID;
    const res = await POST(post(presignEvent("inspo/a-clip.mp4")));
    assert.equal(res.status, 200);
    assert.equal(issued[0]!.token, FAKE_RW_TOKEN);

    process.env.BLOB_STORE_ID = FAKE_STORE_ID;
    await POST(post(presignEvent("inspo/b-clip.mp4")));
    assert.equal(issued[1]!.token, FAKE_RW_TOKEN, "the read-write token wins when both are set");
  });

  it("refuses pathnames outside inspo/ before asking Blob for anything", async () => {
    for (const pathname of ["uploads/a.png", "inspo/", "inspo/../uploads/a.png", "inspo//a.png", "inspo\\a.png", "screens/a.png", `inspo/${"a".repeat(300)}`]) {
      const res = await POST(post(presignEvent(pathname)));
      assert.equal(res.status, 400, pathname);
      assert.deepEqual(await res.json(), { error: "Inspo uploads must go under inspo/." });
    }
    assert.equal(issued.length, 0);
  });

  it("takes only a presigned URL request: no client tokens, no callbacks, no junk", async () => {
    const bodies = [
      presignEvent("inspo/a.png", "blob.generate-client-token"),
      { type: "blob.upload-completed", payload: { blob: { pathname: "inspo/a.png" } } },
      { type: "blob.generate-presigned-url" },
      presignEvent(42),
      "null",
      "{nope",
    ];
    for (const body of bodies) assert.equal((await POST(post(body))).status, 400, JSON.stringify(body));
    assert.equal(issued.length, 0);
  });

  it("503 uploads_unavailable with neither credential", async () => {
    delete process.env.BLOB_STORE_ID;
    const res = await POST(post(presignEvent("inspo/a.png")));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "uploads_unavailable" });
    assert.equal(issued.length, 0);
  });

  it("401 when signed out", async () => {
    user = null;
    const res = await POST(post(presignEvent("inspo/a.png")));
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "signed_out" });
    assert.equal(issued.length, 0);
  });

  it("limits the shared guest to 30 URLs per IP per hour, and nobody else", async () => {
    user = { id: "guest", email: "g@x", isAdmin: false, openAccess: true };
    const headers = { "x-real-ip": "203.0.113.7" };
    for (let i = 0; i < 30; i++) assert.equal((await POST(post(presignEvent(`inspo/${i}.png`), headers))).status, 200);
    const over = await POST(post(presignEvent("inspo/31.png"), headers));
    assert.equal(over.status, 429);
    assert.deepEqual(await over.json(), { error: "upload_limit" });
    assert.equal(issued.length, 30, "no URL past the limit");
    assert.deepEqual(rateKeys[0]!.slice(0, 2), ["inspo-guest:ip:203.0.113.7", "inspo-guest:all"]);

    // The site-wide guest limit.
    hits = { "inspo-guest:all": 300 };
    assert.equal((await POST(post(presignEvent("inspo/x.png"), { "x-real-ip": "198.51.100.1" }))).status, 429);

    // Admin open access and signed-in users aren't counted.
    rateKeys = [];
    user = { id: "admin", email: "a@x", isAdmin: true, openAccess: true };
    assert.equal((await POST(post(presignEvent("inspo/y.png"), headers))).status, 200);
    user = { id: "u1", email: "u@x", isAdmin: false };
    assert.equal((await POST(post(presignEvent("inspo/z.png"), headers))).status, 200);
    assert.equal(rateKeys.length, 0);
  });

  it("503 when the store refuses to issue (bad credential, no store), 500 for anything else", async (t) => {
    t.mock.method(console, "error", () => {});
    issueImpl = async () => {
      throw new blob.BlobAccessError();
    };
    const refused = await POST(post(presignEvent("inspo/a.png")));
    assert.equal(refused.status, 503);
    assert.deepEqual(await refused.json(), { error: "uploads_unavailable" });

    issueImpl = async () => {
      throw new blob.BlobError("No blob credentials found.");
    };
    assert.equal((await POST(post(presignEvent("inspo/a.png")))).status, 503);

    issueImpl = async () => {
      throw new blob.BlobServiceNotAvailable();
    };
    const down = await POST(post(presignEvent("inspo/a.png")));
    assert.equal(down.status, 500);
    assert.deepEqual(await down.json(), { error: "upload_failed" });
  });
});
