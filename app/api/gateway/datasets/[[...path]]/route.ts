import { filesDeps } from "@/lib/caps/files/deps";
import { handleDatasets } from "@/lib/caps/files/handler";

// The vetted public datasets (docs/CAPABILITIES.md, section 10, lib/caps/files/datasets.json). 404 unknown_endpoint
// while FILES_DATASETS or the files cap is off.
export const runtime = "nodejs";

async function handle(req: Request, { params }: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await params;
  return handleDatasets(req, path, filesDeps());
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
