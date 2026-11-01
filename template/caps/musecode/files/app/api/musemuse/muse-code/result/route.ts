// Platform file (Muse Muse platform services). Keep this file as it is.
//
// GET /api/musemuse/muse-code/result?id=...: the run's final answer, its files, the zip's link and whether it worked.
import { failure, museCode } from "@/lib/muse-code/client";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  try {
    const id = new URL(request.url).searchParams.get("id") ?? "";
    return Response.json(await museCode.result(request, id), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return failure(err);
  }
}
