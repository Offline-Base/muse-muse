import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { GUEST_EMAIL } from "@/lib/auth";
import { db, schema } from "@/lib/db/client";
import { jobsBlock } from "@/lib/caps/jobs/brief";
import { JOBS_LIMITS } from "@/lib/caps/jobs/limits";
import { nextRunAfter, parseEvery } from "@/lib/caps/jobs/schedule";
import { buildBrief } from "@/lib/caps/store";

/**
 * The jobs cap's rows (docs/CAPABILITIES.md, section 12). Every step that hands a run from one state to another is one
 * conditional update, so two cron passes, or a retry and a late answer, can't both win.
 */

export type JobStatus = "queued" | "running" | "done" | "failed" | "budget" | "cancelled";
export type JobTrigger = "schedule" | "webhook" | "enqueue" | "test";
export type NoticeKind = "job" | "job_failed" | "schedule_paused" | "send_held";

export interface JobRun {
  id: string;
  productId: string;
  name: string;
  trigger: JobTrigger;
  namespace: string;
  status: JobStatus;
  attempt: number;
  tick: number;
  checkpoint: unknown;
  input: unknown;
  budgetUsd: number;
  costUsd: number;
  rowsWritten: number;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
}

/** A run the cron claimed: what it needs to call the product. */
export interface ClaimedRun {
  id: string;
  productId: string;
  name: string;
  tick: number;
  attempt: number;
  liveUrl: string;
}

export interface WebhookRow {
  id: string;
  productId: string;
  namespace: string;
  name: string;
  secretHash: string;
}

export interface NoticeInput {
  productId: string;
  namespace: string;
  kind: NoticeKind;
  title: string;
  body: string;
  payload?: unknown;
}

export interface JobsStore {
  getRun(runId: string): Promise<JobRun | null>;
  queueRun(input: { productId: string; namespace: string; name: string; trigger: JobTrigger; input?: unknown; webhookId?: string | null; budgetUsd: number }): Promise<string>;
  /** Saves a checkpoint and ends the tick. "stale" when this try of this tick isn't the one running any more. */
  closeTick(runId: string, tick: { tick: number; attempt: number; state: unknown; done: boolean; error: string | null; maxTicks: number }, now: Date): Promise<JobStatus | "stale">;
  /** A build's fire: the queued run of this name goes on, or a new one starts. */
  fireTest(input: { productId: string; namespace: string; name: string; input: unknown; budgetUsd: number }, now: Date): Promise<JobRun>;
  addNotice(input: NoticeInput): Promise<string>;
  findWebhook(productId: string, name: string): Promise<WebhookRow | null>;
  findTestWebhook(productId: string, buildId: string, name: string): Promise<WebhookRow | null>;
  saveTestWebhook(productId: string, namespace: string, name: string, secretHash: string): Promise<void>;
}

const RUN_COLUMNS = {
  id: schema.jobRuns.id,
  productId: schema.jobRuns.productId,
  name: schema.jobRuns.name,
  trigger: schema.jobRuns.trigger,
  namespace: schema.jobRuns.namespace,
  status: schema.jobRuns.status,
  attempt: schema.jobRuns.attempt,
  tick: schema.jobRuns.tick,
  checkpoint: schema.jobRuns.checkpoint,
  input: schema.jobRuns.input,
  budgetUsd: schema.jobRuns.budgetUsd,
  costUsd: schema.jobRuns.costUsd,
  rowsWritten: schema.jobRuns.rowsWritten,
  error: schema.jobRuns.error,
  createdAt: schema.jobRuns.createdAt,
  startedAt: schema.jobRuns.startedAt,
};

