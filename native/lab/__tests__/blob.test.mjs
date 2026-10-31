// The lab has no dependencies, so lib/blob.mjs speaks Blob's wire protocol by hand. This runs the real SDK and our client
// against one local server and compares what each sends, single requests and multipart, so an SDK change shows up here.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { uploadPresigned } from "@vercel/blob/client";
import { BLOB_API_VERSION, partsOf, presignedRequestUrl, storeIdOf, uploadThroughSlot } from "../lib/blob.mjs";

const delegationToken = `${Buffer.from(JSON.stringify({ storeId: "store_teststore123", pathname: "native/x" })).toString("base64url")}.sig`;
const PAYLOAD = { delegationToken, signature: "signature-value", params: { "vercel-blob-valid-until": "9999", "x-vercel-blob-allow-overwrite": "1" } };
const PATHNAME = "native/runs/r1/j1/file.bin";

let server;
let origin;
const seen = [];

function handleBlob(req, res, body) {
  const url = new URL(req.url, "http://x");
  seen.push({ method: req.method, route: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, bytes: body.length, body });
  const send = (o) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(o));
  };
  const action = req.headers["x-mpu-action"];
  if (action === "create") return send({ key: "key/1", uploadId: "upload-1" });
  if (action === "upload") return send({ etag: `etag-${req.headers["x-mpu-part-number"]}`, partNumber: Number(req.headers["x-mpu-part-number"]) });
  return send({
    url: `https://teststore123.public.blob.vercel-storage.com/${url.searchParams.get("pathname")}`,
    downloadUrl: "https://x/d",
    pathname: url.searchParams.get("pathname"),
    contentType: "application/octet-stream",
    contentDisposition: "inline",
  });
}

before(async () => {
  server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (req.url.startsWith("/presign")) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ type: "blob.generate-presigned-url", presignedUrlPayload: PAYLOAD }));
      }
      return handleBlob(req, res, body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  process.env.VERCEL_BLOB_API_URL = origin;
});

after(async () => {
  delete process.env.VERCEL_BLOB_API_URL;
  await new Promise((resolve) => server.close(resolve));
});

/** What must match between the SDK and us. Request ids and retry counters are random. */
function shape(request) {
  const { method, route, query, headers } = request;
  return {
    method,
    route,
    query,
    apiVersion: headers["x-api-version"],
    access: headers["x-vercel-blob-access"],
    store: headers["x-vercel-blob-store-id"],
    contentType: headers["x-content-type"],
    mpuAction: headers["x-mpu-action"] ?? null,
    mpuKey: headers["x-mpu-key"] ?? null,
    mpuUpload: headers["x-mpu-upload-id"] ?? null,
    mpuPart: headers["x-mpu-part-number"] ?? null,
    hasRequestId: typeof headers["x-api-blob-request-id"] === "string",
    hasAttempt: headers["x-api-blob-request-attempt"] !== undefined,
  };
}

const byStep = (a, b) => (a.mpuAction ?? "").localeCompare(b.mpuAction ?? "") || Number(a.mpuPart) - Number(b.mpuPart);

