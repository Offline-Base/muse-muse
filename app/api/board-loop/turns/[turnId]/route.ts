import { isCrossSite } from "@/lib/auth";
import { pollTurn } from "@/lib/board-loop/try";
import { tryDeps, tryVisitor } from "@/lib/board-loop/try-server";
import { env } from "@/lib/env";
import { errorJson, route } from "@/lib/http";

type Ctx = { params: Promise<{ turnId: string }> };

// A turn reaching the front runs inside its own poll, up to TRY_LIMITS.askMs.
export const maxDuration = 120;

/** POST -> the visitor's own turn, which runs here when it reaches the front. 404 for anyone else's. */
export const POST = route(async (req: Request, { params }: Ctx) => {
  if (!env.boardLoop) return errorJson(404, "not_found");
  if (isCrossSite(req.headers)) return errorJson(403, "cross_site");
  const who = tryVisitor(req);
  const view = await pollTurn({ turnId: (await params).turnId, visitor: who.visitor, ip: who.ip }, tryDeps);
  if (!view) return errorJson(404, "not_found");
  return Response.json(view, { headers: { "cache-control": "no-store" } });
});