const rowsOf = <T>(result: unknown): T[] => {
  const r = result as { rows?: T[] } | T[];
  return Array.isArray(r) ? r : (r.rows ?? []);
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const jobsStore: JobsStore = {
  async getRun(runId) {
    if (!UUID.test(runId)) return null;
    const [row] = await db().select(RUN_COLUMNS).from(schema.jobRuns).where(eq(schema.jobRuns.id, runId)).limit(1);
    return row ?? null;
  },

  async queueRun(input) {
    const [row] = await db()
      .insert(schema.jobRuns)
      .values({ productId: input.productId, namespace: input.namespace, name: input.name, trigger: input.trigger, input: (input.input ?? null) as never, webhookId: input.webhookId ?? null, budgetUsd: input.budgetUsd })
      .returning({ id: schema.jobRuns.id });
    return row!.id;
  },

  async closeTick(runId, tick, now) {
    const stillGoing = !tick.error && !tick.done;
    const outOfTicks = stillGoing && tick.tick >= tick.maxTicks;
    const status: JobStatus = tick.error || outOfTicks ? "failed" : tick.done ? "done" : "queued";
    const [row] = await db()
      .update(schema.jobRuns)
      .set({
        status,
        attempt: 0,
        checkpoint: (tick.state ?? null) as never,
        error: tick.error ?? (outOfTicks ? `It used all of its ${tick.maxTicks} ticks.` : null),
        ...(status === "queued" ? {} : { finishedAt: now }),
      })
      .where(and(eq(schema.jobRuns.id, runId), eq(schema.jobRuns.status, "running"), eq(schema.jobRuns.tick, tick.tick), eq(schema.jobRuns.attempt, tick.attempt)))
      .returning({ status: schema.jobRuns.status });
    return row?.status ?? "stale";
  },

  async fireTest(input, now) {
    const [queued] = await db()
      .select({ id: schema.jobRuns.id })
      .from(schema.jobRuns)
      .where(and(eq(schema.jobRuns.productId, input.productId), eq(schema.jobRuns.namespace, input.namespace), eq(schema.jobRuns.name, input.name), eq(schema.jobRuns.status, "queued")))
      .orderBy(schema.jobRuns.createdAt)
      .limit(1);
    if (queued) {
      const [resumed] = await db()
        .update(schema.jobRuns)
        .set({ status: "running", tick: sql`${schema.jobRuns.tick} + 1`, attempt: 1, startedAt: now })
        .where(and(eq(schema.jobRuns.id, queued.id), eq(schema.jobRuns.status, "queued")))
        .returning(RUN_COLUMNS);
      if (resumed) return resumed;
    }
    const [row] = await db()
      .insert(schema.jobRuns)
      .values({ productId: input.productId, namespace: input.namespace, name: input.name, trigger: "test", input: (input.input ?? null) as never, budgetUsd: input.budgetUsd, status: "running", tick: 1, attempt: 1, startedAt: now })
      .returning(RUN_COLUMNS);
    return row!;
  },

  async addNotice(input) {
    const [row] = await db()
      .insert(schema.ownerNotices)
      .values({ productId: input.productId, namespace: input.namespace, kind: input.kind, title: input.title, body: input.body, payload: (input.payload ?? null) as never })
      .returning({ id: schema.ownerNotices.id });
    return row!.id;
  },

  async findWebhook(productId, name) {
    if (!UUID.test(productId)) return null;
    const [row] = await db()
      .select({ id: schema.productWebhooks.id, productId: schema.productWebhooks.productId, namespace: schema.productWebhooks.namespace, name: schema.productWebhooks.name, secretHash: schema.productWebhooks.secretHash })
      .from(schema.productWebhooks)
      .where(and(eq(schema.productWebhooks.productId, productId), eq(schema.productWebhooks.name, name), isNull(schema.productWebhooks.revokedAt), eq(schema.productWebhooks.namespace, "live")))
      .limit(1);
    return row ?? null;
  },

  async findTestWebhook(productId, buildId, name) {
    if (!UUID.test(productId) || !UUID.test(buildId)) return null;
    const [row] = await db()
      .select({ id: schema.productWebhooks.id, productId: schema.productWebhooks.productId, namespace: schema.productWebhooks.namespace, name: schema.productWebhooks.name, secretHash: schema.productWebhooks.secretHash })
      .from(schema.productWebhooks)
      .where(and(eq(schema.productWebhooks.productId, productId), eq(schema.productWebhooks.name, name), isNull(schema.productWebhooks.revokedAt), eq(schema.productWebhooks.namespace, `b:${buildId}`)))
      .limit(1);
    return row ?? null;
  },

  async saveTestWebhook(productId, namespace, name, secretHash) {
    await db().batch([
      db().delete(schema.productWebhooks).where(and(eq(schema.productWebhooks.productId, productId), eq(schema.productWebhooks.namespace, namespace), eq(schema.productWebhooks.name, name))),
      db().insert(schema.productWebhooks).values({ productId, namespace, name, secretHash }),
    ]);
  },
};

/** A product's live token, for its cap markers. */
export async function liveTokenOf(productId: string): Promise<{ scope: string; allowedModels: string[] } | null> {
  const [row] = await db()
    .select({ scope: schema.gatewayTokens.scope, allowedModels: schema.gatewayTokens.allowedModels })
    .from(schema.gatewayTokens)
    .where(and(eq(schema.gatewayTokens.productId, productId), eq(schema.gatewayTokens.scope, "live"), isNull(schema.gatewayTokens.revokedAt)))
    .orderBy(desc(schema.gatewayTokens.createdAt))
    .limit(1);
  return row ?? null;
}

// ---------- The gateway's model calls (lib/gateway/handler.ts) ----------

export async function addRunCost(runId: string, usd: number): Promise<void> {
  if (!usd) return;
  await db().update(schema.jobRuns).set({ costUsd: sql`${schema.jobRuns.costUsd} + ${usd}` }).where(eq(schema.jobRuns.id, runId));
}

/** A run over its dollars stops here, and says so. Only a running or waiting run. True when this call stopped it. */
export async function stopRunForBudget(runId: string, now: Date, why = "It reached its dollar limit."): Promise<boolean> {
  const rows = await db()
    .update(schema.jobRuns)
    .set({ status: "budget", error: why, finishedAt: now })
    .where(and(eq(schema.jobRuns.id, runId), inArray(schema.jobRuns.status, ["running", "queued"])))
    .returning({ id: schema.jobRuns.id });
  return rows.length > 0;
}

/** A row the data route saved for this run (lib/caps/data/handler.ts), for the record the fixed check reads. */
export async function noteRunWrote(runId: string): Promise<void> {
  if (!UUID.test(runId)) return;
  await db().update(schema.jobRuns).set({ rowsWritten: sql`${schema.jobRuns.rowsWritten} + 1` }).where(eq(schema.jobRuns.id, runId));
}

// ---------- The cron (lib/caps/jobs/cron.ts) ----------

/**
 * Who the cron may run for, as a SQL condition on products p and users u (decision 10): a live product with a link, not
 * taken down, whose owner is a signed-in builder, not banned and not the shared guest.
 */
const runnable = () => sql`p.status in ('live', 'partial') and p.live_url is not null and p.taken_down_at is null and u.banned_at is null and u.email <> ${GUEST_EMAIL}`;

/** Schedules whose owner hasn't visited in `days`: paused, with one notice per product. Returns how many. */
export async function pauseAbsent(now: Date, days: number): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const rows = rowsOf<{ product_id: string; name: string }>(
    await db().execute(sql`update product_schedules s set paused_at = ${now.toISOString()}::timestamptz, pause_reason = 'owner_away'
      from products p
      where p.id = s.product_id and s.paused_at is null and coalesce(p.owner_seen_at, p.created_at) < ${cutoff.toISOString()}::timestamptz
      returning s.product_id, s.name`),
  );
  for (const productId of new Set(rows.map((r) => r.product_id))) {
    await jobsStore.addNotice({
      productId,
      namespace: "live",
      kind: "schedule_paused",
      title: "Schedules paused",
      body: `This product's schedules stopped because nobody has opened it as the owner in ${days} days. Open the product's page to start them again.`,
    });
  }
  return rows.length;
}

