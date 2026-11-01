/**
 * Who a visitor is when they train without signing in (open-train.md "Settled with wave 3"): the mm_trainer cookie.
 *
 * - The value is `tr1.<id>.<exp>.<sig>`: a random 128-bit id, an expiry in ms, and mac("trainer", ["tr1", id, exp]),
 *   keyed by toolKey("trainer") like the tool gateway's other principals, never the session key. Changing any part, or
 *   a token signed for another use, fails the check, and so does an expired one.
 * - It is minted only by mintTrainer, which the later wiring calls on a create POST, and at most
 *   PUBLIC_TRAIN_COOKIES_PER_IP new ones per IP per UTC day (reserveCounter on a dayWindow row). A request that already
 *   carries a good cookie keeps it: nothing is minted and nothing is counted.
 * - The trainer's id for counters and ownership is `t-<32 hex>`, an HMAC of the cookie's id, so the database never holds
 *   anything that rebuilds the cookie. On first use (ensureTrainerUser) it becomes a hidden users row,
 *   `t-<hex>@trainer.musemuse.invalid`, with no password and no builds; datasets and jobs point at it through their
 *   existing created_by. Sign-in refuses every @*.musemuse.invalid address (isReservedEmail), so nobody can claim it.
 * - adoptTrainerRuns moves one trainer's datasets and jobs to a signed-in user (a marked call in sign-in comes later).
 */
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { dayWindow, docsClientIp, secondsUntil } from "@/lib/docs/proxy/limits";
import { cookieValue } from "@/lib/drive/logic";
import { env } from "@/lib/env";
import { adjustCounter, counterValue, reserveCounter } from "@/lib/gateway/store";
import { mac, randomId, sameMac } from "@/lib/tools/sign";
import { TRAINER_EMAIL_DOMAIN } from "@/lib/train/public/reserved";

export const TRAINER_COOKIE = "mm_trainer";
export const TRAINER_COOKIE_DAYS = 30;
const VERSION = "tr1";
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const TRAINER_ID_RE = /^t-[0-9a-f]{32}$/;

export interface Trainer {
  /** `t-<32 hex>`: what counters and the hidden users row are keyed by. Safe to store and log. */
  trainerId: string;
  /** The hidden users row's address. */
  email: string;
  /** When the cookie stops working. */
  expiresAt: Date;
}

/** A refusal any lib/train/public check can return, for refusalResponse to turn into a reply. */
export interface Refusal {
  ok: false;
  status: number;
  code: string;
  /** A plain sentence for the person. */
  error: string;
  retryAfterSeconds?: number;
}

/** The refusal as a JSON reply ({error: code, message, retryAfterSeconds}), with Retry-After when there is one. */
export function refusalResponse(r: Refusal): Response {
  const headers = r.retryAfterSeconds ? { "retry-after": String(r.retryAfterSeconds) } : undefined;
  const body = { error: r.code, message: r.error, ...(r.retryAfterSeconds ? { retryAfterSeconds: r.retryAfterSeconds } : {}) };
  return Response.json(body, { status: r.status, headers });
}

function sign(id: string, exp: string): string {
  return mac("trainer", [VERSION, id, exp]);
}

/** The trainer id for a cookie id: an HMAC under the same key with its own first part, so it can't pass as a signature. */
export function trainerIdFor(cookieId: string): string {
  return `t-${Buffer.from(mac("trainer", ["user", cookieId]), "base64url").toString("hex").slice(0, 32)}`;
}

export function trainerEmail(trainerId: string): string {
  return `${trainerId}@${TRAINER_EMAIL_DOMAIN}`;
}

export function isTrainerId(value: unknown): value is string {
  return typeof value === "string" && TRAINER_ID_RE.test(value);
}

/** The cookie value for this id, good until `expiresAt`. Exported for tests; mintTrainer is the only caller in the app. */
export function encodeTrainer(cookieId: string, expiresAt: Date): string {
  const exp = String(expiresAt.getTime());
  return `${VERSION}.${cookieId}.${exp}.${sign(cookieId, exp)}`;
}

/** The trainer a cookie value names when its signature is right and it hasn't expired, else null. */
export function decodeTrainer(value: string | null | undefined, now: Date = new Date()): Trainer | null {
  const parts = (value ?? "").split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  const [, id, exp, sig] = parts;
  if (!ID_RE.test(id) || !/^\d{1,16}$/.test(exp)) return null;
  if (!sameMac(sig, sign(id, exp))) return null;
  const expMs = Number(exp);
  if (expMs <= now.getTime()) return null;
  const trainerId = trainerIdFor(id);
  return { trainerId, email: trainerEmail(trainerId), expiresAt: new Date(expMs) };
}

/** The trainer this request's mm_trainer cookie names, or null. Reads only; never mints. */
export function trainerOf(req: Request, now: Date = new Date()): Trainer | null {
  return decodeTrainer(cookieValue(req.headers.get("cookie"), TRAINER_COOKIE), now);
}

