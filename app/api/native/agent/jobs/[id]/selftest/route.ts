import { gone, isJobId, labGate, unauthorized } from "@/lib/native/agent-http";
import { bearerToken } from "@/lib/native/lab-token";
import { ownedJob } from "@/lib/native/queue";

// What the shell posted to /api/native/selftest for this job, for the agent. A report from an earlier attempt can't be
// here, because the claim clears it, and the agent also ignores any report dated before its launch.
export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const off = labGate();
  if (off) return off;
  const token = bearerToken(req);
  if (!token) return unauthorized();
  const { id } = await params;
  const job = isJobId(id) ? await ownedJob(id, token) : null;
  if (!job) return gone();
  return Response.json({ report: job.selftest ?? null });
}