/** Due schedules each get one queued run and their next slot. Returns how many it queued. */
export async function queueDueSchedules(now: Date, budgetUsd: number, limit: number = JOBS_LIMITS.duePerPass): Promise<number> {
  const due = rowsOf<{ id: string; product_id: string; name: string; every_minutes: number; at_minute: number | null; tz: string; next_run_at: string | Date }>(
    await db().execute(sql`select s.id, s.product_id, s.name, s.every_minutes, s.at_minute, s.tz, s.next_run_at
      from product_schedules s join products p on p.id = s.product_id join users u on u.id = p.owner_id
      where s.paused_at is null and s.next_run_at <= ${now.toISOString()}::timestamptz and ${runnable()}
      order by s.next_run_at limit ${limit}`),
  );
  let queued = 0;
  for (const s of due) {
    const next = nextRunAfter({ everyMinutes: Math.max(JOBS_LIMITS.minEveryMinutes, s.every_minutes), atMinute: s.at_minute, tz: s.tz }, now);
    const moved = await db()
      .update(schema.productSchedules)
      .set({ nextRunAt: next, lastRunAt: now })
      .where(and(eq(schema.productSchedules.id, s.id), eq(schema.productSchedules.nextRunAt, new Date(s.next_run_at)), isNull(schema.productSchedules.pausedAt)))
      .returning({ id: schema.productSchedules.id });
    if (!moved.length) continue;
    // At most one unfinished run per schedule (job_runs_active_schedule_idx): a slot that comes while the last run is
    // still going is skipped.
    const made = await db()
      .insert(schema.jobRuns)
      .values({ productId: s.product_id, scheduleId: s.id, name: s.name, trigger: "schedule", budgetUsd })
      .onConflictDoNothing()
      .returning({ id: schema.jobRuns.id });
    queued += made.length;
  }
  return queued;
}

