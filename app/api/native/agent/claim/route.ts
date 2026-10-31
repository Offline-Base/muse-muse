import { z } from "zod";
import { labGate, readJson, unauthorized } from "@/lib/native/agent-http";
import { laneForToken, notePresence } from "@/lib/native/lab-box";
import { bearerToken, hashLabToken } from "@/lib/native/lab-token";
import { claimJob } from "@/lib/native/queue";
import { NATIVE_LANES } from "@/lib/native/types";

// A lab box asks for work every 10 s (docs/NATIVE_LAB.md, "POST /api/native/agent/claim"). The lab token only does this.
// Holding the request open is optional, and it would keep a database and a function busy for nothing, so this answers
// at once and the agent waits out the rest of its 10 s.
export const runtime = "nodejs";
export const maxDuration = 30;

const ClaimBody = z.object({
  lane: z.enum(NATIVE_LANES),
  version: z.string().max(40).nullish(),
  kinds: z.array(z.string().max(40)).max(20).default([]),
  slots: z.number().int().min(0).max(8).nullish(),
  running: z.array(z.string().max(64)).max(8).default([]),
  capabilities: z.record(z.string(), z.unknown()).nullish(),
});

export async function POST(req: Request): Promise<Response> {
  const off = labGate();
  if (off) return off;
  const token = bearerToken(req);
  const lane = token ? await laneForToken(hashLabToken(token)) : null;
  if (!lane) return unauthorized();
  const parsed = ClaimBody.safeParse(await readJson(req, 64 * 1024));
  if (!parsed.success) return Response.json({ error: "bad_request" }, { status: 400 });
  const body = parsed.data;
  if (body.lane !== lane) return Response.json({ error: "wrong_lane" }, { status: 403 });

  await notePresence(lane, {
    version: body.version ?? null,
    slots: body.slots ?? null,
    running: body.running,
    kinds: body.kinds,
    capabilities: body.capabilities ?? null,
  });
  if (!body.kinds.length) return new Response(null, { status: 204 });

  const claimed = await claimJob(lane, body.kinds);
  if (!claimed) return new Response(null, { status: 204 });
  const { job, token: jobToken } = claimed;
  return Response.json({ job: { id: job.id, kind: job.kind, token: jobToken, attempt: job.attempts, runId: job.runId, input: job.input } });
}
