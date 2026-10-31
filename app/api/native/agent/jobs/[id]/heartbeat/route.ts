import { gone, isJobId, labGate, unauthorized } from "@/lib/native/agent-http";
import { bearerToken } from "@/lib/native/lab-token";
import { recordHeartbeat } from "@/lib/native/queue";

// A running job's pulse, every 15 s. A canceled or re-queued job answers 410, which the agent takes as a cancel, so
// `cancel: true` has no job left to send: the row is already closed by then.
export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const off = labGate();
  if (off) return off;
  const token = bearerToken(req);
  if (!token) return unauthorized();
  const { id } = await params;
  if (!isJobId(id) || !(await recordHeartbeat(id, token))) return gone();
  return Response.json({ cancel: false });
}