/**
 * Ticks whose time ran out go back in the queue, or fail after their last try. A live product's only: a build's test
 * fire isn't the cron's. Returns the runs that failed, for the owner's notice.
 */
export async function expireStale(now: Date): Promise<Array<{ id: string; productId: string; name: string }>> {
  const cutoff = new Date(now.getTime() - JOBS_LIMITS.staleMs);
  await db()
    .update(schema.jobRuns)
    .set({ status: "queued" })
    .where(and(eq(schema.jobRuns.status, "running"), eq(schema.jobRuns.namespace, "live"), lt(schema.jobRuns.startedAt, cutoff), lt(schema.jobRuns.attempt, JOBS_LIMITS.maxAttempts)));
  return db()
    .update(schema.jobRuns)
    .set({ status: "failed", error: "It didn't finish in time.", finishedAt: now })
    .where(and(eq(schema.jobRuns.status, "running"), eq(schema.jobRuns.namespace, "live"), lt(schema.jobRuns.startedAt, cutoff)))
    .returning({ id: schema.jobRuns.id, productId: schema.jobRuns.productId, name: schema.jobRuns.name });
}

/**
 * Takes up to `limit` queued live runs of products the cron may run for, one conditional update. A first try of a tick
 * counts a tick. A run this pass already called waits for the next pass, so a tick's next step or retry is a pass away and
 * one run can't take a whole pass. Runs past their age limit are cancelled first, so an old queue never fires.
 */
export async function claimQueued(limit: number, now: Date, passStartedAt: Date = now): Promise<ClaimedRun[]> {
  if (limit <= 0) return [];
  const oldest = new Date(now.getTime() - JOBS_LIMITS.runMaxAgeMs);
  await db()
    .update(schema.jobRuns)
    .set({ status: "cancelled", error: "It waited too long to run.", finishedAt: now })
    .where(and(eq(schema.jobRuns.status, "queued"), eq(schema.jobRuns.namespace, "live"), lt(schema.jobRuns.createdAt, oldest)));
  const rows = rowsOf<{ id: string; product_id: string; name: string; tick: number; attempt: number; live_url: string }>(
    await db().execute(sql`with picked as (
        select r.id, p.live_url from job_runs r
          join products p on p.id = r.product_id join users u on u.id = p.owner_id
        where r.status = 'queued' and r.namespace = 'live' and ${runnable()}
          and (r.started_at is null or r.started_at < ${passStartedAt.toISOString()}::timestamptz)
        order by r.created_at limit ${limit} for update of r skip locked
      )
      update job_runs r set status = 'running', started_at = ${now.toISOString()}::timestamptz,
        tick = case when r.attempt = 0 then r.tick + 1 else r.tick end, attempt = r.attempt + 1
      from picked where r.id = picked.id
      returning r.id, r.product_id, r.name, r.tick, r.attempt, picked.live_url`),
  );
  return rows.map((r) => ({ id: r.id, productId: r.product_id, name: r.name, tick: Number(r.tick), attempt: Number(r.attempt), liveUrl: r.live_url }));
}

/** A tick the product didn't take: tried again next pass, or failed after its last try. Returns "failed" when it ended. */
export async function retryOrFail(run: ClaimedRun, error: string, now: Date): Promise<"queued" | "failed" | "stale"> {
  const last = run.attempt >= JOBS_LIMITS.maxAttempts;
  const [row] = await db()
    .update(schema.jobRuns)
    .set(last ? { status: "failed", error, finishedAt: now } : { status: "queued", error })
    .where(and(eq(schema.jobRuns.id, run.id), eq(schema.jobRuns.status, "running"), eq(schema.jobRuns.attempt, run.attempt), eq(schema.jobRuns.tick, run.tick)))
    .returning({ status: schema.jobRuns.status });
  return (row?.status as "queued" | "failed" | undefined) ?? "stale";
}

