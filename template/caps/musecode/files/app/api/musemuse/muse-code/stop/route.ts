// Platform file (Muse Muse platform services). Keep this file as it is.
//
// POST /api/musemuse/muse-code/stop {id}: stops the person's Muse Code task. It keeps what it made, and the answer is
// the run's result.
import { CapError, failure, museCode } from "@/lib/muse-code/client";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
    if (!body || typeof body.id !== "string") throw new CapError("invalid_arguments", 400, "Send the run's id.");
    return Response.json(await museCode.stop(request, body.id), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return failure(err);
  }
}
