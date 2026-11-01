// Platform file (Muse Muse platform services). Keep this file as it is.
//
// POST /api/musemuse/connect-send is where <ConfirmSend /> sends the message the owner confirmed, with its approval.
// The gateway checks the owner's session and that the message is exactly the one confirmed.
import { CapError } from "@/lib/platform/connect";
import { send, type Message } from "@/lib/platform/send";

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { args?: Message; approval?: unknown } | null;
  if (!body?.args || typeof body.approval !== "string") return Response.json({ error: "Nothing to send." }, { status: 400 });
  try {
    const { channel, to, subject, body: text, from } = body.args;
    return Response.json(await send(request, { channel, to, subject, body: text, from, approval: body.approval }), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    const e = err instanceof CapError ? err : new CapError("cap_failed", 502, "That didn't send. Nothing went out.");
    return Response.json({ error: e.message, code: e.code }, { status: e.status >= 400 && e.status < 600 ? e.status : 502 });
  }
}