/** One notice per product and title while unread, so a job failing on a schedule doesn't fill the owner's page. */
export async function addNoticeOnce(input: NoticeInput): Promise<void> {
  const [open] = await db()
    .select({ id: schema.ownerNotices.id })
    .from(schema.ownerNotices)
    .where(and(eq(schema.ownerNotices.productId, input.productId), eq(schema.ownerNotices.namespace, input.namespace), eq(schema.ownerNotices.title, input.title), isNull(schema.ownerNotices.readAt)))
    .limit(1);
  if (!open) await jobsStore.addNotice(input);
}

// ---------- Deploy, owner visits and the product going off ----------

/** Makes a product's schedules what its brief and manifest say (register). Returns what's scheduled. */
export async function syncSchedules(input: { productId: string; schedules: Array<{ name: string; every: string }>; now: Date }): Promise<string[]> {
  const parsed = input.schedules.flatMap((s) => {
    const every = parseEvery(s.every);
    return every ? [{ name: s.name, every }] : [];
  });
  const names = parsed.map((s) => s.name);
  await db()
    .update(schema.products)
    .set({ ownerSeenAt: input.now })
    .where(eq(schema.products.id, input.productId));
  const gone = await db()
    .delete(schema.productSchedules)
    .where(and(eq(schema.productSchedules.productId, input.productId), names.length ? sql`${schema.productSchedules.name} not in (${sql.join(names.map((n) => sql`${n}`), sql`, `)})` : sql`true`))
    .returning({ name: schema.productSchedules.name });
  if (gone.length) await cancelQueued(input.productId, "Its schedule is gone.", input.now, gone.map((g) => g.name));
  for (const s of parsed) {
    const next = nextRunAfter(s.every, input.now);
    await db()
      .insert(schema.productSchedules)
      .values({ productId: input.productId, name: s.name, everyMinutes: s.every.everyMinutes, atMinute: s.every.atMinute, tz: s.every.tz, nextRunAt: next })
      .onConflictDoUpdate({
        target: [schema.productSchedules.productId, schema.productSchedules.name],
        set: { everyMinutes: s.every.everyMinutes, atMinute: s.every.atMinute, tz: s.every.tz, nextRunAt: next, pausedAt: null, pauseReason: null },
      });
  }
  return names;
}

async function cancelQueued(productId: string, error: string, now: Date, names?: string[]): Promise<void> {
  await db()
    .update(schema.jobRuns)
    .set({ status: "cancelled", error, finishedAt: now })
    .where(and(eq(schema.jobRuns.productId, productId), eq(schema.jobRuns.namespace, "live"), eq(schema.jobRuns.status, "queued"), names ? inArray(schema.jobRuns.name, names) : undefined));
}

/**
 * The owner opened the product's page or got an owner pass: the 14 days start over, and schedules paused for being away
 * or for the product being off start again if it's on.
 */
export async function noteOwnerSeen(productId: string, now: Date = new Date()): Promise<void> {
  await db().update(schema.products).set({ ownerSeenAt: now }).where(eq(schema.products.id, productId));
  const paused = await db()
    .select({ id: schema.productSchedules.id, everyMinutes: schema.productSchedules.everyMinutes, atMinute: schema.productSchedules.atMinute, tz: schema.productSchedules.tz })
    .from(schema.productSchedules)
    .innerJoin(schema.products, eq(schema.products.id, schema.productSchedules.productId))
    .where(and(eq(schema.productSchedules.productId, productId), sql`${schema.productSchedules.pausedAt} is not null`, inArray(schema.products.status, ["live", "partial"]), isNull(schema.products.takenDownAt)));
  for (const s of paused) {
    await db()
      .update(schema.productSchedules)
      .set({ pausedAt: null, pauseReason: null, nextRunAt: nextRunAfter(s, now) })
      .where(eq(schema.productSchedules.id, s.id));
  }
}

/** The product was turned off or taken down: its schedules pause and its queue empties. Its webhooks are refused at the door. */
export async function jobsProductOff(productId: string): Promise<void> {
  const now = new Date();
  await db()
    .update(schema.productSchedules)
    .set({ pausedAt: now, pauseReason: "product_off" })
    .where(and(eq(schema.productSchedules.productId, productId), isNull(schema.productSchedules.pausedAt)));
  await cancelQueued(productId, "The product was turned off.", now);
}

// ---------- Build's record, cleanup ----------

