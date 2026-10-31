/**
 * Presigned uploads for promoting a local run's files (scripts/promote-local.ts, POST
 * /api/admin/import-product/upload). A local run can't sign in to the live store itself: the CLI's OIDC token is for
 * the development environment, which the store isn't connected to. So the live site, signed in with its own Blob
 * credential (lib/storage.ts blobAuth), hands the script a presigned URL for exactly one stored path, and the script
 * PUTs the file straight to Vercel Blob, past the 4.5 MB function body limit. The route lets only admins and
 * automation ask. Nothing secret reaches the script: it gets a delegation scoped to one pathname and an HMAC over the
 * upload options, as the browser does for inspo (lib/pipeline/inspo-upload.ts).
 */
import { issueSignedToken, type IssuedSignedToken } from "@vercel/blob";
import { handleUploadPresigned, type GeneratePresignedUrlEvent } from "@vercel/blob/client";
import { isSafeFileKey, STORED_PREFIXES } from "@/lib/local-files";
import { NO_CALLBACK_KEY } from "@/lib/pipeline/inspo-upload";
import { blobAuth } from "@/lib/storage";

/** A presigned upload URL, and the delegation behind it, is good for this long. */
export const IMPORT_UPLOAD_TTL_MS = 15 * 60_000;

/** The biggest file a local run's rows point at. Demo videos and Muse Code transcripts stay far under it. */
export const IMPORT_UPLOAD_MAX_BYTES = 200 * 1024 * 1024;

/** The paths the platform stores files under (lib/storage.ts BlobPrefix), as the rows name them. */
const STORED_KEY = new RegExp(`^(?:${STORED_PREFIXES.join("|")})/[^?#]+$`);
const STORED_FOLDERS = `${STORED_PREFIXES.slice(0, -1).map((p) => `${p}/`).join(", ")} or ${STORED_PREFIXES.at(-1)}/`;

export class ImportPathnameError extends Error {}

/** Why `pathname` can't take a promoted file, or null. The script asks for the key the local run stored it under. */
export function checkImportPathname(pathname: unknown): string | null {
  if (typeof pathname !== "string" || pathname.length > 300 || !STORED_KEY.test(pathname) || !isSafeFileKey(pathname)) {
    return `Uploads must go to a stored file's path under ${STORED_FOLDERS}.`;
  }
  return null;
}

/**
 * handleUploadPresigned's getSignedToken for a promoted file: a delegation for `put` on exactly `pathname`, up to
 * IMPORT_UPLOAD_MAX_BYTES and good for IMPORT_UPLOAD_TTL_MS. The file keeps its stored path (no random suffix) so a
 * path with a build id in it stays that build's, and replaces whatever is there, so a retried run can upload again.
 */
export async function importSignedToken(
  pathname: string,
  now = Date.now(),
): Promise<{
  token: IssuedSignedToken;
  urlOptions: { maximumSizeInBytes: number; addRandomSuffix: false; allowOverwrite: true };
}> {
  const problem = checkImportPathname(pathname);
  if (problem) throw new ImportPathnameError(problem);
  const token = await issueSignedToken({
    pathname,
    operations: ["put"],
    validUntil: now + IMPORT_UPLOAD_TTL_MS,
    maximumSizeInBytes: IMPORT_UPLOAD_MAX_BYTES,
    ...blobAuth(),
  });
  return { token, urlOptions: { maximumSizeInBytes: IMPORT_UPLOAD_MAX_BYTES, addRandomSuffix: false, allowOverwrite: true } };
}

/**
 * The route's reply to a blob.generate-presigned-url event: `{ type, presignedUrlPayload }` for the event's pathname.
 * Throws ImportPathnameError for a pathname outside the stored prefixes, and Blob's errors when the store refuses.
 */
export async function presignImportUpload(
  body: GeneratePresignedUrlEvent,
  request: Request,
): ReturnType<typeof handleUploadPresigned> {
  return handleUploadPresigned({
    body,
    request,
    webhookPublicKey: process.env.BLOB_WEBHOOK_PUBLIC_KEY || NO_CALLBACK_KEY,
    getSignedToken: (pathname) => importSignedToken(pathname),
  });
}
