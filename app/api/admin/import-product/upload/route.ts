import { isCrossSite, requireAdminOrAutomation } from "@/lib/auth";
import { env } from "@/lib/env";
import { errorJson, readJson, route } from "@/lib/http";
import { isPresignedUrlEvent, storageNotSetUp } from "@/lib/pipeline/inspo-upload";
import { ImportPathnameError, presignImportUpload } from "@/lib/promote/upload";

/**
 * The Vercel Blob presigned-upload protocol for promoting a local run's files (lib/promote/upload.ts). Takes
 * {type: "blob.generate-presigned-url", payload: {pathname, ...}} and answers {type, presignedUrlPayload} for exactly
 * that pathname, which must be a stored file's path. Admins or automation only (scripts/promote-local.ts sends the
 * automation secret), never from another site (403 cross_site). No completion callback is requested, so no other event
 * is taken.
 *
 * 400 bad body or pathname, 401 or 403 for anyone else, 503 {error: "publish_off", reason} while this site doesn't
 * publish products (a promoted product couldn't be published, so its files would only sit in the store), 503
 * {error: "uploads_unavailable"} when the store can't issue, 500 anything else.
 */
export const POST = route(async (req: Request) => {
  if (isCrossSite(req.headers)) return errorJson(403, "cross_site");
  await requireAdminOrAutomation(req);
  const off = env.publishOffReason;
  if (off) return errorJson(503, "publish_off", { reason: off });
  if (!env.blobConfigured) return errorJson(503, "uploads_unavailable");
  const body = await readJson(req);
  if (!isPresignedUrlEvent(body)) return errorJson(400, "Send a blob.generate-presigned-url event.");
  try {
    return Response.json(await presignImportUpload(body, req), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof ImportPathnameError) return errorJson(400, err.message);
    if (storageNotSetUp(err)) {
      console.error("[import upload]", err);
      return errorJson(503, "uploads_unavailable");
    }
    throw err;
  }
});
