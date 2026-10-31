import { handleCapsProof } from "@/lib/caps/proof";
import { env } from "@/lib/env";
import { hitRateLimits, productStatusById } from "@/lib/gateway/store";
import { findToken } from "@/lib/gateway/tokens";

// What the gateway saw for a build's namespace, for verify's caps step (lib/caps/proof.ts, docs/CAPABILITIES.md 2.8).
// 404 unknown_endpoint while no cap is enabled.
export const runtime = "nodejs";

const deps = { enabledCaps: () => env.enabledCaps, findToken, productStatus: productStatusById, hitRateLimits };

export async function GET(req: Request) {
  return handleCapsProof(req, deps);
}

export async function POST(req: Request) {
  return handleCapsProof(req, deps);
}
