import { env } from "@/lib/env";
import { productStatusById } from "@/lib/gateway/store";
import { findToken } from "@/lib/gateway/tokens";
import { handleGatewayUpload } from "@/lib/gateway/uploads";

// Vercel Blob client uploads for products, so large files skip the 4.5 MB function body limit. Products proxy their
// own POST /api/upload here with "Authorization: Bearer <PRODUCT_TOKEN>". Files expire after 24 hours (cleanup cron).
export const runtime = "nodejs";

export async function POST(req: Request) {
  return handleGatewayUpload(req, {
    findToken,
    productStatus: productStatusById,
    blobToken: () => env.blobToken,
    callbackUrl: env.platformUrl.startsWith("https://") ? `${env.gatewayUrl}/uploads` : undefined,
  });
}
