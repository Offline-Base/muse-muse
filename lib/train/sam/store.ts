/**
 * SAM 3.1 tune runs in the database (sam_tune_runs, sam_workers; migration 0033). Every change the office board makes is
 * one statement guarded by the run's job token hash and status, because Neon's HTTP driver has no interactive
 * transactions. One run is claimed or running at a time: the partial unique index sam_tune_one_active holds that even
 * when two boards poll at once. The plain job token is handed to the board once, at claim, and never stored.
 */
import { createHash, randomBytes, randomInt } from "node:crypto";
import { and, count, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { putFile } from "@/lib/storage";
import { DEFAULT_EPOCHS, genericProblem, validateReportIn, finishReport, wordProblem } from "@/lib/train/sam/logic";
import {
  SAM_TUNE_LIMITS,
  type SamClaim,
  type SamData,
  type SamDistractor,
  type SamPhoto,
  type SamProgress,
  type SamReport,
  type SamRunView,
  type SamStage,
  type SamStatus,
  type SamWorkerPoll,
} from "@/lib/train/sam/types";

const runs = schema.samTuneRuns;
const workers = schema.samWorkers;
export type SamRunRow = typeof runs.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE: SamStatus[] = ["claimed", "running"];
/** The board won't start a run below these (worker.py refuses too); the server checks the poll as well. */
export const CLAIM_MIN_FREE_MEM_MB = 5632;
export const CLAIM_MIN_FREE_DISK_MB = 300;
export const LEASE_LOST = "The board stopped answering.";
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const UPLOAD_TYPES: Record<string, string[]> = { "image/jpeg": [".jpg", ".jpeg"], "application/json": [".json"] };

export function hashJobToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isUniqueClash(err: unknown): boolean {
  const code = (e: unknown) => (e as { code?: string } | null)?.code;
  return code(err) === "23505" || code((err as { cause?: unknown } | null)?.cause) === "23505";
}

/** A board line for the room: no control characters, at most `max` characters. */
function line(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\u2014/g, ", ").replace(/\s+/g, " ").trim().slice(0, max);
  return s || undefined;
}

// ---------- Admin side ----------

export interface CreateRunIn {
  word: string;
  generic: string;
  data: SamData;
  createdBy: string | null;
  seed?: number;
  epochs?: number;
  /** The run's own spend cap, held to SAM_TUNE_MAX_USD (the default). */
  maxUsd?: number;
}

export async function createRun(input: CreateRunIn): Promise<{ ok: true; run: SamRunView } | { ok: false; problem: string }> {
  const problem = wordProblem(input.word) ?? genericProblem(input.generic, input.word);
  if (problem) return { ok: false, problem };
  if (input.data !== "builtin-muse" && input.data !== "uploads") return { ok: false, problem: "Pick built-in Muse or your own photos." };
  if (input.data === "builtin-muse" && input.word !== "muse") return { ok: false, problem: "The built-in photos teach the name muse." };
  const [row] = await db()
    .insert(runs)
    .values({
      word: input.word,
      generic: input.generic,
      data: input.data,
      seed: input.seed ?? randomInt(1, 2 ** 31 - 1),
      epochs: input.epochs ?? DEFAULT_EPOCHS,
      maxUsd: Math.max(0, Math.min(Number.isFinite(input.maxUsd) ? input.maxUsd! : env.samTuneMaxUsd, env.samTuneMaxUsd)),
      createdBy: input.createdBy,
    })
    .returning();
  return { ok: true, run: await toView(row!, { full: true }) };
}

export async function getRun(id: string): Promise<SamRunRow | null> {
  if (!UUID.test(id)) return null;
  const [row] = await db().select().from(runs).where(eq(runs.id, id)).limit(1);
  return row ?? null;
}

/** The room's view. `full` adds the run's photos and look-alikes (admins only; the public view never has them). */
export async function getRunView(id: string, opts: { full?: boolean } = {}): Promise<SamRunView | null> {
  const row = await getRun(id);
  return row ? toView(row, opts) : null;
}

async function toView(row: SamRunRow, opts: { full?: boolean }): Promise<SamRunView> {
  const [ahead, seen] = await Promise.all([queueAhead(row), boardSeenAt()]);
  return {
    id: row.id,
    word: row.word,
    generic: row.generic,
    data: row.data,
    status: row.status,
    stage: row.stage ?? null,
    queueAhead: ahead,
    boardSeenAt: seen,
    report: row.report ?? null,
    costUsd: row.costUsd,
    maxUsd: row.maxUsd,
    shown: row.shown,
    createdAt: row.createdAt.toISOString(),
    ...(opts.full ? { photos: row.photos, distractors: row.distractors } : {}),
  };
}

