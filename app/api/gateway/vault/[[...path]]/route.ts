import { connectDeps } from "@/lib/caps/connect/deps";
import { handleVault } from "@/lib/caps/connect/handler";

// A product's key vault and brokered calls (docs/CAPABILITIES.md, section 11). 404 unknown_endpoint while
// CONNECT_VAULT or CONNECT_ENABLED is off, or the connect cap isn't ready. No answer ever holds a key.
export const runtime = "nodejs";

async function handle(req: Request, { params }: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await params;
  return handleVault(req, path, connectDeps());
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
