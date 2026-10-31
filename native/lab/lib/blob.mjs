// Uploads through the slots the platform hands out (docs/NATIVE_LAB.md, "Upload"). No dependencies: this speaks the same
// wire protocol as uploadPresigned from @vercel/blob/client 2.8.2, single requests and multipart.
// __tests__/blob.test.mjs runs the real SDK against a local server and checks this sends the same requests.
import { randomBytes } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import { sleep } from "./proc.mjs";

export const BLOB_API_URL = "https://vercel.com/api/blob";
export const BLOB_API_VERSION = "13";
export const PART_BYTES = 8 * 1024 * 1024;

const PART_CONCURRENCY = 3;
const ATTEMPTS = 4;

export class BlobUploadError extends Error {}

function fromBase64Url(segment) {
  return Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

/** The store id a delegation token names. The Blob API wants it in a header. */
export function storeIdOf(delegationToken) {
  const dot = String(delegationToken).indexOf(".");
  if (dot < 0) throw new BlobUploadError("The upload slot's delegation token isn't valid.");
  let payload;
  try {
    payload = JSON.parse(fromBase64Url(delegationToken.slice(0, dot)));
  } catch {
    throw new BlobUploadError("The upload slot's delegation token isn't valid.");
  }
  if (typeof payload?.storeId !== "string" || !payload.storeId) {
    throw new BlobUploadError("The upload slot's delegation token names no store.");
  }
  return payload.storeId.startsWith("store_") ? payload.storeId.slice("store_".length) : payload.storeId;
}

/** The Blob API URL for a pathname, with the presigned parameters added the way the SDK adds them. */
export function presignedRequestUrl(apiUrl, route, pathname, payload) {
  const url = new URL(`${apiUrl}${route}?${new URLSearchParams({ pathname }).toString()}`);
  for (const [key, value] of Object.entries(payload.params ?? {})) url.searchParams.set(key, value);
  url.searchParams.set("vercel-blob-delegation", payload.delegationToken);
  url.searchParams.set("vercel-blob-signature", payload.signature);
  return url.toString();
}

/** Headers every Blob request carries, plus the put options the SDK turns into headers. */
export function blobHeaders(payload, { contentType, attempt, requestId, extra = {} }) {
  return {
    "x-api-blob-request-id": requestId,
    "x-vercel-blob-store-id": storeIdOf(payload.delegationToken),
    "x-api-blob-request-attempt": String(attempt),
    "x-api-version": BLOB_API_VERSION,
    "x-vercel-blob-access": "public",
    "x-content-type": contentType,
    ...extra,
  };
}

/** The part numbers and byte ranges of a file. */
export function partsOf(bytes, partBytes = PART_BYTES) {
  const parts = [];
  for (let offset = 0, partNumber = 1; offset < bytes; offset += partBytes, partNumber++) {
    parts.push({ partNumber, offset, length: Math.min(partBytes, bytes - offset) });
  }
  return parts;
}

async function request(doFetch, url, init, { signal, label }) {
  let last = null;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new BlobUploadError(`${label}: stopped.`);
    try {
      const headers = typeof init.headers === "function" ? init.headers(attempt) : init.headers;
      const res = await doFetch(url, { ...init, headers, signal });
      if (res.ok) return res;
      const body = await res.text().catch(() => "");
      last = new BlobUploadError(`${label}: Blob answered ${res.status}. ${blobErrorCode(body)}`.trim());
      if (res.status < 500 && res.status !== 429) throw Object.assign(last, { final: true });
    } catch (err) {
      if (err?.final) throw err;
      last = err instanceof BlobUploadError ? err : new BlobUploadError(`${label}: ${err?.message ?? "the request failed"}.`);
    }
    await sleep(500 * 2 ** attempt, signal);
  }
  throw last ?? new BlobUploadError(`${label}: the request failed.`);
}

function blobErrorCode(body) {
  try {
    const code = JSON.parse(body)?.error?.code;
    return typeof code === "string" ? `Code: ${code}.` : "";
  } catch {
    return "";
  }
}

async function json(res, label) {
  try {
    return await res.json();
  } catch {
    throw new BlobUploadError(`${label}: Blob's answer wasn't JSON.`);
  }
}