describe("single uploads", () => {
  test("we send what the SDK sends", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mm-blob-"));
    const file = path.join(dir, "f.bin");
    const content = Buffer.alloc(1024, 7);
    writeFileSync(file, content);

    seen.length = 0;
    await uploadPresigned(PATHNAME, content, { access: "public", contentType: "video/mp4", handleUploadUrl: `${origin}/presign` });
    assert.equal(seen.length, 1, "the SDK made one call");
    const sdk = shape(seen[0]);

    seen.length = 0;
    const placed = await uploadThroughSlot({ name: "clip.mp4", pathname: PATHNAME, method: "blob", apiUrl: origin, presignedUrlPayload: PAYLOAD }, file, "video/mp4");
    assert.equal(seen.length, 1);
    assert.deepEqual(shape(seen[0]), sdk);
    assert.equal(seen[0].bytes, content.length);
    assert.equal(placed.pathname, PATHNAME);
    assert.match(placed.url, /blob\.vercel-storage\.com/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("multipart uploads", () => {
  test("we send what the SDK sends, with the same part sizes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mm-blob-"));
    const file = path.join(dir, "f.bin");
    const content = Buffer.alloc(20 * 1024 * 1024, 9);
    writeFileSync(file, content);

    seen.length = 0;
    await uploadPresigned(PATHNAME, content, { access: "public", contentType: "application/zip", multipart: true, handleUploadUrl: `${origin}/presign` });
    const sdkSizes = seen.filter((r) => r.headers["x-mpu-action"] === "upload").map((r) => r.bytes).sort((a, b) => b - a);
    const sdk = seen.map(shape).sort(byStep);
    const sdkComplete = JSON.parse(seen.find((r) => r.headers["x-mpu-action"] === "complete").body.toString());

    seen.length = 0;
    await uploadThroughSlot({ name: "app.zip", pathname: PATHNAME, method: "blob", multipart: true, apiUrl: origin, presignedUrlPayload: PAYLOAD }, file, "application/zip");
    const ours = seen.map(shape).sort(byStep);
    assert.deepEqual(ours, sdk);
    const ourSizes = seen.filter((r) => r.headers["x-mpu-action"] === "upload").map((r) => r.bytes).sort((a, b) => b - a);
    assert.deepEqual(ourSizes, sdkSizes);
    const ourComplete = JSON.parse(seen.find((r) => r.headers["x-mpu-action"] === "complete").body.toString());
    // The SDK lists parts as they finish. Ours are in order, which every multipart service accepts.
    const byPart = (a, b) => a.partNumber - b.partNumber;
    assert.deepEqual(ourComplete, [...ourComplete].sort(byPart));
    assert.deepEqual(ourComplete.map(({ partNumber, etag }) => ({ partNumber, etag })), [...sdkComplete].sort(byPart).map(({ partNumber, etag }) => ({ partNumber, etag })));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the pieces", () => {
  test("storeIdOf strips the prefix and rejects junk", () => {
    assert.equal(storeIdOf(delegationToken), "teststore123");
    assert.throws(() => storeIdOf("nodot"));
    assert.throws(() => storeIdOf("!!!.sig"));
  });
  test("partsOf covers the file exactly", () => {
    const parts = partsOf(20, 8);
    assert.deepEqual(parts.map((p) => p.length), [8, 8, 4]);
    assert.deepEqual(parts.map((p) => p.partNumber), [1, 2, 3]);
    assert.equal(partsOf(0).length, 0);
  });
  test("the URL carries the signature", () => {
    const url = new URL(presignedRequestUrl("https://b/api", "/mpu", "a b", PAYLOAD));
    assert.equal(url.pathname, "/api/mpu");
    assert.equal(url.searchParams.get("pathname"), "a b");
    assert.equal(url.searchParams.get("vercel-blob-signature"), "signature-value");
  });
  test("the API version is pinned", () => assert.equal(BLOB_API_VERSION, "13"));
  test("a plain slot does a PUT, for a local platform", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mm-blob-"));
    const file = path.join(dir, "f.bin");
    writeFileSync(file, "abc");
    seen.length = 0;
    const placed = await uploadThroughSlot({ name: "a", pathname: "p/a", method: "put", url: `${origin}/?pathname=p/a` }, file, "text/plain");
    assert.equal(seen[0].method, "PUT");
    assert.equal(seen[0].bytes, 3);
    assert.equal(seen[0].headers["content-type"], "text/plain");
    assert.equal(placed.pathname, "p/a");
    rmSync(dir, { recursive: true, force: true });
  });
  test("an unknown method and a 4xx stop right away", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mm-blob-"));
    const file = path.join(dir, "f.bin");
    writeFileSync(file, "abc");
    await assert.rejects(uploadThroughSlot({ name: "a", method: "ftp" }, file, "text/plain"), /unknown upload method/);
    let calls = 0;
    const refuse = async () => (calls++, new Response(JSON.stringify({ error: { code: "forbidden" } }), { status: 403 }));
    await assert.rejects(uploadThroughSlot({ name: "a", pathname: "p", method: "blob", presignedUrlPayload: PAYLOAD }, file, "text/plain", { fetch: refuse }), /403.*forbidden/);
    assert.equal(calls, 1);
    rmSync(dir, { recursive: true, force: true });
  });
});
