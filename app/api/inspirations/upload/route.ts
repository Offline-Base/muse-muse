import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { AuthError, requireUser } from "@/lib/auth";
import { env } from "@/lib/env";
import { errorJson, errorResponse } from "@/lib/http";
import { INSPO_CONTENT_TYPES, MAX_REFERENCE_BYTES } from "@/lib/pipeline/references";

/** Client upload tokens are good for this long. */
const TOKEN_TTL_MS = 15 * 60_000;

function checkPathname(pathname: string): void {
  if (
    !pathname.startsWith("inspo/") ||
    pathname.length > 300 ||
    pathname.includes("..") ||
    pathname.includes("//") ||
    pathname.includes("\\")
  ) {
    throw new Error("Inspo uploads must go under inspo/.");
  }
}

/**
 * The Vercel Blob client-upload protocol for inspo (handleUpload from @vercel/blob/client). Issuing a token needs a
 * session. Uploads go straight from the browser to Blob, so the 4.5 MB function body limit doesn't apply.
 */
export async function POST(req: Request): Promise<Response> {
  let token: string;
  try {
    token = env.blobToken;
  } catch (err) {
    console.error("[inspo upload]", err);
    return errorJson(503, "uploads_unavailable");
  }
  let body: HandleUploadBody;
  try {
    body = (await req.json()) as HandleUploadBody;
  } catch {
    return errorJson(400, "Send a JSON body.");
  }
  try {
    // The completion callback comes from Vercel with a signature, not a session. handleUpload verifies it.
    const user = body?.type === "blob.upload-completed" ? null : await requireUser();
    const result = await handleUpload({
      body,
      request: req,
      token,
      onBeforeGenerateToken: async (pathname) => {
        checkPathname(pathname);
        return {
          allowedContentTypes: [...INSPO_CONTENT_TYPES],
          maximumSizeInBytes: MAX_REFERENCE_BYTES,
          addRandomSuffix: true,
          validUntil: Date.now() + TOKEN_TTL_MS,
          tokenPayload: JSON.stringify({ userId: user?.id ?? null }),
        };
      },
    });
    return Response.json(result);
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err);
    const message = err instanceof Error ? err.message : "Upload failed.";
    return errorJson(400, message);
  }
}
