/**
 * Blob credentials: storage works with BLOB_READ_WRITE_TOKEN (passed as `token`) or with BLOB_STORE_ID alone (no
 * `token`, so @vercel/blob signs in with OIDC), keeps public access and random suffixes in both, and every "is there
 * storage" guard counts either one. @vercel/blob, the usage table and the database are faked.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/__tests__/storage.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";

/** A stand-in for BLOB_READ_WRITE_TOKEN, not a real one. */
const FAKE_RW_TOKEN = "vercel_blob_rw_teststore_notarealtoken";
const FAKE_STORE_ID = "store_teststore";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const savedEnv = { ...process.env };
let calls: Array<{ fn: string; args: unknown[] }> = [];

let env: typeof import("@/lib/env").env;
let storage: typeof import("@/lib/storage");
let localFiles: typeof import("@/lib/local-files");
let quota: typeof import("@/lib/quota");

function setCredentials(opts: { token?: string; storeId?: string; vercel?: boolean }) {
  if (opts.token === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
  else process.env.BLOB_READ_WRITE_TOKEN = opts.token;
  if (opts.storeId === undefined) delete process.env.BLOB_STORE_ID;
  else process.env.BLOB_STORE_ID = opts.storeId;
  if (opts.vercel) process.env.VERCEL = "1";
  else delete process.env.VERCEL;
}

const ADMIN = { id: "admin-1", email: "a@x", isAdmin: true };

describe("blob credentials", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    mock.module("@vercel/blob", {
      namedExports: {
        put: async (pathname: string, _body: unknown, options: Record<string, unknown>) => {
          calls.push({ fn: "put", args: [pathname, options] });
          return { url: `https://teststore.public.blob.vercel-storage.com/${pathname}` };
        },
        list: async (options: Record<string, unknown>) => {
          calls.push({ fn: "list", args: [options] });
          return {
            blobs: [
              { url: "https://teststore.public.blob.vercel-storage.com/screens/old.png", uploadedAt: new Date("2026-10-01") },
              { url: "https://teststore.public.blob.vercel-storage.com/screens/new.png", uploadedAt: new Date("2026-10-27") },
            ],
            hasMore: false,
          };
        },
        del: async (urls: string[], options: Record<string, unknown>) => {
          calls.push({ fn: "del", args: [urls, options] });
        },
      },
    });
    mock.module(new URL("../usage.ts", import.meta.url).href, { namedExports: { platformSpendToday: async () => 0 } });
    mock.module(new URL("../db/client.ts", import.meta.url).href, {
      namedExports: {
        db: () => {
          throw new Error("no database in this test");
        },
        schema: {},
      },
    });
    ({ env } = await import("@/lib/env"));
    storage = await import("@/lib/storage");
    localFiles = await import("@/lib/local-files");
    quota = await import("@/lib/quota");
  });

  after(() => {
    mock.restoreAll();
    process.env = savedEnv;
  });

  beforeEach(() => {
    calls = [];
    process.env.PLATFORM_URL = "https://muse.example.com";
    delete process.env.DAILY_SPEND_CAP_USD;
  });

  it("reads either credential, trimmed, and says storage is configured with either", () => {
    setCredentials({ token: FAKE_RW_TOKEN });
    assert.equal(env.blobReadWriteToken, FAKE_RW_TOKEN);
    assert.equal(env.blobStoreId, undefined);
    assert.equal(env.blobConfigured, true);

    setCredentials({ storeId: FAKE_STORE_ID });
    assert.equal(env.blobReadWriteToken, undefined);
    assert.equal(env.blobStoreId, FAKE_STORE_ID);
    assert.equal(env.blobConfigured, true);

    setCredentials({ token: "  ", storeId: " " });
    assert.equal(env.blobConfigured, false, "blank values don't count");
    setCredentials({});
    assert.equal(env.blobConfigured, false);
    assert.throws(() => env.blobToken, /BLOB_READ_WRITE_TOKEN is not set/, "the read-write-only flows still require the token");
  });

  it("blobAuth passes the read-write token when set, nothing with BLOB_STORE_ID only, and throws with neither", () => {
    setCredentials({ token: FAKE_RW_TOKEN, storeId: FAKE_STORE_ID });
    assert.deepEqual(storage.blobAuth(), { token: FAKE_RW_TOKEN }, "the read-write token wins when both are set");
    setCredentials({ token: FAKE_RW_TOKEN });
    assert.deepEqual(storage.blobAuth(), { token: FAKE_RW_TOKEN });
    setCredentials({ storeId: FAKE_STORE_ID, vercel: true });
    assert.deepEqual(storage.blobAuth(), {}, "no token key at all, so @vercel/blob uses OIDC with BLOB_STORE_ID");
    setCredentials({ vercel: true });
    assert.throws(() => storage.blobAuth(), /No Blob store: set BLOB_STORE_ID/);
  });

  it("putFile: public with a random suffix in both modes, with the token only when it is set", async () => {
    setCredentials({ token: FAKE_RW_TOKEN });
    const url = await storage.putFile("screens", "b1/r1/home.png", Buffer.from("png"), "image/png");
    assert.equal(url, "https://teststore.public.blob.vercel-storage.com/screens/b1/r1/home.png");
    assert.deepEqual(calls[0], {
      fn: "put",
      args: ["screens/b1/r1/home.png", { access: "public", contentType: "image/png", addRandomSuffix: true, token: FAKE_RW_TOKEN }],
    });

    calls = [];
    setCredentials({ storeId: FAKE_STORE_ID, vercel: true });
    await storage.putFile("demos", "b1/demo.mp4", Buffer.from("mp4"), "video/mp4");
    const options = calls[0]!.args[1] as Record<string, unknown>;
    assert.deepEqual(options, { access: "public", contentType: "video/mp4", addRandomSuffix: true });
    assert.equal("token" in options, false);
  });

  it("putFile with no credential on Vercel fails clearly instead of reaching Blob", async () => {
    setCredentials({ vercel: true });
    await assert.rejects(storage.putFile("screens", "x.png", "x", "image/png"), /No Blob store/);
    assert.equal(calls.length, 0);
  });

  it("deleteOlderThan lists and deletes with the same credential choice", async () => {
    setCredentials({ storeId: FAKE_STORE_ID, vercel: true });
    assert.equal(await storage.deleteOlderThan("screens", new Date("2026-10-20")), 1);
    assert.deepEqual(calls, [
      { fn: "list", args: [{ prefix: "screens/", cursor: undefined, limit: 1000 }] },
      { fn: "del", args: [["https://teststore.public.blob.vercel-storage.com/screens/old.png"], {}] },
    ]);

    calls = [];
    setCredentials({ token: FAKE_RW_TOKEN });
    await storage.deleteOlderThan("screens", new Date("2026-10-20"));
    assert.equal((calls[0]!.args[0] as { token?: string }).token, FAKE_RW_TOKEN);
    assert.deepEqual(calls[1]!.args[1], { token: FAKE_RW_TOKEN });
  });

  it("local files only when neither credential is set outside Vercel", () => {
    setCredentials({});
    assert.equal(localFiles.localFilesEnabled(), true);
    assert.equal(localFiles.fileStorageAvailable(), true);
    setCredentials({ storeId: FAKE_STORE_ID });
    assert.equal(localFiles.localFilesEnabled(), false, "BLOB_STORE_ID means the real store, as BLOB_READ_WRITE_TOKEN does");
    assert.equal(localFiles.fileStorageAvailable(), true);
    setCredentials({ token: FAKE_RW_TOKEN });
    assert.equal(localFiles.localFilesEnabled(), false);
    setCredentials({ vercel: true });
    assert.equal(localFiles.localFilesEnabled(), false, "Vercel never keeps files on disk");
    assert.equal(localFiles.fileStorageAvailable(), false);
  });

  it("checkBuildAllowed: no_storage only when neither credential is set on Vercel", async () => {
    // The build preflight (lib/__tests__/quota-preflight.test.ts) needs a Meta key and Sandbox credentials. Fakes.
    process.env.MODEL_API_KEY = "test-value-not-a-key";
    process.env.VERCEL_OIDC_TOKEN = "header.payload.signature-not-a-token";
    setCredentials({ vercel: true });
    assert.deepEqual(await quota.checkBuildAllowed(ADMIN), { ok: false, status: 503, error: "no_storage" });
    setCredentials({ storeId: FAKE_STORE_ID, vercel: true });
    assert.deepEqual(await quota.checkBuildAllowed(ADMIN), { ok: true });
    setCredentials({ token: FAKE_RW_TOKEN, vercel: true });
    assert.deepEqual(await quota.checkBuildAllowed(ADMIN), { ok: true });
    setCredentials({});
    assert.deepEqual(await quota.checkBuildAllowed(ADMIN), { ok: true }, "a local run keeps files in .data/files");
  });
});
