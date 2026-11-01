import { dataDeps } from "@/lib/caps/data/deps";
import { handleData } from "@/lib/caps/data/handler";

// What products save through the platform (docs/CAPABILITIES.md, section 9). The checks are the cap gate's
// (lib/caps/gate.ts). 404 unknown_endpoint while DATA_ENABLED is off or the data cap isn't ready.
export const runtime = "nodejs";

async function handle(req: Request, { params }: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await params;
  return handleData(req, path, dataDeps());
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
