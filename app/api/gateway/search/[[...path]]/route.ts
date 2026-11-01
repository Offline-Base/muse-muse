import { filesDeps } from "@/lib/caps/files/deps";
import { handleSearch } from "@/lib/caps/files/handler";

// A product's full-text index (docs/CAPABILITIES.md, section 10). 404 unknown_endpoint while FILES_SEARCH or the files
// cap is off.
export const runtime = "nodejs";

async function handle(req: Request, { params }: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await params;
  return handleSearch(req, path, filesDeps());
}

export const GET = handle;
export const POST = handle;