/** What the gateway saw for a build (/caps/proof), counted from `since`. Product code can't write any of it. */
export async function jobsProof(buildId: string, window: { since: Date | null }): Promise<Record<string, number>> {
  const brief = await buildBrief(buildId);
  const block = jobsBlock(brief as object | null);
  const out: Record<string, number> = { fired: 0, done: 0, resumed: 0, webhook_runs: 0, rows: 0, notices: 0, held: 0, stopped: 0 };
  for (const s of block?.schedules ?? []) out[`brief:schedule:${s.name}`] = 1;
  for (const w of block?.webhooks ?? []) out[`brief:webhook:${w.name}`] = 1;
  for (const r of block?.results ?? []) out[`brief:result:${r}`] = 1;
  const ns = `b:${buildId}`;
  const at = (column: "created_at" | "started_at" | "finished_at") => (window.since ? sql`${sql.raw(column)} >= ${window.since.toISOString()}::timestamptz` : sql`true`);
  const since = at("created_at");
  const finishedSince = at("finished_at");
  const [runs] = rowsOf<Record<string, number>>(
    await db().execute(sql`select
        count(*) filter (where tick > 0 and ${at("started_at")})::int as fired,
        count(*) filter (where status = 'done' and ${finishedSince})::int as done,
        count(*) filter (where status = 'done' and tick >= 2 and ${finishedSince})::int as resumed,
        count(*) filter (where trigger = 'webhook' and status = 'done' and ${finishedSince})::int as webhook_runs,
        coalesce(sum(rows_written) filter (where status = 'done' and ${finishedSince}), 0)::int as rows,
        count(*) filter (where status = 'budget' and ${finishedSince})::int as stopped
      from job_runs where namespace = ${ns}`),
  );
  for (const [k, v] of Object.entries(runs ?? {})) out[k] = Number(v);
  const [notices] = rowsOf<Record<string, number>>(
    await db().execute(sql`select count(*) filter (where kind <> 'send_held')::int as notices, count(*) filter (where kind = 'send_held')::int as held
      from owner_notices where namespace = ${ns} and ${since}`),
  );
  for (const [k, v] of Object.entries(notices ?? {})) out[k] = Number(v);
  return out;
}

// ---------- The owner's pages ----------

export interface NoticeRow {
  id: string;
  productId: string;
  productSlug: string;
  productName: string;
  kind: NoticeKind;
  title: string;
  body: string;
  payload: unknown;
  createdAt: Date;
  resolvedAt: Date | null;
}

/** A person's unread notices across the products they own. */
export async function listNotices(ownerId: string, limit = 20): Promise<NoticeRow[]> {
  return db()
    .select({
      id: schema.ownerNotices.id,
      productId: schema.ownerNotices.productId,
      productSlug: schema.products.slug,
      productName: schema.products.name,
      kind: schema.ownerNotices.kind,
      title: schema.ownerNotices.title,
      body: schema.ownerNotices.body,
      payload: schema.ownerNotices.payload,
      createdAt: schema.ownerNotices.createdAt,
      resolvedAt: schema.ownerNotices.resolvedAt,
    })
    .from(schema.ownerNotices)
    .innerJoin(schema.products, eq(schema.products.id, schema.ownerNotices.productId))
    .where(and(eq(schema.products.ownerId, ownerId), eq(schema.ownerNotices.namespace, "live"), isNull(schema.ownerNotices.readAt)))
    .orderBy(desc(schema.ownerNotices.createdAt))
    .limit(limit);
}

export async function noticeOf(productId: string, id: string): Promise<{ id: string; kind: NoticeKind; payload: unknown; resolvedAt: Date | null } | null> {
  if (!UUID.test(id)) return null;
  const [row] = await db()
    .select({ id: schema.ownerNotices.id, kind: schema.ownerNotices.kind, payload: schema.ownerNotices.payload, resolvedAt: schema.ownerNotices.resolvedAt })
    .from(schema.ownerNotices)
    .where(and(eq(schema.ownerNotices.id, id), eq(schema.ownerNotices.productId, productId), eq(schema.ownerNotices.namespace, "live")))
    .limit(1);
  return row ?? null;
}

export async function markNoticeRead(id: string, now: Date): Promise<void> {
  await db().update(schema.ownerNotices).set({ readAt: now }).where(eq(schema.ownerNotices.id, id));
}