/** How many runs the board will take before this one: the one going, and queued runs made earlier. 0 unless queued. */
export async function queueAhead(row: Pick<SamRunRow, "id" | "status" | "createdAt">): Promise<number> {
  if (row.status !== "queued") return 0;
  const [got] = await db()
    .select({ n: count() })
    .from(runs)
    .where(
      or(
        inArray(runs.status, ACTIVE),
        and(eq(runs.status, "queued"), or(lt(runs.createdAt, row.createdAt), and(eq(runs.createdAt, row.createdAt), lt(runs.id, row.id)))),
      ),
    );
  return Number(got?.n ?? 0);
}

/** When any office board last polled, as ISO, or null when none ever has. */
export async function boardSeenAt(): Promise<string | null> {
  const [got] = await db().select({ at: sql<string | Date | null>`max(${workers.seenAt})` }).from(workers);
  const at = got?.at;
  return at ? new Date(at).toISOString() : null;
}

/** Draft to queued. Start's caps (the run's max_usd, SAM_TUNE_DAILY_USD) are checked by the route before this. */
export async function queueRun(id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const rows = await db()
    .update(runs)
    .set({ status: "queued", updatedAt: new Date() })
    .where(and(eq(runs.id, id), eq(runs.status, "draft")))
    .returning({ id: runs.id });
  return rows.length === 1;
}

/** The run's own photos and look-alikes, while it is still a draft. */
export async function saveInputs(id: string, input: { photos?: SamPhoto[]; distractors?: SamDistractor[] }): Promise<boolean> {
  if (!UUID.test(id)) return false;
  if ((input.photos?.length ?? 0) > SAM_TUNE_LIMITS.photosMax || (input.distractors?.length ?? 0) > SAM_TUNE_LIMITS.distractorsMax) return false;
  const rows = await db()
    .update(runs)
    .set({ ...(input.photos ? { photos: input.photos } : {}), ...(input.distractors ? { distractors: input.distractors } : {}), updatedAt: new Date() })
    .where(and(eq(runs.id, id), eq(runs.status, "draft")))
    .returning({ id: runs.id });
  return rows.length === 1;
}

/** Adds Meta spend to the run's total (the day and run caps are held by the rate_limits counters, types.ts). */
export async function addCost(id: string, usd: number): Promise<void> {
  if (!UUID.test(id) || !(usd > 0)) return;
  await db().update(runs).set({ costUsd: sql`${runs.costUsd} + ${usd}`, updatedAt: new Date() }).where(eq(runs.id, id));
}

/**
 * Stop. A draft or queued run stops at once; a claimed or running one is marked, and the board sees it in its next
 * progress answer. Returns the status after, or null when the run is unknown or already over.
 */
export async function requestStop(id: string): Promise<SamStatus | null> {
  if (!UUID.test(id)) return null;
  const rows = await db()
    .update(runs)
    .set({
      status: sql`case when ${runs.status} in ('draft', 'queued') then 'stopped' else ${runs.status} end`,
      stopRequested: true,
      updatedAt: new Date(),
    })
    .where(and(eq(runs.id, id), inArray(runs.status, ["draft", "queued", "claimed", "running"])))
    .returning({ status: runs.status });
  return rows[0]?.status ?? null;
}

/** Shown runs are the only ones a signed-out visitor can read. Only a done run can be shown. */
export async function markShown(id: string, shown: boolean): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const rows = await db()
    .update(runs)
    .set({ shown, updatedAt: new Date() })
    .where(and(eq(runs.id, id), eq(runs.status, "done")))
    .returning({ id: runs.id });
  return rows.length === 1;
}

// ---------- Board side (the worker routes call these after requireWorker) ----------

/** Why a poll body is malformed, or null. */
export function pollProblem(v: Partial<SamWorkerPoll> | null | undefined): string | null {
  if (!v || typeof v.workerId !== "string" || !/^[a-z0-9-]{1,32}$/.test(v.workerId)) return "workerId";
  for (const k of ["freeMemMb", "freeDiskMb"] as const) {
    const n = v[k];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 10_000_000) return k;
  }
  return null;
}

export async function recordPoll(poll: SamWorkerPoll, now = new Date()): Promise<void> {
  await db()
    .insert(workers)
    .values({ workerId: poll.workerId, seenAt: now, freeMemMb: poll.freeMemMb, freeDiskMb: poll.freeDiskMb })
    .onConflictDoUpdate({ target: workers.workerId, set: { seenAt: now, freeMemMb: poll.freeMemMb, freeDiskMb: poll.freeDiskMb } });
}

