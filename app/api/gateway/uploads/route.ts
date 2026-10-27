import { env } from "@/lib/env";
import { hitRateLimits, productStatusById } from "@/lib/gateway/store";
import { findToken } from "@/lib/gateway/tokens";
import { handleGatewayUpload } from "@/lib/gateway/uploads";

// Vercel Blob client uploads for products, so large files skip the 4.5 MB function body limit. Products proxy their
// own POST /api/upload here with "Authorization: Bearer <PRODUCT_TOKEN>", plus x-musemuse-client-ip for the per-user
// limit. Files expire after 24 hours (cleanup cron).
export const runtime = "nodejs";

export async function POST(req: Request) {
  return handleGatewayUpload(req, {
    findToken,
    productStatus: productStatusById,
    blobToken: () => env.blobToken,
    hitRateLimits,
    callbackUrl: env.platformUrl.startsWith("https://") ? `${env.gatewayUrl}/uploads` : undefined,
  });
}
