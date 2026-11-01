// Platform file (Muse Muse platform services). Keep this file as it is.
//
// POST /api/musemuse/muse-code {task, files?, replay?} starts a Muse Code task for the person on this page; GET
// /api/musemuse/muse-code?id=...&after=n answers its steps after n. This server holds the product's token and passes
// on who is asking (the owner pass, the visitor cookie), so the browser never talks to the gateway. The gateway decides
// who may run tasks: only the owner, unless Muse Muse lets anyone.
import { CapError, failure, museCode, type TaskFile } from "@/lib/muse-code/client";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json().catch(() => null)) as { task?: unknown; files?: unknown; replay?: unknown } | null;
    if (!body || typeof body.task !== "string" || !body.task.trim()) throw new CapError("invalid_arguments", 400, "Say what the task is.");
    const files = Array.isArray(body.files) ? (body.files as TaskFile[]) : undefined;
    return Response.json(await museCode.start(request, { task: body.task, files, replay: body.replay === true }), { status: 201, headers: { "cache-control": "no-store" } });
  } catch (err) {
    return failure(err);
  }
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get("id") ?? "";
    const after = Number(url.searchParams.get("after") ?? "-1");
    return Response.json(await museCode.events(request, id, Number.isFinite(after) ? after : -1), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return failure(err);
  }
}
