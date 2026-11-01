/** The board loop's rows. No address or token is ever written here (docs/BOARD_LOOP.md). */
import { and, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { hourStart } from "@/lib/docs/proxy/limits";
import { adjustCounter, reserveCounter } from "@/lib/gateway/store";
import type { BoardKind } from "@/lib/board-loop/driver";
import { newData, newStages, type LoopData, type LoopRow } from "@/lib/board-loop/logic";
import { TRY_LIMITS, type Turn, type TryStore } from "@/lib/board-loop/try";

const loops = schema.boardLoops;
const turns = schema.boardTryTurns;
/** A finished turn's answer is kept this long, then its row goes. */
const KEEP_TURN_MS = 24 * 3_600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUniqueClash(err: unknown): boolean {
  const code = (e: unknown) => (e as { code?: string } | null)?.code;
  return code(err) === "23505" || code((err as { cause?: unknown } | null)?.cause) === "23505";
}

function toRow(row: typeof loops.$inferSelect): LoopRow {
  return { ...row };
}

export async function getLoop(id: string): Promise<LoopRow | null> {
  if (!UUID.test(id)) return null;
  const [row] = await db().select().from(loops).where(eq(loops.id, id)).limit(1);
  return row ? toRow(row) : null;
}

/** Null when this kind of board already has a loop going. */
export async function insertLoop(input: { adapterJobId: string; target: BoardKind; title: string; quantJobId: string | null; createdBy: string | null }): Promise<LoopRow | null> {
  try {
    const [row] = await db()
      .insert(loops)
      .values({ adapterJobId: input.adapterJobId, target: input.target, stages: newStages(), data: newData(input.title, input.quantJobId), createdBy: input.createdBy })
      .returning();
    return toRow(row);
  } catch (err) {
    if (isUniqueClash(err)) return null;
    throw err;
  }
}

/** Writes what a tick changed. Stop is left alone, so a Stop pressed during a tick still counts on the next. */
export async function saveLoop(row: LoopRow): Promise<void> {
  await db()
    .update(loops)
    .set({ status: row.status, stages: row.stages, data: row.data as LoopData, tryOpen: row.tryOpen, updatedAt: new Date() })
    .where(eq(loops.id, row.id));
}

export async function setLoopRun(id: string, runId: string): Promise<void> {
  await db().update(loops).set({ workflowRunId: runId }).where(eq(loops.id, id));
}

export async function requestStop(id: string): Promise<void> {
  await db().update(loops).set({ stopRequested: true, tryOpen: false }).where(eq(loops.id, id));
}

/** The newest loop of a tune, for its page. */
export async function latestLoopOf(adapterJobId: string): Promise<LoopRow | null> {
  const [row] = await db().select().from(loops).where(eq(loops.adapterJobId, adapterJobId)).orderBy(desc(loops.createdAt)).limit(1);
  return row ? toRow(row) : null;
}

export const tryStore: TryStore = {
  loop: getLoop,
  async openTurn(loopId, visitor) {
    const [row] = await db()
      .select()
      .from(turns)
      .where(and(eq(turns.loopId, loopId), eq(turns.visitor, visitor), inArray(turns.status, ["queued", "running"])))
      .limit(1);
    return (row as Turn | undefined) ?? null;
  },
  async addTurn(loopId, visitor, prompt) {
    try {
      const [row] = await db().insert(turns).values({ loopId, visitor, prompt }).returning();
      return row as Turn;
    } catch (err) {
      if (isUniqueClash(err)) return null;
      throw err;
    }
  },
  async turn(id) {
    if (!UUID.test(id)) return null;
    const [row] = await db().select().from(turns).where(eq(turns.id, id)).limit(1);
    return (row as Turn | undefined) ?? null;
  },
  async queueLength(loopId) {
    const [row] = await db().select({ n: sql<number>`count(*)::int` }).from(turns).where(and(eq(turns.loopId, loopId), eq(turns.status, "queued")));
    return Number(row?.n ?? 0);
  },
  async position(turn) {
    const [row] = await db()
      .select({ n: sql<number>`count(*)::int` })
      .from(turns)
      .where(and(eq(turns.loopId, turn.loopId), eq(turns.status, "queued"), lt(turns.createdAt, turn.createdAt)));
    return Number(row?.n ?? 0) + 1;
  },
  async seen(id, at) {
    await db().update(turns).set({ lastSeenAt: at }).where(eq(turns.id, id));
  },
  async sweep(loopId, now) {
    const d = db();
    await d
      .update(turns)
      .set({ status: "expired", prompt: null, finishedAt: now })
      .where(and(eq(turns.loopId, loopId), eq(turns.status, "queued"), lt(turns.lastSeenAt, new Date(now.getTime() - TRY_LIMITS.goneMs))));
    await d
      .update(turns)
      .set({ status: "failed", prompt: null, finishedAt: now, error: "The board didn't finish this one. Try again." })
      .where(and(eq(turns.loopId, loopId), eq(turns.status, "running"), isNotNull(turns.startedAt), lt(turns.startedAt, new Date(now.getTime() - TRY_LIMITS.runningMs))));
    await d.delete(turns).where(and(eq(turns.loopId, loopId), isNotNull(turns.finishedAt), lt(turns.finishedAt, new Date(now.getTime() - KEEP_TURN_MS))));
  },
  async claim(id, at) {
    try {
      const rows = await db().update(turns).set({ status: "running", startedAt: at }).where(and(eq(turns.id, id), eq(turns.status, "queued"))).returning({ id: turns.id });
      return rows.length === 1;
    } catch (err) {
      if (isUniqueClash(err)) return false;
      throw err;
    }
  },
  async finishTurn(id, patch, at) {
    // The prompt is only needed to run the turn.
    await db().update(turns).set({ ...patch, prompt: null, finishedAt: at }).where(eq(turns.id, id));
  },
  async take(key, limit, now) {
    return (await reserveCounter(key, hourStart(now), 1, limit)) !== null;
  },
  async giveBack(key, now) {
    await adjustCounter(key, hourStart(now), -1);
  },
};

