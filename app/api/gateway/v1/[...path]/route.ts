import { notImplemented } from "@/lib/http";

// Meta Model API proxy for live products and build-time tests. See GATEWAY_CHECKS in lib/gateway/policy.ts.
// TODO(kickoff, day 2): token lookup, allowlist, budget and rate limit, forward with streaming, usage metering.
async function handle(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return notImplemented(`Proxy /v1/${path.join("/")} to the Meta Model API`);
}

export const GET = handle;
export const POST = handle;
