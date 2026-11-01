import { jobsDeps } from "@/lib/caps/jobs/deps";
import { handleJobs } from "@/lib/caps/jobs/handler";

// A product's background jobs (docs/CAPABILITIES.md, section 12): verify, checkpoint, enqueue, notify and a build's
// test-fire. 404 unknown_endpoint while JOBS_ENABLED is off or the jobs cap isn't ready.
export const runtime = "nodejs";

async function handle(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return handleJobs(req, path, jobsDeps());
}

export const GET = handle;
export const POST = handle;
