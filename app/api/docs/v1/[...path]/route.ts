import { after } from "next/server";
import { docsDeps } from "@/lib/docs/proxy/deps";
import { handleDocsProxy } from "@/lib/docs/proxy/handler";

// The live docs demos' proxy to the Meta Model API, on Muse Muse's key. The checks live in lib/docs/proxy/handler.ts.
export const runtime = "nodejs";
export const maxDuration = 300;

async function handle(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return handleDocsProxy(req, path, docsDeps((task) => after(task)));
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
// Not methods Meta's API takes here: exported so they get the docs' 404 unknown_endpoint rather than Next's bare 405.
export const PUT = handle;
export const PATCH = handle;
