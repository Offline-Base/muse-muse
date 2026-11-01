import { isCrossSite } from "@/lib/auth";
import { boardLabel } from "@/lib/board-loop/logic";
import { getLoop } from "@/lib/board-loop/store";
import { joinQueue, TRY_LIMITS } from "@/lib/board-loop/try";
import { mayTry, tryDeps, tryVisitor } from "@/lib/board-loop/try-server";
import { env } from "@/lib/env";
import { errorJson, readJson, route } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

const REFUSED_STATUS = { closed: 409, offline: 503, bad_prompt: 400, visitor_limit: 429, ip_limit: 429, queue_full: 429 } as const;

/** GET -> whether the page can take a turn now: open, or closed, or the board offline. Public with BOARD_LOOP on. */
export const GET = route(async (_req: Request, { params }: Ctx) => {
  if (!env.boardLoop) return errorJson(404, "not_found");
  const loop = await getLoop((await params).id);
  if (!loop || !(await mayTry(loop))) return errorJson(404, "not_found");
  let state: "open" | "closed" | "offline" = "closed";
  if (loop.tryOpen) {
    const board = await tryDeps.board(loop);
    const online = board ? await board.status().then((s) => s.online, () => false) : false;
    state = online ? "open" : "offline";
  }
  return Response.json(
    { state, label: boardLabel(loop.target), simulated: loop.target === "simulated", limits: { promptChars: TRY_LIMITS.promptChars, perHour: TRY_LIMITS.perVisitorPerHour } },
    { headers: { "cache-control": "no-store" } },
  );
});

/** POST {prompt} -> 202 {turn}: joins the queue, or a refusal in plain words with its status. */
export const POST = route(async (req: Request, { params }: Ctx) => {
  if (!env.boardLoop) return errorJson(404, "not_found");
  if (isCrossSite(req.headers)) return errorJson(403, "cross_site");
  const loopId = (await params).id;
  const loop = await getLoop(loopId);
  if (!loop || !(await mayTry(loop))) return errorJson(404, "not_found");
  const who = tryVisitor(req);
  const { prompt } = await readJson(req, 16 * 1024);
  const result = await joinQueue({ loopId, visitor: who.visitor, ip: who.ip, prompt }, tryDeps);
  const headers = new Headers({ "cache-control": "no-store" });
  if (who.setCookie) headers.set("set-cookie", who.setCookie);
  if ("refused" in result) {
    if ("retryAfterSeconds" in result) headers.set("retry-after", String(result.retryAfterSeconds));
    return Response.json({ error: result.refused, message: result.message }, { status: REFUSED_STATUS[result.refused], headers });
  }
  return Response.json(result, { status: 202, headers });
});
