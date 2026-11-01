/**
 * Who may plan and start runs from the new composer (docs/TRAINING.md "Fine-tune like a build"), as one seam so the
 * routes don't each decide. The rate-limit key and the plan token are both tied to the caller's id.
 */
import { requireAdminOrAutomation, type SessionUser } from "@/lib/auth";
import { TUNE_MAX_EXAMPLES } from "@/lib/train/tune/cost";

/**
 * Today: admins, and scripts with the automation secret, exactly as requireAdminOrAutomation lets them into the other
 * /api/train routes (throws AuthError 401 or 403 otherwise). open-train swaps this for its trainCaller(req), which also
 * lets visitors in once PUBLIC_TRAINING is on; nothing else here changes when it does.
 */
export async function tuneCaller(req: Request): Promise<SessionUser> {
  return requireAdminOrAutomation(req);
}

/**
 * The most examples this caller's run may ask for, which both routes check Advanced's number against: the plan's token
 * signs the task but not the size, so this is what keeps a plan from being started far bigger than the caller may.
 * Today every caller is an admin or automation, so it's the datasets route's own 1000. open-train returns its smaller
 * visitor cap here when trainCaller lets visitors in.
 */
export function tuneExamplesMax(_caller: SessionUser): number {
  return TUNE_MAX_EXAMPLES;
}
