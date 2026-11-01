import { AuthError, isCrossSite } from "@/lib/auth";
import { requireBoardOwner } from "@/lib/caps/hardware/admin";
import { openLinkedBoard } from "@/lib/caps/hardware/board";
import { gadgetConnectOn } from "@/lib/caps/hardware/flags";
import { ownedBoardRow, pairedFactsOf, setBoardStopped } from "@/lib/caps/hardware/store";
import { errorJson, readJson, route } from "@/lib/http";

// The owner's hard stop, and clearing it. The stop is saved before the board is called, so it holds even if the board doesn't answer,
// and the reply says whether it did. Clearing happens only if the board heard it: a board that kept its stop shouldn't look cleared.
export const runtime = "nodejs";
export const maxDuration = 30;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  if (!gadgetConnectOn()) return errorJson(404, "not_found");
  if (isCrossSite(req.headers)) throw new AuthError("Requests from other sites can't do this.", 403);
  const user = await requireBoardOwner();
  const { id } = await params;
  const row = UUID.test(id) ? await ownedBoardRow(id, user.id) : null;
  if (!row) return errorJson(404, "not_found");
  // A board with no robot has no stop to hold, and one could never be cleared.
  if (!pairedFactsOf(row.models)?.robot) return errorJson(403, "robot_real_board_off");
  const body = await readJson(req, 1024);
  const clear = body.clear === true;
  if (!clear) await setBoardStopped(id, true);
  let reached = false;
  try {
    const board = await openLinkedBoard(row);
    if (board) {
      const result = await board.callTool(clear ? "clear_stop" : "hard_stop", {});
      reached = !result.isError;
    }
  } catch {
    console.error("[hardware] a stop didn't reach the board");
  }
  if (clear && !reached) return errorJson(502, "gadget_unavailable");
  if (clear) await setBoardStopped(id, false);
  return Response.json({ stopped: !clear, reachedBoard: reached });
});