/** Claimed or running runs whose lease ran out: failed, or stopped if Stop was asked. Returns how many. */
export async function expireLeases(now = new Date()): Promise<number> {
  const rows = await db()
    .update(runs)
    .set({
      status: sql`case when ${runs.stopRequested} then 'stopped' else 'failed' end`,
      error: sql`case when ${runs.stopRequested} then null else ${LEASE_LOST} end`,
      jobTokenHash: null,
      leaseUntil: null,
      updatedAt: now,
    })
    .where(and(inArray(runs.status, ACTIVE), lt(runs.leaseUntil, now)))
    .returning({ id: runs.id });
  return rows.length;
}

/**
 * One poll from a board: records it, expires lost leases, then hands over the oldest queued run in one statement, or
 * null. Null too when the board says it is short of memory or disk, or a run is already going.
 */
export async function claimNext(poll: SamWorkerPoll, now = new Date()): Promise<SamClaim | null> {
  await recordPoll(poll, now);
  await expireLeases(now);
  if (poll.freeMemMb < CLAIM_MIN_FREE_MEM_MB || poll.freeDiskMb < CLAIM_MIN_FREE_DISK_MB) return null;
  const token = randomBytes(32).toString("hex");
  const stage: SamProgress = { stage: "claimed", at: now.toISOString() };
  const oldest = sql`(select ${runs.id} from ${runs} where ${runs.status} = 'queued' order by ${runs.createdAt}, ${runs.id} limit 1 for update skip locked)`;
  let row: SamRunRow | undefined;
  try {
    [row] = await db()
      .update(runs)
      .set({
        status: "claimed",
        workerId: poll.workerId,
        jobTokenHash: hashJobToken(token),
        leaseUntil: new Date(now.getTime() + SAM_TUNE_LIMITS.leaseMs),
        stage,
        updatedAt: now,
      })
      .where(and(eq(runs.id, oldest), eq(runs.status, "queued")))
      .returning();
  } catch (err) {
    if (isUniqueClash(err)) return null;
    throw err;
  }
  if (!row) return null;
  return { id: row.id, word: row.word, generic: row.generic, data: row.data, photos: row.photos, distractors: row.distractors, seed: row.seed, epochs: row.epochs, jobToken: token };
}

/** The run with this job token, if it is still claimed or running. */
export async function runForToken(id: string, jobToken: unknown): Promise<SamRunRow | null> {
  if (!UUID.test(id) || typeof jobToken !== "string" || !/^[0-9a-f]{64}$/.test(jobToken)) return null;
  const [row] = await db()
    .select()
    .from(runs)
    .where(and(eq(runs.id, id), eq(runs.jobTokenHash, hashJobToken(jobToken)), inArray(runs.status, ACTIVE)))
    .limit(1);
  return row ?? null;
}

export interface ProgressIn {
  stage: SamStage;
  step?: number;
  steps?: number;
  line?: string;
}

const STAGES = new Set<SamStage>(["claimed", "building_sets", "loading_meta", "scoring_meta", "training", "loading_tune", "scoring_tune", "drawing", "uploading", "done"]);

/** Why a progress body is malformed, or null. */
export function progressProblem(v: Partial<ProgressIn> | null | undefined): string | null {
  if (!v || !STAGES.has(v.stage as SamStage)) return "stage";
  for (const k of ["step", "steps"] as const) {
    const n = v[k];
    if (n !== undefined && (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 1_000_000)) return k;
  }
  if (v.line !== undefined && typeof v.line !== "string") return "line";
  return null;
}

/** A stage report: the run is running, the lease is extended, and the answer says whether Stop was asked. Null for a wrong token or an ended run. */
export async function progress(id: string, jobToken: unknown, input: ProgressIn, now = new Date()): Promise<{ stop: boolean } | null> {
  if (progressProblem(input) || !UUID.test(id) || typeof jobToken !== "string") return null;
  const stage: SamProgress = {
    stage: input.stage,
    ...(input.step !== undefined ? { step: input.step } : {}),
    ...(input.steps !== undefined ? { steps: input.steps } : {}),
    ...(line(input.line, 200) ? { line: line(input.line, 200) } : {}),
    at: now.toISOString(),
  };
  const rows = await db()
    .update(runs)
    .set({ status: "running", stage, leaseUntil: new Date(now.getTime() + SAM_TUNE_LIMITS.leaseMs), updatedAt: now })
    .where(and(eq(runs.id, id), eq(runs.jobTokenHash, hashJobToken(jobToken)), inArray(runs.status, ACTIVE)))
    .returning({ stop: runs.stopRequested });
  return rows[0] ? { stop: rows[0].stop } : null;
}

