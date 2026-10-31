/**
 * Presigned browser uploads for inspo (POST /api/inspirations/upload). The browser's uploadPresigned (lib/client/
 * upload.ts) asks the route for a presigned URL, then PUTs the file straight to Vercel Blob, so the 4.5 MB function
 * body limit doesn't apply. Issuing the URL needs a Blob credential on the server, either one: BLOB_READ_WRITE_TOKEN,
 * or BLOB_STORE_ID with the deployment's OIDC token (lib/storage.ts blobAuth). Nothing secret reaches the browser: it
 * gets a delegation scoped to one pathname and an HMAC over the upload options.
 */
import {
  BlobAccessError,
  BlobStoreNotFoundError,
  BlobStoreSuspendedError,
  issueSignedToken,
  type IssuedSignedToken,
} from "@vercel/blob";
import { handleUploadPresigned, type GeneratePresignedUrlEvent } from "@vercel/blob/client";
import { INSPO_CONTENT_TYPES, MAX_REFERENCE_BYTES } from "@/lib/pipeline/references";
import { blobAuth } from "@/lib/storage";

/** A presigned inspo upload URL, and the delegation behind it, is good for this long. */
export const INSPO_UPLOAD_TTL_MS = 15 * 60_000;

/**
 * handleUploadPresigned won't run without a webhook public key, even to issue a URL. Inspo asks Blob for no completion
 * callback and the route takes only blob.generate-presigned-url, so a store with no BLOB_WEBHOOK_PUBLIC_KEY (one
 * connected with BLOB_READ_WRITE_TOKEN) gets this stand-in. It isn't a key: no signature verifies against it.
 */
export const NO_CALLBACK_KEY = "none";

export class InspoPathnameError extends Error {}

/** Why `pathname` can't take an inspo upload, or null. uploadInspo asks for "inspo/<uuid>-<safe name>". */
export function checkInspoPathname(pathname: unknown): string | null {
  if (
    typeof pathname !== "string" ||
    !pathname.startsWith("inspo/") ||
    pathname.length <= "inspo/".length ||
    pathname.length > 300 ||
    pathname.includes("..") ||
    pathname.includes("//") ||
    pathname.includes("\\")
  ) {
    return "Inspo uploads must go under inspo/.";
  }
  return null;
}

/** A blob.generate-presigned-url event with a string pathname. The only body the route takes. */
export function isPresignedUrlEvent(body: unknown): body is GeneratePresignedUrlEvent {
  if (!body || typeof body !== "object") return false;
  const { type, payload } = body as { type?: unknown; payload?: { pathname?: unknown } | null };
  return type === "blob.generate-presigned-url" && !!payload && typeof payload === "object" && typeof payload.pathname === "string";
}

/**
 * handleUploadPresigned's getSignedToken for inspo: a delegation from the Blob API (POST /signed-token, with whichever
 * credential is set) for `put` on exactly `pathname`, limited to INSPO_CONTENT_TYPES and MAX_REFERENCE_BYTES and good
 * for INSPO_UPLOAD_TTL_MS. The URL options repeat the limits (the presigned URL signs them too) and turn on the random
 * suffix, which a presigned upload can only get from the server. The uuid uploadInspo puts in the pathname keeps
 * uploads from colliding even without it.
 */
export async function inspoSignedToken(
  pathname: string,
  now = Date.now(),
): Promise<{
  token: IssuedSignedToken;
  urlOptions: { allowedContentTypes: string[]; maximumSizeInBytes: number; addRandomSuffix: true };
}> {
  const problem = checkInspoPathname(pathname);
  if (problem) throw new InspoPathnameError(problem);
  const limits = { allowedContentTypes: [...INSPO_CONTENT_TYPES], maximumSizeInBytes: MAX_REFERENCE_BYTES };
  const token = await issueSignedToken({
    pathname,
    operations: ["put"],
    validUntil: now + INSPO_UPLOAD_TTL_MS,
    ...limits,
    ...blobAuth(),
  });
  return { token, urlOptions: { ...limits, addRandomSuffix: true } };
}

/**
 * The route's reply to a blob.generate-presigned-url event: `{ type, presignedUrlPayload }` for the event's pathname.
 * Throws InspoPathnameError for a pathname outside inspo/, and Blob's errors when the store refuses.
 */
export async function presignInspoUpload(
  body: GeneratePresignedUrlEvent,
  request: Request,
): ReturnType<typeof handleUploadPresigned> {
  return handleUploadPresigned({
    body,
    request,
    webhookPublicKey: process.env.BLOB_WEBHOOK_PUBLIC_KEY || NO_CALLBACK_KEY,
    getSignedToken: (pathname) => inspoSignedToken(pathname),
  });
}

/**
 * True for errors that mean this deployment's Blob store can't issue uploads at all (no credential @vercel/blob can
 * use, a refused or expired one, a missing or suspended store), as opposed to a passing failure.
 */
export function storageNotSetUp(err: unknown): boolean {
  if (err instanceof BlobAccessError || err instanceof BlobStoreNotFoundError || err instanceof BlobStoreSuspendedError) {
    return true;
  }
  const message = err instanceof Error ? err.message : "";
  return /No Blob store|No blob credentials|OIDC/i.test(message);
}
