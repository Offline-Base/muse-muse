// Platform file (Muse Muse platform services). Keep this file as it is.
//
// POST /api/musemuse/muse-code/steer {id, text}: a note into the person's running Muse Code task.
import { CapError, failure, museCode } from "@/lib/muse-code/client";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json().catch(() => null)) as { id?: unknown; text?: unknown } | null;
    if (!body || typeof body.id !== "string" || typeof body.text !== "string" || !body.text.trim()) throw new CapError("invalid_arguments", 400, "Send the run's id and the note.");
    return Response.json(await museCode.steer(request, body.id, body.text), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return failure(err);
  }
}
