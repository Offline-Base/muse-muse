import { BlobError } from "@vercel/blob";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { gatewayError } from "@/lib/gateway/errors";
import { parseBearer } from "@/lib/gateway/extract";
import type { GatewayToken } from "@/lib/gateway/handler";
import { DEFAULT_LIMITS } from "@/lib/gateway/policy";
import type { ProductStatus } from "@/lib/types";

/** What products may upload through {GATEWAY_URL}/uploads. */
export const UPLOAD_CONTENT_TYPES = [
  "image/*",
  "video/mp4",
  "video/quicktime",
  "audio/wav",
  "audio/x-wav",
  "application/pdf",
  "text/plain",
];

/** Pathnames must sit under uploads/ (the cleanup cron deletes them after 24 hours) with no traversal. */
export function checkUploadPathname(pathname: string): string | null {
  if (!pathname.startsWith("uploads/") || pathname.length <= "uploads/".length) {
    return 'The pathname must start with "uploads/".';
  }
  if (pathname.includes("..") || pathname.includes("\\") || pathname.includes("//")) {
    return "The pathname has a disallowed segment.";
  }
  if (pathname.length > 512) return "The pathname is too long.";
  return null;
}

export interface UploadDeps {
  findToken(token: string): Promise<GatewayToken | null>;
  productStatus(productId: string): Promise<ProductStatus | null>;
  /** BLOB_READ_WRITE_TOKEN. A function so a missing value surfaces as a 500 here, not at import. */
  blobToken(): string;
  /** Where Vercel Blob posts blob.upload-completed. Undefined when the platform has no public https origin. */
  callbackUrl?: string;
}

function isUploadBody(body: unknown): body is HandleUploadBody {
  if (!body || typeof body !== "object") return false;
  const { type, payload } = body as { type?: unknown; payload?: unknown };
  return (type === "blob.generate-client-token" || type === "blob.upload-completed") && !!payload && typeof payload === "object";
}

class PathnameError extends Error {}

/**
 * The Vercel Blob client-upload protocol for products. Token requests need "Authorization: Bearer <PRODUCT_TOKEN>"
 * on a product that isn't disabled or failed. The blob.upload-completed callback from Vercel carries no bearer;
 * handleUpload checks its x-vercel-signature instead.
 */
export async function handleGatewayUpload(req: Request, deps: UploadDeps): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return gatewayError(400, "invalid_request_error", "invalid_body", "The request body is not valid JSON.");
  }
  if (!isUploadBody(body)) {
    return gatewayError(400, "invalid_request_error", "invalid_body", "Expected a Vercel Blob client upload event.");
  }

  let token: GatewayToken | null = null;
  if (body.type === "blob.generate-client-token") {
    const bearer = parseBearer(req.headers.get("authorization"));
    token = bearer ? await deps.findToken(bearer) : null;
    if (!token) {
      return gatewayError(401, "authentication_error", "invalid_token", "Missing, unknown, revoked or expired product token.");
    }
    const status = await deps.productStatus(token.productId);
    if (!status || status === "disabled" || status === "failed") {
      return gatewayError(403, "permission_error", "product_disabled", "This product is turned off on Muse Muse.");
    }
  }

  try {
    const result = await handleUpload({
      body,
      request: req,
      token: deps.blobToken(),
      onBeforeGenerateToken: async (pathname) => {
        const problem = checkUploadPathname(pathname);
        if (problem) throw new PathnameError(problem);
        if (!token) throw new PathnameError("Missing product token.");
        return {
          allowedContentTypes: UPLOAD_CONTENT_TYPES,
          maximumSizeInBytes: DEFAULT_LIMITS.uploadMaxBytes,
          addRandomSuffix: true,
          validUntil: Date.now() + 60 * 60 * 1000,
          tokenPayload: JSON.stringify({ productId: token.productId }),
          ...(deps.callbackUrl ? { callbackUrl: deps.callbackUrl } : {}),
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        console.log("[gateway/uploads] completed", blob.pathname, tokenPayload ?? "");
      },
    });
    return Response.json(result);
  } catch (err) {
    if (err instanceof PathnameError) return gatewayError(400, "invalid_request_error", "invalid_pathname", err.message);
    if (err instanceof BlobError) {
      console.warn("[gateway/uploads] rejected:", err.message);
      return gatewayError(400, "invalid_request_error", "upload_rejected", "The upload request was rejected.");
    }
    console.error("[gateway/uploads] failed:", err);
    return gatewayError(500, "server_error", "upload_unavailable", "Uploads are unavailable right now.");
  }
}