async function uploadSingle(slot, filePath, contentType, { fetch: doFetch, signal, apiUrl }) {
  const payload = slot.presignedUrlPayload;
  const requestId = `${storeIdOf(payload.delegationToken)}:${Date.now()}:${randomBytes(6).toString("hex")}`;
  const res = await request(
    doFetch,
    presignedRequestUrl(apiUrl, "/", slot.pathname, payload),
    {
      method: "PUT",
      headers: (attempt) => blobHeaders(payload, { contentType, attempt, requestId }),
      body: await readFile(filePath),
    },
    { signal, label: slot.name },
  );
  return json(res, slot.name);
}

async function uploadMultipart(slot, filePath, contentType, bytes, { fetch: doFetch, signal, apiUrl }) {
  const payload = slot.presignedUrlPayload;
  const label = slot.name;
  const url = presignedRequestUrl(apiUrl, "/mpu", slot.pathname, payload);
  const storeId = storeIdOf(payload.delegationToken);
  const headersFor = (extra) => (attempt) =>
    blobHeaders(payload, {
      contentType,
      attempt,
      requestId: `${storeId}:${Date.now()}:${randomBytes(6).toString("hex")}`,
      extra,
    });

  const created = await json(
    await request(doFetch, url, { method: "POST", headers: headersFor({ "x-mpu-action": "create" }) }, { signal, label }),
    label,
  );
  const { key, uploadId } = created;
  if (!key || !uploadId) throw new BlobUploadError(`${label}: Blob didn't open a multipart upload.`);

  const file = await open(filePath, "r");
  try {
    const queue = partsOf(bytes, slot.partBytes ?? PART_BYTES);
    const done = [];
    const worker = async () => {
      for (let part = queue.shift(); part; part = queue.shift()) {
        const buffer = Buffer.alloc(part.length);
        await file.read(buffer, 0, part.length, part.offset);
        const res = await request(
          doFetch,
          url,
          {
            method: "POST",
            headers: headersFor({
              "x-mpu-action": "upload",
              "x-mpu-key": encodeURIComponent(key),
              "x-mpu-upload-id": uploadId,
              "x-mpu-part-number": String(part.partNumber),
            }),
            body: buffer,
          },
          { signal, label: `${label} part ${part.partNumber}` },
        );
        const { etag } = await json(res, label);
        done.push({ etag, partNumber: part.partNumber });
      }
    };
    await Promise.all(Array.from({ length: PART_CONCURRENCY }, worker));
    done.sort((a, b) => a.partNumber - b.partNumber);
    const completed = await request(
      doFetch,
      url,
      {
        method: "POST",
        headers: headersFor({
          "content-type": "application/json",
          "x-mpu-action": "complete",
          "x-mpu-upload-id": uploadId,
          "x-mpu-key": encodeURIComponent(key),
        }),
        body: JSON.stringify(done),
      },
      { signal, label },
    );
    return await json(completed, label);
  } finally {
    await file.close();
  }
}

/** A plain PUT slot, for local runs of the platform, which has no Blob store. */
async function uploadPlain(slot, filePath, contentType, { fetch: doFetch, signal }) {
  const res = await request(
    doFetch,
    slot.url,
    {
      method: "PUT",
      headers: { "content-type": contentType, ...(slot.headers ?? {}) },
      body: await readFile(filePath),
    },
    { signal, label: slot.name },
  );
  return json(res, slot.name);
}

/**
 * Uploads one file through its slot and returns where it landed.
 *
 * @param {object} slot one entry of the upload route's `uploads`
 * @param {string} filePath
 * @param {string} contentType
 * @param {{ fetch?: typeof fetch, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ url: string, pathname: string }>}
 */
export async function uploadThroughSlot(slot, filePath, contentType, { fetch: doFetch = fetch, signal } = {}) {
  const { size } = await stat(filePath);
  const apiUrl = slot.apiUrl ?? BLOB_API_URL;
  let reply;
  if (slot.method === "put") reply = await uploadPlain(slot, filePath, contentType, { fetch: doFetch, signal });
  else if (slot.method !== "blob") throw new BlobUploadError(`${slot.name}: unknown upload method ${slot.method}.`);
  else if (slot.multipart) reply = await uploadMultipart(slot, filePath, contentType, size, { fetch: doFetch, signal, apiUrl });
  else reply = await uploadSingle(slot, filePath, contentType, { fetch: doFetch, signal, apiUrl });
  if (typeof reply?.url !== "string") throw new BlobUploadError(`${slot.name}: Blob's answer named no URL.`);
  return { url: reply.url, pathname: reply.pathname ?? slot.pathname };
}