/** Takes a held send for the owner's answer, once. False when it was already answered. */
export async function claimNotice(id: string, now: Date): Promise<boolean> {
  const rows = await db().update(schema.ownerNotices).set({ resolvedAt: now, readAt: now }).where(and(eq(schema.ownerNotices.id, id), isNull(schema.ownerNotices.resolvedAt))).returning({ id: schema.ownerNotices.id });
  return rows.length > 0;
}

/** Gives a claimed held send back, when it wasn't sent and the owner can try again. */
export async function releaseNotice(id: string): Promise<void> {
  await db().update(schema.ownerNotices).set({ resolvedAt: null, readAt: null }).where(eq(schema.ownerNotices.id, id));
}

export interface JobsPanelData {
  schedules: Array<{ name: string; everyMinutes: number; atMinute: number | null; tz: string; nextRunAt: Date; lastRunAt: Date | null; pausedAt: Date | null; pauseReason: string | null }>;
  webhooks: Array<{ name: string; createdAt: Date }>;
  runs: Array<{ id: string; name: string; trigger: string; status: string; tick: number; costUsd: number; error: string | null; createdAt: Date }>;
}

/** What the product page's Background jobs panel shows its owner. */
export async function jobsPanel(productId: string): Promise<JobsPanelData> {
  const [schedules, webhooks, runs] = await Promise.all([
    db()
      .select({
        name: schema.productSchedules.name,
        everyMinutes: schema.productSchedules.everyMinutes,
        atMinute: schema.productSchedules.atMinute,
        tz: schema.productSchedules.tz,
        nextRunAt: schema.productSchedules.nextRunAt,
        lastRunAt: schema.productSchedules.lastRunAt,
        pausedAt: schema.productSchedules.pausedAt,
        pauseReason: schema.productSchedules.pauseReason,
      })
      .from(schema.productSchedules)
      .where(eq(schema.productSchedules.productId, productId))
      .orderBy(schema.productSchedules.name),
    db()
      .select({ name: schema.productWebhooks.name, createdAt: schema.productWebhooks.createdAt })
      .from(schema.productWebhooks)
      .where(and(eq(schema.productWebhooks.productId, productId), eq(schema.productWebhooks.namespace, "live"), isNull(schema.productWebhooks.revokedAt)))
      .orderBy(schema.productWebhooks.name),
    db()
      .select({ id: schema.jobRuns.id, name: schema.jobRuns.name, trigger: schema.jobRuns.trigger, status: schema.jobRuns.status, tick: schema.jobRuns.tick, costUsd: schema.jobRuns.costUsd, error: schema.jobRuns.error, createdAt: schema.jobRuns.createdAt })
      .from(schema.jobRuns)
      .where(and(eq(schema.jobRuns.productId, productId), eq(schema.jobRuns.namespace, "live")))
      .orderBy(desc(schema.jobRuns.createdAt))
      .limit(10),
  ]);
  return { schedules, webhooks, runs };
}

/** Makes or replaces a live webhook. "full" when the product already has its 2 under other names. */
export async function saveWebhook(productId: string, name: string, secretHash: string, now: Date): Promise<"ok" | "full"> {
  const active = await db()
    .select({ name: schema.productWebhooks.name })
    .from(schema.productWebhooks)
    .where(and(eq(schema.productWebhooks.productId, productId), eq(schema.productWebhooks.namespace, "live"), isNull(schema.productWebhooks.revokedAt)));
  if (!active.some((a) => a.name === name) && active.length >= JOBS_LIMITS.webhooksPerProduct) return "full";
  await db().batch([
    db()
      .update(schema.productWebhooks)
      .set({ revokedAt: now })
      .where(and(eq(schema.productWebhooks.productId, productId), eq(schema.productWebhooks.namespace, "live"), eq(schema.productWebhooks.name, name), isNull(schema.productWebhooks.revokedAt))),
    db().insert(schema.productWebhooks).values({ productId, namespace: "live", name, secretHash }),
  ]);
  return "ok";
}

export async function revokeWebhook(productId: string, name: string, now: Date): Promise<boolean> {
  const rows = await db()
    .update(schema.productWebhooks)
    .set({ revokedAt: now })
    .where(and(eq(schema.productWebhooks.productId, productId), eq(schema.productWebhooks.namespace, "live"), eq(schema.productWebhooks.name, name), isNull(schema.productWebhooks.revokedAt)))
    .returning({ id: schema.productWebhooks.id });
  return rows.length > 0;
}
