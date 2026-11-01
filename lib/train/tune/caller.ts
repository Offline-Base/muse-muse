/**
 * Who may plan and start runs from the new composer (docs/TRAINING.md "Fine-tune like a build"), as one seam so the
 * routes don't each decide. The rate-limit key and the plan token are both tied to the caller's id.
 */
import { requireAdminOrAutomation, type SessionUser } from "@/lib/auth";

/**
 * Today: admins, and scripts with the automation secret, exactly as requireAdminOrAutomation lets them into the other
 * /api/train routes (throws AuthError 401 or 403 otherwise). open-train swaps this for its trainCaller(req), which also
 * lets visitors in once PUBLIC_TRAINING is on; nothing else here changes when it does.
 */
export async function tuneCaller(req: Request): Promise<SessionUser> {
  return requireAdminOrAutomation(req);
}
