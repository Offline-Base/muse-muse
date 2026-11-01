/**
 * Who may train, as one seam (open-train.md; docs/CAPABILITIES.md section 17 "Who may train"). The later wiring swaps
 * lib/train/tune/caller.ts's tuneCaller for trainCaller at the plan, runs, jobs, datasets and stop routes.
 *
 * - Admins and automation keep everything, exactly as requireAdminOrAutomation lets them in.
 * - PUBLIC_TRAINING off: everyone else is refused exactly as today (the same AuthError, thrown by the same call).
 * - PUBLIC_TRAINING on: everyone else is a visitor, under the visitor limits. A signed-in builder (trust's tier says
 *   builder while TRUST_SIGNED_IN_CAPS is on) trains as their own user id; anyone else by their mm_trainer cookie,
 *   which trainCallerForCreate mints on a create POST. A banned session is refused, and so is a visitor's request from
 *   another site.
 */
import { cookies } from "next/headers";
import { AuthError, decodeSession, isCrossSite, requireAdmin, requireAdminOrAutomation, SESSION_COOKIE, type SessionUser } from "@/lib/auth";
import { docsClientIp } from "@/lib/docs/proxy/limits";
import { env } from "@/lib/env";
import { DATASET_MAX_COUNT } from "@/lib/train/logic";
import { ensureTrainerUser, mintTrainer, trainerOf, type Refusal } from "@/lib/train/public/identity";
import { visitorLimits, type VisitorLimits } from "@/lib/train/public/limits";
import { isBanned, mayTrainAsSelf, signedInCapsOn, tierFor } from "@/lib/train/public/trust";

export interface AdminCaller {
  kind: "admin";
  /** What requireAdminOrAutomation returned. */
  user: SessionUser;
}

export interface VisitorCaller {
  kind: "visitor";
  /**
   * A signed-in builder's user id, a cookie visitor's `t-<hex>` trainer id, or null for a visitor with no cookie yet
   * (they can look, and trainCallerForCreate gives them one before anything is made).
   */
  trainerId: string | null;
  /** True when trainerId is a signed-in builder's own user id. */
  signedIn: boolean;
  /** The client IP's key, for the per-IP counters. */
  ip: string;
  limits: VisitorLimits;
}

export type TrainCaller = AdminCaller | VisitorCaller;

export const BANNED_MESSAGE = "This account can't train on Muse Muse.";

/**
 * The caller of a training route. Throws AuthError as requireAdminOrAutomation does (401 or 403). Never mints a cookie
 * and never writes a training row or a trainer's users row (ownerUserId does that, on first use).
 */
export async function trainCaller(req: Request, now: Date = new Date()): Promise<TrainCaller> {
  if (!env.publicTraining) return { kind: "admin", user: await requireAdminOrAutomation(req) };
  // A bearer header is automation or nothing: a wrong secret stays refused, never a visitor.
  if (req.headers.get("authorization")?.startsWith("Bearer ")) return { kind: "admin", user: await requireAdminOrAutomation(req) };
  try {
    return { kind: "admin", user: await requireAdmin() };
  } catch (err) {
    if (!(err instanceof AuthError)) throw err;
  }
  // The session as signed, read straight from the cookie: a banned user's session must be refused, not quietly
  // treated as a visitor with no session (wave 3's getSessionUser drops banned sessions).
  const session = decodeSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (session && (await isBanned(session.id))) throw new AuthError(BANNED_MESSAGE, 403);
  if (isCrossSite(req.headers)) throw new AuthError("Requests from other sites can't train here.", 403);
  const ip = docsClientIp(req.headers);
  const limits = visitorLimits();
  if (session && signedInCapsOn()) {
    const tier = await tierFor(session);
    if (tier === "banned") throw new AuthError(BANNED_MESSAGE, 403);
    if (mayTrainAsSelf(tier)) return { kind: "visitor", trainerId: session.id, signedIn: true, ip, limits };
  }
  return { kind: "visitor", trainerId: trainerOf(req, now)?.trainerId ?? null, signedIn: false, ip, limits };
}

export type CreateCaller = { ok: true; caller: TrainCaller } | Refusal;

/**
 * trainCaller for a route that makes something (a plan, a dataset, a run): a cookie visitor without a cookie gets one,
 * with its Set-Cookie on `res`, within the per-IP cap. Admins and signed-in builders are never given a cookie.
 */
export async function trainCallerForCreate(req: Request, res: { headers: Headers }, now: Date = new Date()): Promise<CreateCaller> {
  const caller = await trainCaller(req, now);
  if (caller.kind === "admin" || caller.trainerId) return { ok: true, caller };
  const minted = await mintTrainer(req, res, now);
  if (!minted.ok) return minted;
  return { ok: true, caller: { ...caller, trainerId: minted.trainer.trainerId } };
}

/**
 * The id the plan token, the rate-limit key and the run's owner check use: the admin's user id, or the visitor's
 * trainer id. Null for a visitor with no cookie yet.
 */
export function callerKey(caller: TrainCaller): string | null {
  return caller.kind === "admin" ? caller.user.id : caller.trainerId;
}

/**
 * The users row id that owns what this caller makes (created_by): the admin's or signed-in builder's own id, or the
 * cookie visitor's hidden row, created on first use. Throws for a visitor with no cookie: use trainCallerForCreate.
 */
export async function ownerUserId(caller: TrainCaller): Promise<string> {
  if (caller.kind === "admin") return caller.user.id;
  if (!caller.trainerId) throw new Error("a visitor needs a trainer cookie before making anything");
  return caller.signedIn ? caller.trainerId : ensureTrainerUser(caller.trainerId);
}

/** True while this caller is a visitor, whose jobs are forced to publish 0 and whose limits apply. */
export function isVisitor(caller: TrainCaller): caller is VisitorCaller {
  return caller.kind === "visitor";
}

/**
 * The most examples this caller's run may ask for: the visitor cap (PUBLIC_TRAIN_DATASET_MAX_ROWS, 100) for visitors,
 * the datasets route's 1000 (tuneExamplesMax today) for everyone else.
 */
export function trainExamplesMax(caller: TrainCaller): number {
  return caller.kind === "visitor" ? caller.limits.datasetMaxRows : DATASET_MAX_COUNT;
}
