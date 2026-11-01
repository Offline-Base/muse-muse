import { filesDeps } from "@/lib/caps/files/deps";
import { handleFiles } from "@/lib/caps/files/handler";

// Files products keep through the platform (docs/CAPABILITIES.md, section 10). The checks are the cap gate's
// (lib/caps/gate.ts). 404 unknown_endpoint while FILES_ENABLED is off or the files cap isn't ready.
export const runtime = "nodejs";

async function handle(req: Request, { params }: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await params;
  return handleFiles(req, path, filesDeps());
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
