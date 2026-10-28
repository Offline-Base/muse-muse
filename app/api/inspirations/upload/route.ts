import { AuthError, requireUser } from "@/lib/auth";
import { env } from "@/lib/env";
import { clientIpKey } from "@/lib/gateway/extract";
import { hitRateLimits } from "@/lib/gateway/store";
import { errorJson, errorResponse } from "@/lib/http";
import { InspoPathnameError, isPresignedUrlEvent, presignInspoUpload, storageNotSetUp } from "@/lib/pipeline/inspo-upload";

/**
 * Upload URLs per hour for the shared guest (OPEN_ACCESS=guest), per client IP and in total. Without a sign-in
 * nothing else stops a script from turning the public Blob store into free file hosting.
 */
const GUEST_UPLOADS_PER_IP_PER_HOUR = 30;
const GUEST_UPLOADS_PER_HOUR = 300;
const HOUR_MS = 3_600_000;

/** Counts one guest URL request and says whether it's within both limits. Vercel sets x-real-ip to the client. */
async function guestUploadAllowed(req: Request): Promise<boolean> {
  const ip = clientIpKey(req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")) ?? "unknown";
  const perIp = `inspo-guest:ip:${ip}`;
  const total = "inspo-guest:all";
  const windowStart = new Date(Math.floor(Date.now() / HOUR_MS) * HOUR_MS);
  const counts = await hitRateLimits([perIp, total], windowStart);
  return (counts[perIp] ?? 0) <= GUEST_UPLOADS_PER_IP_PER_HOUR && (counts[total] ?? 0) <= GUEST_UPLOADS_PER_HOUR;
}

/**
 * The Vercel Blob presigned-upload protocol for inspo (handleUploadPresigned, lib/pipeline/inspo-upload.ts). Takes
 * {type: "blob.generate-presigned-url", payload: {pathname, ...}} and answers {type, presignedUrlPayload} for exactly
 * that pathname under inspo/. Needs a session, or open access, which is rate limited for the shared guest. Works with
 * either Blob credential (BLOB_READ_WRITE_TOKEN, or BLOB_STORE_ID with OIDC). No completion callback is requested, so
 * no other event is taken.
 *
 * 400 bad body or pathname, 401 signed out, 429 {error: "upload_limit"}, 503 {error: "uploads_unavailable"} (no Blob
 * store, or it refused to issue), 500 anything else. lib/client/upload.ts uploadFailureMessage maps these for people.
 */
export async function POST(req: Request): Promise<Response> {
  if (!env.blobConfigured) return errorJson(503, "uploads_unavailable");
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorJson(400, "Send a JSON body.");
  }
  if (!isPresignedUrlEvent(body)) return errorJson(400, "Send a blob.generate-presigned-url event.");
  try {
    const user = await requireUser();
    if (user.openAccess && !user.isAdmin && !(await guestUploadAllowed(req))) {
      return errorJson(429, "upload_limit");
    }
    return Response.json(await presignInspoUpload(body, req));
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err);
    if (err instanceof InspoPathnameError) return errorJson(400, err.message);
    if (storageNotSetUp(err)) {
      console.error("[inspo upload]", err);
      return errorJson(503, "uploads_unavailable");
    }
    console.error("[inspo upload]", err);
    return errorJson(500, "upload_failed");
  }
}
