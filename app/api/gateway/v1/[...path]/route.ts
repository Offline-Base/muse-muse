import { after } from "next/server";
import { gatewayDeps } from "@/lib/gateway/deps";
import { handleGateway } from "@/lib/gateway/handler";

// Meta Model API proxy for live products and build-time tests. The checks live in lib/gateway/handler.ts.
export const runtime = "nodejs";
export const maxDuration = 300;

async function handle(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return handleGateway(req, path, gatewayDeps((task) => after(task)));
}

export const GET = handle;
export const POST = handle;
