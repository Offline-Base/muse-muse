import { AuthError, requireAdminOrAutomation, type SessionUser } from "@/lib/auth";
import { RoverBusyError, RoverError, RoverKitError, roverLogText, RoverNotConfiguredError } from "@/lib/device/rover";
import { RoverInputError } from "@/lib/device/rover-tools";
import { errorJson, HttpError } from "@/lib/http";

/**
 * What /api/device/rover and /api/device/rover/drive share: who may use them, and how a failure answers. Signed-in admins
 * only, since OPEN_ACCESS=admin on a preview acts as an admin for anyone who opens it, and these run commands on a board as
 * root with the fleet's token.
 */
export async function roverAdmin(req: Request): Promise<SessionUser> {
  const user = await requireAdminOrAutomation(req);
  if (user.openAccess) throw new AuthError("Sign in first. Everyone shares this account, so it can't reach the rover.", 403);
  return user;
}

/** Off, every rover route answers as if it didn't exist, and touches nothing: no session, no fleet, no board. */
export const roverOff = () => errorJson(404, "not_found");

/**
 * 503 fleet_not_configured or kit_missing, 400 invalid_input, 409 setup_running, 502 rover_unavailable. Each RoverError's
 * message is safe to show, so it goes along; anything else goes to the log only.
 */
export function roverFailure(err: unknown, where: string): Response {
  if (err instanceof HttpError || err instanceof AuthError) throw err;
  if (err instanceof RoverNotConfiguredError) return errorJson(503, "fleet_not_configured");
  if (err instanceof RoverInputError) return errorJson(400, "invalid_input", { message: err.message });
  if (err instanceof RoverBusyError) return errorJson(409, "setup_running", { message: err.message });
  if (err instanceof RoverKitError) return errorJson(503, "kit_missing", { message: err.message });
  if (err instanceof RoverError) return errorJson(502, "rover_unavailable", { message: err.message });
  console.error(`[${where}]`, roverLogText(err));
  return errorJson(502, "rover_unavailable");
}
