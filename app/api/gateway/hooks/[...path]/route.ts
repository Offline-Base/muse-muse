import { hookDeps } from "@/lib/caps/jobs/deps";
import { handleHook } from "@/lib/caps/jobs/handler";

// Another service starts a product's job: POST /hooks/<productId>/<name>?k=<secret> (docs/CAPABILITIES.md, section 12).
// 404 unknown_endpoint while JOBS_ENABLED or JOBS_WEBHOOKS is off, or the jobs cap isn't ready.
export const runtime = "nodejs";

async function handle(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return handleHook(req, path, hookDeps());
}

export const GET = handle;
export const POST = handle;