export type UploadResult = { ok: true; url: string } | { ok: false; status: number; error: string };

/**
 * One report file from the board, saved under samtune/<id>/report/ (kept by the cleanup). At most uploadMaxBytes and
 * uploadsMax files a run, JPEG or JSON, the name's extension matching its type.
 */
export async function saveUpload(id: string, jobToken: unknown, name: string, contentType: string, bytes: Uint8Array): Promise<UploadResult> {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  const exts = UPLOAD_TYPES[type];
  if (!exts) return { ok: false, status: 415, error: "type" };
  if (!SAFE_NAME.test(name) || !exts.some((e) => name.toLowerCase().endsWith(e))) return { ok: false, status: 400, error: "name" };
  if (bytes.byteLength === 0 || bytes.byteLength > SAM_TUNE_LIMITS.uploadMaxBytes) return { ok: false, status: 413, error: "size" };
  const run = await runForToken(id, jobToken);
  if (!run) return { ok: false, status: 404, error: "not_found" };
  if (run.uploads.length >= SAM_TUNE_LIMITS.uploadsMax) return { ok: false, status: 429, error: "too_many_files" };
  const url = await putFile("samtune", `${id}/report/${randomBytes(6).toString("hex")}-${name}`, Buffer.from(bytes), type);
  // Appended only while under the cap and still this board's run. Two uploads racing for the last slot can leave one
  // file unlisted under report/; it is never shown, because a report may only point at listed files.
  const rows = await db()
    .update(runs)
    .set({ uploads: sql`${runs.uploads} || ${JSON.stringify([url])}::jsonb`, updatedAt: new Date() })
    .where(
      and(
        eq(runs.id, id),
        eq(runs.jobTokenHash, hashJobToken(jobToken as string)),
        inArray(runs.status, ACTIVE),
        sql`jsonb_array_length(${runs.uploads}) < ${SAM_TUNE_LIMITS.uploadsMax}`,
      ),
    )
    .returning({ id: runs.id });
  if (rows.length !== 1) return { ok: false, status: 429, error: "too_many_files" };
  return { ok: true, url };
}

export type FinishResult = { ok: true; report: SamReport } | { ok: false; status: number; error: string };

/**
 * The board's report. Checked against the run (validateReportIn), then the verdict and caveats are written here and the
 * run is done. The job token is cleared, so nothing more from the board is taken.
 */
export async function finish(id: string, jobToken: unknown, body: unknown, byteLength?: number, now = new Date()): Promise<FinishResult> {
  const run = await runForToken(id, jobToken);
  if (!run) return { ok: false, status: 404, error: "not_found" };
  const checked = validateReportIn(body, { word: run.word, generic: run.generic, seed: run.seed, data: run.data, workerId: run.workerId, uploads: run.uploads }, byteLength);
  if (!checked.ok) return { ok: false, status: checked.problem === "report_too_large" ? 413 : 400, error: checked.problem };
  const report = finishReport(checked.report);
  const rows = await db()
    .update(runs)
    .set({ status: "done", report, stage: { stage: "done", at: now.toISOString() }, leaseUntil: null, jobTokenHash: null, error: null, updatedAt: now })
    .where(and(eq(runs.id, id), eq(runs.jobTokenHash, hashJobToken(jobToken as string)), inArray(runs.status, ACTIVE)))
    .returning({ id: runs.id });
  if (rows.length !== 1) return { ok: false, status: 404, error: "not_found" };
  return { ok: true, report };
}

/** The board gave up: failed, or stopped if Stop was asked. The reason is kept, at most 500 characters. */
export async function fail(id: string, jobToken: unknown, reason: unknown, now = new Date()): Promise<SamStatus | null> {
  if (!UUID.test(id) || typeof jobToken !== "string") return null;
  const why = line(reason, 500) ?? "The board gave no reason.";
  const rows = await db()
    .update(runs)
    .set({
      status: sql`case when ${runs.stopRequested} then 'stopped' else 'failed' end`,
      error: why,
      leaseUntil: null,
      jobTokenHash: null,
      updatedAt: now,
    })
    .where(and(eq(runs.id, id), eq(runs.jobTokenHash, hashJobToken(jobToken)), inArray(runs.status, ACTIVE)))
    .returning({ status: runs.status });
  return rows[0]?.status ?? null;
}

/** Newest first, for the admin list. */
export async function listRuns(limit = 20): Promise<SamRunRow[]> {
  return db().select().from(runs).orderBy(desc(runs.createdAt)).limit(limit);
}
