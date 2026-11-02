import { AuthError, requireAdminOrAutomation } from "@/lib/auth";
import { cachedFleetBoards, FleetError, FleetNotConfiguredError } from "@/lib/device/fleet";
import { errorJson, route } from "@/lib/http";

/** A wrong token or address, not an outage: asking again won't help. A bare host gets 404, since the API is under /admin. */
const REFUSED = new Set([401, 403, 404]);

/**
 * GET -> {boards}: every board in the fleet, with only what's safe to show (lib/device/fleet.ts), shared for a short while so
 * several admins cost one call through the tunnel. Signed-in admins only: OPEN_ACCESS=admin on a preview acts as an admin for
 * anyone who opens it, and this reads with the fleet's token. 503 fleet_not_configured, 502 fleet_refused or fleet_unavailable.
 * Why it failed goes to the log, and none of them carries the address or token.
 */
export const GET = route(async (req: Request) => {
  const user = await requireAdminOrAutomation(req);
  if (user.openAccess) throw new AuthError("Sign in first. Everyone shares this account, so it can't read the fleet.", 403);
  try {
    return Response.json({ boards: await cachedFleetBoards() });
  } catch (err) {
    if (err instanceof FleetNotConfiguredError) return errorJson(503, "fleet_not_configured");
    console.error("[device]", err instanceof Error ? err.message : "The fleet can't be reached.");
    return errorJson(502, err instanceof FleetError && err.status !== undefined && REFUSED.has(err.status) ? "fleet_refused" : "fleet_unavailable");
  }
});