/** Set-Cookie for the trainer: httpOnly, SameSite=Lax, Path=/, Secure in production, TRAINER_COOKIE_DAYS days. */
export function trainerCookie(value: string, secure: boolean = process.env.NODE_ENV === "production"): string {
  const maxAge = TRAINER_COOKIE_DAYS * 86_400;
  return `${TRAINER_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** The rate_limits key for new cookies from one IP in a day. */
export const mintKey = (ip: string) => `train-pub:mint:ip:${ip}`;

export type MintResult = { ok: true; trainer: Trainer; minted: boolean } | Refusal;

/**
 * The trainer for a create POST: the request's own when its cookie is good (nothing minted, nothing counted), else a
 * new one whose Set-Cookie goes on `res`, within PUBLIC_TRAIN_COOKIES_PER_IP per IP per UTC day. Refuses while
 * PUBLIC_TRAINING is off, so nothing is ever minted then. `res` is anything with Headers: a Response, a NextResponse.
 */
export async function mintTrainer(req: Request, res: { headers: Headers }, now: Date = new Date()): Promise<MintResult> {
  if (!env.publicTraining) return { ok: false, status: 403, code: "public_training_off", error: "Admins only." };
  const known = trainerOf(req, now);
  if (known) return { ok: true, trainer: known, minted: false };
  const day = dayWindow(now);
  const limit = env.publicTrainCookiesPerIp;
  const taken = await reserveCounter(mintKey(docsClientIp(req.headers)), day, 1, limit);
  if (taken === null) {
    return {
      ok: false,
      status: 429,
      code: "trainer_ip_cap",
      error: `This network has started training as a new visitor ${limit} times today. Try again tomorrow, or keep the same browser.`,
      retryAfterSeconds: secondsUntil(day, now),
    };
  }
  const cookieId = randomId();
  const expiresAt = new Date(now.getTime() + TRAINER_COOKIE_DAYS * 86_400_000);
  res.headers.append("set-cookie", trainerCookie(encodeTrainer(cookieId, expiresAt)));
  return { ok: true, trainer: decodeTrainer(encodeTrainer(cookieId, expiresAt), now)!, minted: true };
}

/**
 * The trainer's hidden users row id, created on first use: no password (sign-in refuses its address anyway), never an
 * admin, and a daily build quota of 0. An existing row is left as it is.
 */
export async function ensureTrainerUser(trainerId: string): Promise<string> {
  if (!isTrainerId(trainerId)) throw new Error("not a trainer id");
  const email = trainerEmail(trainerId);
  const [row] = await db()
    .insert(schema.users)
    .values({ email, dailyBuildQuota: 0 })
    .onConflictDoUpdate({ target: schema.users.email, set: { email } })
    .returning({ id: schema.users.id });
  return row.id;
}

/** The trainer's users row id, or null before its first use. */
export async function trainerUserId(trainerId: string): Promise<string | null> {
  if (!isTrainerId(trainerId)) return null;
  const [row] = await db().select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, trainerEmail(trainerId))).limit(1);
  return row?.id ?? null;
}

/** The daily counters a trainer's day carries over to the user who adopts it (lib/train/public/limits.ts keys them). */
export const ADOPTED_COUNTERS = ["run", "dry", "dataset"] as const;
export const visitorCounterKey = (kind: (typeof ADOPTED_COUNTERS)[number], trainerId: string) => `train-pub:${kind}:v:${trainerId}`;

export interface Adopted {
  datasets: number;
  jobs: number;
}

/**
 * Moves the datasets and jobs this trainer made (created_by its hidden row) to `userId`, and adds its counts for today
 * to the user's, so signing in never resets a visitor's day. Only that trainer's rows move. A user id that is itself a
 * trainer row, or a trainer with no row yet, moves nothing. For the marked block in sign-in, with trainerOf(req).
 */
export async function adoptTrainerRuns(userId: string, trainerId: string, now: Date = new Date()): Promise<Adopted> {
  const none = { datasets: 0, jobs: 0 };
  const from = await trainerUserId(trainerId);
  if (!from || from === userId) return none;
  const [target] = await db().select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!target || target.email.endsWith(`@${TRAINER_EMAIL_DOMAIN}`)) return none;
  const datasets = await db()
    .update(schema.trainingDatasets)
    .set({ createdBy: userId })
    .where(eq(schema.trainingDatasets.createdBy, from))
    .returning({ id: schema.trainingDatasets.id });
  const jobs = await db()
    .update(schema.trainingJobs)
    .set({ createdBy: userId })
    .where(eq(schema.trainingJobs.createdBy, from))
    .returning({ id: schema.trainingJobs.id });
  const day = dayWindow(now);
  for (const kind of ADOPTED_COUNTERS) {
    const used = await counterValue(visitorCounterKey(kind, trainerId), day);
    if (used > 0) await adjustCounter(visitorCounterKey(kind, userId), day, used);
  }
  return { datasets: datasets.length, jobs: jobs.length };
}

/** Datasets and jobs a user id owns, for tests and the owner view: ids only. */
export async function ownedTrainingIds(userId: string): Promise<{ datasets: string[]; jobs: string[] }> {
  const [datasets, jobs] = await Promise.all([
    db().select({ id: schema.trainingDatasets.id }).from(schema.trainingDatasets).where(eq(schema.trainingDatasets.createdBy, userId)),
    db().select({ id: schema.trainingJobs.id }).from(schema.trainingJobs).where(eq(schema.trainingJobs.createdBy, userId)),
  ]);
  return { datasets: datasets.map((d) => d.id), jobs: jobs.map((j) => j.id) };
}
