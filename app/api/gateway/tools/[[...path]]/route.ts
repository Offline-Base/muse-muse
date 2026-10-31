import { handleTools } from "@/lib/tools/handler";
import { toolsDeps } from "@/lib/tools/deps";

// The tool gateway for products (docs/AGENT_TOOLS.md). The checks live in lib/tools/handler.ts.
export const runtime = "nodejs";
export const maxDuration = 60;

async function handle(req: Request, { params }: { params: Promise<{ path?: string[] }> }) {
  const { path } = await params;
  return handleTools(req, path ?? [], toolsDeps());
}

export const GET = handle;
export const POST = handle;
