/**
 * Who may plan and start runs from the new composer (docs/TRAINING.md "Fine-tune like a build"), as one seam so the
 * routes don't each decide. The rate-limit key and the plan token are both tied to the caller's id.
 */
import { requireAdminOrAutomation, type SessionUser } from "@/lib/auth";
import { env } from "@/lib/env";
import type { Refusal } from "@/lib/train/public/identity";
import type { VisitorCaller } from "@/lib/train/public/caller";
import { limitCeilings } from "@/lib/train/gate";
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

/**
 * Who a run's routes are talking to (plan, runs, its start, stop and read; the loops stay on tuneCaller, admins only).
 * With OPEN_TRAIN off it's tuneCaller exactly. On: an admin or automation as before, and anyone else a visitor. `id` is
 * what the plan token and the rate limits key by: the admin's id, or the visitor's trainer id (null before they have one).
 * `created_by` is a uuid, so what a visitor owns goes by runOwnerId instead. lib/train/public loads only with the flag on.
 */
export interface RunCaller {
  id: string | null;
  isAdmin: boolean;
  visitor: VisitorCaller | null;
}

export async function runCaller(req: Request): Promise<RunCaller> {
  if (!env.openTrain) {
    const user = await tuneCaller(req);
    return { id: user.id, isAdmin: user.isAdmin, visitor: null };
  }
  const { trainCaller } = await import("@/lib/train/public/caller");
  const caller = await trainCaller(req);
  if (caller.kind === "admin") return { id: caller.user.id, isAdmin: caller.user.isAdmin, visitor: null };
  return { id: caller.trainerId, isAdmin: false, visitor: caller };
}

/**
 * runCaller for a page. Only what says who it is goes in: a link from another site still opens the person's own run,
 * which the cross-site check on writes would refuse.
 */
export async function pageRunCaller(): Promise<RunCaller> {
  const { headers } = await import("next/headers");
  const h = await headers();
  const pass = new Headers();
  for (const name of ["cookie", "x-real-ip", "x-forwarded-for", "host"]) {
    const v = h.get(name);
    if (v) pass.set(name, v);
  }
  return runCaller(new Request("https://muse.invalid/page", { headers: pass }));
}

/** The caller with a trainer id, minted with its Set-Cookie on `out` when a visitor has none: only once their input passed. */
export async function runCallerToCreate(caller: RunCaller, req: Request, out: { headers: Headers }): Promise<{ ok: true; caller: RunCaller & { id: string } } | Refusal> {
  if (caller.id) return { ok: true, caller: caller as RunCaller & { id: string } };
  const { mintTrainer } = await import("@/lib/train/public/identity");
  const minted = await mintTrainer(req, out);
  if (!minted.ok) return minted;
  return { ok: true, caller: { ...caller, id: minted.trainer.trainerId, visitor: caller.visitor ? { ...caller.visitor, trainerId: minted.trainer.trainerId } : null } };
}

/** The users row that owns what this caller makes: their own, or a visitor's hidden row, made on first use. */
export async function runOwnerId(caller: RunCaller & { id: string }): Promise<string> {
  if (!caller.visitor || caller.visitor.signedIn) return caller.id;
  const { ensureTrainerUser } = await import("@/lib/train/public/identity");
  return ensureTrainerUser(caller.id);
}

/** Who owns what this caller may read or stop, without making anything, or null when they own nothing yet. */
export async function runReaderId(caller: RunCaller): Promise<string | null> {
  if (!caller.id || !caller.visitor || caller.visitor.signedIn) return caller.id;
  const { trainerUserId } = await import("@/lib/train/public/identity");
  return trainerUserId(caller.id);
}

/** True when this caller may read or act on a run with this author. Admins may always; a visitor only on their own. */
export async function mayTouchRun(caller: RunCaller, createdBy: string | null | undefined): Promise<boolean> {
  if (caller.isAdmin) return true;
  const reader = await runReaderId(caller);
  return Boolean(reader && createdBy && reader === createdBy);
}

/** The most examples this caller's run may ask for: the visitor cap, or tuneExamplesMax. */
export function runExamplesMax(caller: RunCaller): number {
  return caller.visitor ? Math.min(TUNE_MAX_EXAMPLES, caller.visitor.limits.datasetMaxRows) : TUNE_MAX_EXAMPLES;
}

/** The job limits this caller's run is planned within. */
export function runCeilings(caller: RunCaller): { maxMinutes: number; maxUsd: number } {
  if (!caller.visitor) return limitCeilings();
  const { maxMinutes, maxUsd } = caller.visitor.limits.job;
  return { maxMinutes, maxUsd };
}

/** Moves any cookies made along the way onto the reply. */
export function withCookies(res: Response, out: { headers: Headers }): Response {
  for (const c of out.headers.getSetCookie()) res.headers.append("set-cookie", c);
  return res;
}
