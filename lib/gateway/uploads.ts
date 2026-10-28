import { BlobError } from "@vercel/blob";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { gatewayError } from "@/lib/gateway/errors";
import { clientIpKey, parseBearer } from "@/lib/gateway/extract";
import type { GatewayToken } from "@/lib/gateway/handler";
import { CLIENT_IP_HEADER, DEFAULT_LIMITS } from "@/lib/gateway/policy";
import type { ProductStatus } from "@/lib/types";

/** What products may upload through {GATEWAY_URL}/uploads. Raster images only: no SVG on the public Blob domain. */
export const UPLOAD_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
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
  /**
   * BLOB_READ_WRITE_TOKEN, or undefined when it isn't set (handleGatewayUpload then answers 503 uploads_unavailable).
   * A function so it's read per request, not at import.
   */
  blobToken(): string | undefined;
  /** Where Vercel Blob posts blob.upload-completed. Undefined when the platform has no public https origin. */
  callbackUrl?: string;
  /** The gateway's fixed-window counter (lib/gateway/store.ts), here with uploadTicketWindowMs windows. */
  hitRateLimits(keys: string[], windowStart: Date): Promise<Record<string, number>>;
  now?(): Date;
}

/**
 * Upload tickets per product token, and per end user when the product forwards x-musemuse-client-ip. That header is
 * only a rate-limit key, never auth.
 */
async function checkTicketLimits(req: Request, token: GatewayToken, deps: UploadDeps): Promise<Response | null> {
  const now = deps.now?.() ?? new Date();
  const windowMs = DEFAULT_LIMITS.uploadTicketWindowMs;
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const limits: Record<string, number> = { [`upload:token:${token.id}`]: DEFAULT_LIMITS.uploadTicketsPerToken };
  const ip = clientIpKey(req.headers.get(CLIENT_IP_HEADER));
  if (ip) limits[`upload:ip:${token.productId}:${ip}`] = DEFAULT_LIMITS.uploadTicketsPerIp;
  const counts = await deps.hitRateLimits(Object.keys(limits), windowStart);
  const over = Object.entries(limits).find(([key, limit]) => (counts[key] ?? 0) > limit);
  if (!over) return null;
  const retryAfter = Math.max(1, Math.ceil((windowStart.getTime() + windowMs - now.getTime()) / 1000));
  const who = over[0].startsWith("upload:ip:") ? "this user" : "this product";
  return gatewayError(
    429,
    "rate_limit_error",
    "rate_limited",
    `Too many uploads from ${who}: the limit is ${over[1]} every ${Math.round(windowMs / 60_000)} minutes. ` +
      `Try again in ${retryAfter} s.`,
    { headers: { "retry-after": String(retryAfter) } },
  );
}

function isUploadBody(body: unknown): body is HandleUploadBody {
  if (!body || typeof body !== "object") return false;
  const { type, payload } = body as { type?: unknown; payload?: unknown };
  return (type === "blob.generate-client-token" || type === "blob.upload-completed") && !!payload && typeof payload === "object";
}

class PathnameError extends Error {}

/**
 * The Vercel Blob client-upload protocol for products. Token requests need "Authorization: Bearer <PRODUCT_TOKEN>"
 * on a product that isn't disabled or failed, and are rate limited per token and per end user. The
 * blob.upload-completed callback from Vercel carries no bearer; handleUpload checks its x-vercel-signature instead.
 *
 * Client tokens are signed with BLOB_READ_WRITE_TOKEN, and callbacks are checked with it, so this needs that token. A
 * store connected with BLOB_STORE_ID only (OIDC, no read-write token) can't do either: every request then gets a 503
 * uploads_unavailable instead of a crash. Moving products to presigned uploads, as inspo did
 * (lib/pipeline/inspo-upload.ts), needs a template change (its client uses upload(), and its /api/upload route
 * forwards only client-token events) and a new builder snapshot, so it's a follow-up.
 */
export async function handleGatewayUpload(req: Request, deps: UploadDeps): Promise<Response> {
  const blobToken = deps.blobToken();
  if (!blobToken) {
    return gatewayError(
      503,
      "server_error",
      "uploads_unavailable",
      "File uploads aren't available on Muse Muse right now: its Blob store has no read-write token.",
      { retry: false },
    );
  }
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
    const limited = await checkTicketLimits(req, token, deps);
    if (limited) return limited;
  }

  try {
    const result = await handleUpload({
      body,
      request: req,
      token: blobToken,
      onBeforeGenerateToken: async (pathname) => {
        const problem = checkUploadPathname(pathname);
        if (problem) throw new PathnameError(problem);
        if (!token) throw new PathnameError("Missing product token.");
        return {
          allowedContentTypes: UPLOAD_CONTENT_TYPES,
          maximumSizeInBytes: DEFAULT_LIMITS.uploadMaxBytes,
          addRandomSuffix: true,
          validUntil: Date.now() + DEFAULT_LIMITS.uploadTicketValidMs,
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
