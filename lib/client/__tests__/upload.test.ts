/**
 * The browser side of inspo uploads (lib/client/upload.ts): uploadPresigned to "inspo/<uuid>-<safe name>" with the
 * upload route as handleUploadUrl and nothing the server signs (no addRandomSuffix or allowOverwrite), progress as
 * whole percents, multipart from 8 MB, and the route's 401/429/503 turned into the right sentence. @vercel/blob/client
 * and fetch are faked.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/client/__tests__/upload.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import type { PreparedFile } from "@/lib/client/prepare";

type UploadCall = { pathname: string; body: unknown; options: Record<string, unknown> };

const canMock = typeof (mock as { module?: unknown }).module === "function";
const realFetch = globalThis.fetch;
const savedLocal = process.env.NEXT_PUBLIC_LOCAL_FILES;
let uploads: UploadCall[] = [];
let uploadImpl: (call: UploadCall) => Promise<unknown> = async () => ({});
let probes: Array<{ url: string; body: unknown }> = [];
let probeAnswer: { status: number; body: unknown } = { status: 200, body: {} };
let client: typeof import("@/lib/client/upload");

function file(size = 3, name = "My Photo (1).PNG"): PreparedFile {
  return { blob: new Blob([new Uint8Array(size)], { type: "image/png" }), fileName: name, contentType: "image/png", kind: "image" };
}

/** What @vercel/blob/client throws when the upload route answers anything but 2xx. */
const routeRefused = () => new Error("Vercel Blob: Failed to retrieve the presigned URL");

describe("uploadInspo", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    mock.module("@vercel/blob/client", {
      namedExports: {
        uploadPresigned: async (pathname: string, body: unknown, options: Record<string, unknown>) => {
          const call = { pathname, body, options };
          uploads.push(call);
          return uploadImpl(call);
        },
      },
    });
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      probes.push({ url: String(url), body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body });
      return Response.json(probeAnswer.body, { status: probeAnswer.status });
    }) as typeof fetch;
    client = await import("@/lib/client/upload");
  });

  after(() => {
    mock.restoreAll();
    globalThis.fetch = realFetch;
    if (savedLocal === undefined) delete process.env.NEXT_PUBLIC_LOCAL_FILES;
    else process.env.NEXT_PUBLIC_LOCAL_FILES = savedLocal;
  });

  beforeEach(() => {
    uploads = [];
    probes = [];
    probeAnswer = { status: 200, body: {} };
    delete process.env.NEXT_PUBLIC_LOCAL_FILES;
    uploadImpl = async ({ pathname, options }) => {
      const progress = options.onUploadProgress as ((e: { percentage: number }) => void) | undefined;
      progress?.({ percentage: 33.4 });
      progress?.({ percentage: 100 });
      return { url: `https://teststore.public.blob.vercel-storage.com/${pathname.replace(".png", "-Ab12Cd.png")}` };
    };
  });

  it("uploads with uploadPresigned to inspo/<uuid>-<safe name>, leaving the suffix and overwrite rules to the server", async () => {
    const seen: number[] = [];
    const ref = await client.uploadInspo(file(), { onProgress: (p) => seen.push(p) });
    assert.equal(uploads.length, 1);
    const { pathname, options } = uploads[0]!;
    assert.match(pathname, /^inspo\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}-My-Photo-1\.png$/);
    assert.equal(options.access, "public");
    assert.equal(options.handleUploadUrl, "/api/inspirations/upload");
    assert.equal(options.contentType, "image/png");
    assert.equal(options.multipart, false);
    for (const key of ["addRandomSuffix", "allowOverwrite", "cacheControlMaxAge", "ifMatch", "token"]) {
      assert.equal(key in options, false, `${key} is the server's to set`);
    }
    assert.deepEqual(seen, [33, 100]);
    assert.deepEqual(ref, {
      url: `https://teststore.public.blob.vercel-storage.com/${pathname.replace(".png", "-Ab12Cd.png")}`,
      kind: "image",
      fileName: "My Photo (1).PNG",
      contentType: "image/png",
      size: 3,
    });
    assert.equal(probes.length, 0);
  });

  it("goes multipart from 8 MB", async () => {
    await client.uploadInspo(file(8 * 1024 * 1024 - 1));
    await client.uploadInspo(file(8 * 1024 * 1024));
    assert.deepEqual(uploads.map((u) => u.options.multipart), [false, true]);
  });

  it("asks the route why it refused, and says so: 401, 429, 503", async () => {
    uploadImpl = async () => {
      throw routeRefused();
    };
    const cases: Array<[number, unknown, RegExp]> = [
      [401, { error: "signed_out" }, /Sign in again/],
      [429, { error: "upload_limit" }, /Too many uploads/],
      [503, { error: "uploads_unavailable" }, /aren't set up/],
      [500, { error: "upload_failed" }, /Check your connection/],
    ];
    for (const [status, body, message] of cases) {
      probes = [];
      probeAnswer = { status, body };
      await assert.rejects(client.uploadInspo(file()), (err: unknown) => {
        assert.ok(err instanceof client.UploadError);
        assert.match(err.message, message);
        return true;
      });
      assert.equal(probes.length, 1);
      assert.equal(probes[0]!.url, "/api/inspirations/upload");
      const probe = probes[0]!.body as { type: string; payload: { pathname: string } };
      assert.equal(probe.type, "blob.generate-presigned-url", "the probe speaks the presigned protocol");
      assert.equal(probe.payload.pathname, uploads.at(-1)!.pathname, "for the same pathname");
    }
  });

  it("a failed PUT to Blob is a connection message, without asking the route", async () => {
    uploadImpl = async () => {
      throw new Error("Vercel Blob: Content type mismatch, image/png is not allowed.");
    };
    await assert.rejects(client.uploadInspo(file()), /Check your connection/);
    assert.equal(probes.length, 0);
  });

  it("rethrows as is when the caller aborted", async () => {
    const controller = new AbortController();
    const abort = new Error("The request was aborted.");
    uploadImpl = async () => {
      controller.abort();
      throw abort;
    };
    await assert.rejects(client.uploadInspo(file(), { signal: controller.signal }), (err) => err === abort);
  });

  it("local runs post to /api/files/upload instead", async () => {
    process.env.NEXT_PUBLIC_LOCAL_FILES = "1";
    probeAnswer = { status: 200, body: { url: "http://localhost:3000/api/files/inspo/x.png" } };
    const ref = await client.uploadInspo(file());
    assert.equal(ref.url, "http://localhost:3000/api/files/inspo/x.png");
    assert.equal(uploads.length, 0);
    assert.equal(probes[0]!.url, "/api/files/upload");
    assert.match(String((probes[0]!.body as FormData).get("pathname")), /^inspo\/[0-9a-f-]{36}-My-Photo-1\.png$/);
  });

  it("uploadFailureMessage maps the route's answers", () => {
    assert.match(client.uploadFailureMessage(401, "signed_out"), /Sign in again/);
    assert.match(client.uploadFailureMessage(429, "upload_limit"), /Too many uploads/);
    assert.match(client.uploadFailureMessage(503, "uploads_unavailable"), /aren't set up/);
    assert.match(client.uploadFailureMessage(500, "upload_failed"), /Check your connection/);
    assert.match(client.uploadFailureMessage(400, "Inspo uploads must go under inspo/."), /Check your connection/);
  });
});
