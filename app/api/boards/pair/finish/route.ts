import { refuseCrossSite, requireBoardOwner } from "@/lib/caps/hardware/admin";
import { gadgetConnectOn } from "@/lib/caps/hardware/flags";
import { PAIR_TRIES_PER_HOUR } from "@/lib/caps/hardware/limits";
import { finishPairing, type PairRefusal } from "@/lib/caps/hardware/pairing";
import { hitRateLimits } from "@/lib/gateway/store";
import { errorJson, readJson, route } from "@/lib/http";

// Step 3 of pairing: the person said the check numbers match, and typed the board's code. The board's new token is sealed here.
export const runtime = "nodejs";
export const maxDuration = 45;

const STATUS: Partial<Record<PairRefusal, number>> = { key_missing: 503, wrong_code: 401, pair_expired: 410, board_unreachable: 502, not_a_board: 422, too_many_boards: 429 };

export const POST = route(async (req: Request) => {
  if (!gadgetConnectOn()) return errorJson(404, "not_found");
  refuseCrossSite(req);
  const user = await requireBoardOwner();
  const hour = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
  const key = `pair:${user.id}`;
  if (((await hitRateLimits([key], hour))[key] ?? 0) > PAIR_TRIES_PER_HOUR) return errorJson(429, "too_many_tries");
  const body = await readJson(req, 8 * 1024);
  const result = await finishPairing({ ticket: body.ticket, code: body.code, name: body.name, confirmed: body.confirmed }, user.id);
  if (!result.ok) return errorJson(STATUS[result.error] ?? 400, result.error);
  return Response.json({ id: result.id, target: result.target, simulated: result.simulated }, { status: 201 });
});
