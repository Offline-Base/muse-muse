/**
 * POST /api/admin/import-product/upload, the presigned upload route scripts/promote-local.ts uploads through. Only
 * admins and automation get a URL, never from another site, and only while this site publishes products. It answers
 * only blob.generate-presigned-url, for exactly the requested stored path: no random suffix, overwriting allowed, the
 * 200 MB limit and 15 minutes. Auth is faked with the real AuthError; the Blob API's issueSignedToken is faked; the
 * presigning itself is @vercel/blob's own.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/promote/__tests__/upload-route.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (rel: string) => new URL(rel, import.meta.url).href;
const ORIGIN = "https://muse.example.com";
const AUTOMATION = "automation-secret-for-tests";
const MIN = 60_000;
const savedEnv = { ...process.env };

let issued: Array<Record<string, unknown>> = [];
let POST: (req: Request) => Promise<Response>;

const b64url = (s: string) => Buffer.from(s).toString("base64url");

/** What the Blob API's POST /signed-token answers: a delegation whose payload carries the scope it was asked for. */
async function fakeIssue(opts: Record<string, unknown>) {
  issued.push(opts);
  const scope = { storeId: "teststore", pathname: opts.pathname, operations: opts.operations, validUntil: opts.validUntil };
  return { delegationToken: `${b64url(JSON.stringify(scope))}.sig`, clientSigningToken: "test-signing-key", validUntil: opts.validUntil };
}

const event = (pathname: unknown, type = "blob.generate-presigned-url") => ({
  type,
  payload: { pathname, multipart: false, clientPayload: null },
});

function post(body: unknown, headers: Record<string, string> = { authorization: `Bearer ${AUTOMATION}` }): Request {
  return new Request(`${ORIGIN}/api/admin/import-product/upload`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("import upload route", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    const blob = await import("@vercel/blob");
    mock.module("@vercel/blob", { namedExports: { ...blob, issueSignedToken: fakeIssue } });
    const realAuth = (await import(at("../../auth.ts"))) as typeof import("../../auth");
    mock.module(at("../../auth.ts"), {
      namedExports: {
        ...realAuth,
        requireAdminOrAutomation: async (req: Request) => {
          if (req.headers.get("authorization") === `Bearer ${AUTOMATION}`) return { id: "admin", email: "a@x", isAdmin: true };
          throw new realAuth.AuthError("Admins only.", 403);
        },
      },
    });
    ({ POST } = await import(at("../../../app/api/admin/import-product/upload/route.ts")));
  });

  after(() => {
    mock.restoreAll();
    process.env = savedEnv;
  });

  beforeEach(() => {
    issued = [];
    process.env.PLATFORM_URL = ORIGIN;
    process.env.VERCEL_TOKEN = "vercel-token-for-tests";
    process.env.BLOB_STORE_ID = "store_teststore";
    process.env.VERCEL = "1";
    delete process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.BLOB_WEBHOOK_PUBLIC_KEY;
  });

  it("signs a PUT for exactly the stored path, keeping it and allowing an overwrite", async () => {
    const pathname = "demos/2f6a2c4e-5d1b-4c3a-9e8f-0123456789ab/demo-1a2b3c4d.mp4";
    const before = Date.now();
    const res = await POST(post(event(pathname)));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { type: string; presignedUrlPayload: { params: Record<string, string> } };
    assert.equal(body.type, "blob.generate-presigned-url");
    assert.equal(issued.length, 1);
    const asked = issued[0]!;
    assert.equal(asked.pathname, pathname);
    assert.deepEqual(asked.operations, ["put"]);
    assert.equal(asked.maximumSizeInBytes, 200 * 1024 * 1024);
    const validUntil = asked.validUntil as number;
    assert.ok(validUntil >= before + 15 * MIN && validUntil <= Date.now() + 15 * MIN, String(validUntil - before));
    assert.equal("token" in asked, false, "BLOB_STORE_ID only: @vercel/blob signs in with this site's OIDC token");
    const { params } = body.presignedUrlPayload;
    assert.equal(params["vercel-blob-allow-overwrite"], "true");
    assert.notEqual(params["vercel-blob-add-random-suffix"], "true", "the stored path is kept");
    assert.equal(params["vercel-blob-maximum-size-in-bytes"], String(200 * 1024 * 1024));
  });

  it("takes every stored prefix and refuses any other path", async () => {
    for (const prefix of ["inspo", "uploads", "screens", "demos", "transcripts", "fixtures"]) {
      assert.equal((await POST(post(event(`${prefix}/a/b-1.png`)))).status, 200, prefix);
    }
    for (const bad of ["secrets/x.png", "demos/../x.png", "demos//x.png", "demos\\x.png", "demos/x.png?y=1", "/demos/x.png", "demos/", 42]) {
      const res = await POST(post(event(bad)));
      assert.equal(res.status, 400, String(bad));
    }
    assert.equal(issued.length, 6, "nothing was signed for a refused path");
  });

  it("takes a run's and a product's native files, and never a shell template", async () => {
    for (const ok of ["native/runs/r1/j1/clip.mp4", "native/products/p1/r1/bird-count.apk", "clips/p1/quest.mp4"]) {
      assert.equal((await POST(post(event(ok)))).status, 200, ok);
    }
    issued = [];
    const res = await POST(post(event("native/shells/1.0.0/shell.apk")));
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /shell template/);
    assert.equal(issued.length, 0, "nothing was signed");
  });

  it("answers only admins and automation, and never another site", async () => {
    assert.equal((await POST(post(event("demos/x.mp4"), {}))).status, 403);
    assert.equal((await POST(post(event("demos/x.mp4"), { authorization: "Bearer wrong" }))).status, 403);
    const cross = await POST(post(event("demos/x.mp4"), { authorization: `Bearer ${AUTOMATION}`, "sec-fetch-site": "cross-site" }));
    assert.equal(cross.status, 403);
    assert.deepEqual(await cross.json(), { error: "cross_site" });
    assert.equal(issued.length, 0);
  });

  it("refuses other events, and signs nothing while this site doesn't publish", async () => {
    assert.equal((await POST(post(event("demos/x.mp4", "blob.upload-completed")))).status, 400);
    delete process.env.VERCEL_TOKEN;
    const off = await POST(post(event("demos/x.mp4")));
    assert.equal(off.status, 503);
    assert.deepEqual(await off.json(), { error: "publish_off", reason: "VERCEL_TOKEN isn't set" });
    assert.equal(issued.length, 0);
  });
});
