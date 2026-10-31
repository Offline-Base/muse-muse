import { issueSignedToken } from "@vercel/blob";
import { handleUploadPresigned } from "@vercel/blob/client";
import { isCrossSite, requireAdminOrAutomation } from "@/lib/auth";
import { env } from "@/lib/env";
import { errorJson, readJson, route } from "@/lib/http";
import { checkShellPathname, SHELL_TEMPLATE_MAX_BYTES } from "@/lib/native/packager";
import { isPresignedUrlEvent, NO_CALLBACK_KEY, storageNotSetUp } from "@/lib/pipeline/inspo-upload";
import { blobAuth } from "@/lib/storage";

const UPLOAD_TTL_MS = 30 * 60_000;

/**
 * The Vercel Blob presigned-upload protocol for scripts/native/release-shells.ts, which can't sign in to the live store
 * itself. Takes {type: "blob.generate-presigned-url", payload: {pathname, ...}} and answers for exactly that pathname, which
 * must be one of a shell release's three files. Admins or automation only, never from another site.
 *
 * 400 bad body or pathname, 401 or 403 for anyone else, 503 {error: "uploads_unavailable"} when the store can't issue.
 */
export const POST = route(async (req: Request) => {
  if (isCrossSite(req.headers)) return errorJson(403, "cross_site");
  await requireAdminOrAutomation(req);
  if (!env.blobConfigured) return errorJson(503, "uploads_unavailable");
  const body = await readJson(req);
  if (!isPresignedUrlEvent(body)) return errorJson(400, "Send a blob.generate-presigned-url event.");
  const problem = checkShellPathname(body.payload.pathname);
  if (problem) return errorJson(400, problem);
  try {
    const reply = await handleUploadPresigned({
      body,
      request: req,
      webhookPublicKey: process.env.BLOB_WEBHOOK_PUBLIC_KEY || NO_CALLBACK_KEY,
      getSignedToken: async (pathname) => {
        const limits = { maximumSizeInBytes: SHELL_TEMPLATE_MAX_BYTES };
        const token = await issueSignedToken({ pathname, operations: ["put"], validUntil: Date.now() + UPLOAD_TTL_MS, ...limits, ...blobAuth() });
        return { token, urlOptions: { ...limits, addRandomSuffix: false, allowOverwrite: true } };
      },
    });
    return Response.json(reply, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (storageNotSetUp(err)) {
      console.error("[shell upload]", err);
      return errorJson(503, "uploads_unavailable");
    }
    throw err;
  }
});
