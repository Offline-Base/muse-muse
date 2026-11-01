import { AuthError, isCrossSite } from "@/lib/auth";
import { requireBoardOwner } from "@/lib/caps/hardware/admin";
import { boardKeyring, openLinkedBoard } from "@/lib/caps/hardware/board";
import { gadgetConnectOn } from "@/lib/caps/hardware/flags";
import { readRobotRequest, robotNonceKey } from "@/lib/caps/hardware/robot";
import { linkedBoardRow, pairedFactsOf } from "@/lib/caps/hardware/store";
import { hitRateLimits } from "@/lib/gateway/store";
import { robotActionProblem } from "@/lib/gateway/gadget-sim";
import { errorJson, readJson, route } from "@/lib/http";

// The owner's yes to one robot action. Only here, under their own session on Muse Muse's own page: a product's code holds no
// session, so it can't confirm for itself. Simulated boards only.
export const runtime = "nodejs";
export const maxDuration = 30;

export const POST = route(async (req: Request) => {
  if (!gadgetConnectOn()) return errorJson(404, "not_found");
  if (isCrossSite(req.headers)) throw new AuthError("Requests from other sites can't confirm this.", 403);
  const user = await requireBoardOwner();
  const body = await readJson(req, 8 * 1024);
  const now = new Date();
  const request = readRobotRequest(body.request, now);
  // Someone else's request looks the same as an expired one.
  if (!request || request.ownerUserId !== user.id) return errorJson(410, "request_expired");
  if (robotActionProblem(request.action, request.args)) return errorJson(400, "not_allowed");
  // Checked now, not when it was asked: the product's owner, the link and the stop can all have changed.
  const row = await linkedBoardRow(request.productId);
  if (!row || row.boardId !== request.boardId || row.ownerUserId !== user.id) return errorJson(410, "request_expired");
  const facts = pairedFactsOf(row.models);
  if (!facts?.robot) return errorJson(403, "robot_real_board_off");
  if (row.health?.stopped) return errorJson(409, "stopped");
  if (!boardKeyring()) return errorJson(503, "key_missing");
  const key = robotNonceKey(request.nonce);
  if (((await hitRateLimits([key], now))[key] ?? 1) > 1) return errorJson(409, "already_used");
  const board = await openLinkedBoard(row);
  if (!board) return errorJson(503, "gadget_offline");
  try {
    const result = await board.callTool("robot_action", { action: request.action, args: request.args });
    const words = (result.content as Array<{ type?: string; text?: string }>).find((c) => c.type === "text")?.text ?? "";
    if (result.isError) return Response.json({ ok: false, message: words, simulated: facts.simulated });
    return Response.json({ ok: true, status: JSON.parse(words), simulated: facts.simulated });
  } catch {
    console.error("[hardware] a confirmed action didn't reach the board");
    return errorJson(502, "gadget_unavailable");
  }
});
