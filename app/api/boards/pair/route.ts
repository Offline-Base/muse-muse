import { refuseCrossSite, requireBoardOwner } from "@/lib/caps/hardware/admin";
import { gadgetConnectOn } from "@/lib/caps/hardware/flags";
import { PAIR_TRIES_PER_HOUR } from "@/lib/caps/hardware/limits";
import { startPairing, type PairRefusal } from "@/lib/caps/hardware/pairing";
import { hitRateLimits } from "@/lib/gateway/store";
import { errorJson, readJson, route } from "@/lib/http";

// Step 2 of pairing (lib/caps/hardware/pairing.ts): reads the board's public key from a handshake and answers the check number.
// A person's own account only. Never the shared guest. A reply never holds a board's address back or its key.
export const runtime = "nodejs";
export const maxDuration = 30;

const STATUS: Partial<Record<PairRefusal, number>> = { unsafe_address: 400, board_unreachable: 502, key_missing: 503 };

export const POST = route(async (req: Request) => {
  if (!gadgetConnectOn()) return errorJson(404, "not_found");
  refuseCrossSite(req);
  const user = await requireBoardOwner();
  const hour = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
  const key = `pair:${user.id}`;
  if (((await hitRateLimits([key], hour))[key] ?? 0) > PAIR_TRIES_PER_HOUR) return errorJson(429, "too_many_tries");
  const body = await readJson(req, 4 * 1024);
  const result = await startPairing({ address: body.address }, user.id);
  if (!result.ok) return errorJson(STATUS[result.error] ?? 400, result.error);
  return Response.json({ ticket: result.ticket, checkNumber: result.checkNumber });
});
