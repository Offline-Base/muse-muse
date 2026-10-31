import { handleCapsProof } from "@/lib/caps/proof";
import { env } from "@/lib/env";
import { findToken } from "@/lib/gateway/tokens";

// What the gateway saw for a build's namespace, for verify's caps step (lib/caps/proof.ts, docs/CAPABILITIES.md 2.8).
// 404 unknown_endpoint while no cap is enabled.
export const runtime = "nodejs";

const deps = { enabledCaps: () => env.enabledCaps, findToken };

export async function GET(req: Request) {
  return handleCapsProof(req, deps);
}

export async function POST(req: Request) {
  return handleCapsProof(req, deps);
}
