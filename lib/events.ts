import { and, asc, eq, gt, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { redactShared, redactSharedValue } from "@/lib/keys/shared";
import { proveRunning } from "@/lib/outputs/labels";
import type { BuildEvent, BuildEventBody, BuildStatus } from "@/lib/types";

/**
 * Appends one event to a build's log. The build room picks it up through the SSE route. Every string in it has the
 * owner's shared keys taken out first (docs/BUILD_KEYS.md), which changes nothing while none is set.
 */
export async function emit(buildId: string, body: BuildEventBody): Promise<void> {
  const payload = redactSharedValue(body);
  await db().insert(schema.buildEvents).values({ buildId, type: payload.type, payload });
}

/** The string columns of a status update with any shared key taken out. Other values, such as dates, are left alone. */
function redactedSet<T extends Record<string, unknown>>(set: T | undefined): T | undefined {
  if (!set) return set;
  return Object.fromEntries(Object.entries(set).map(([k, v]) => [k, typeof v === "string" ? redactShared(v) : v])) as T;
}

/**
 * Moves a build to a new status (and optionally a new step), records it in the log, and stamps finishedAt for
 * terminal statuses. Extra columns can be set in the same update.
 */
export async function setBuildStatus(
  buildId: string,
  status: BuildStatus,
  opts: {
    step?: string | null;
    message?: string;
    set?: Partial<typeof schema.builds.$inferInsert>;
  } = {},
): Promise<void> {
  const terminal = status === "live" || status === "partial" || status === "failed" || status === "refused";
  const message = opts.message === undefined ? undefined : redactShared(opts.message);
  await db()
    .update(schema.builds)
    .set({
      ...redactedSet(opts.set),
      status,
      ...(opts.step !== undefined ? { step: opts.step } : {}),
      ...(terminal ? { finishedAt: new Date() } : {}),
    })
    .where(eq(schema.builds.id, buildId));
  await emit(buildId, {
    type: "status",
    status,
    ...(opts.step ? { step: opts.step } : {}),
    ...(message ? { message } : {}),
  });
}

/** Events after the given id, oldest first. */
export async function eventsAfter(buildId: string, afterId: number, limit = 200): Promise<BuildEvent[]> {
  const rows = await db()
    .select()
    .from(schema.buildEvents)
    .where(and(eq(schema.buildEvents.buildId, buildId), gt(schema.buildEvents.id, afterId)))
    .orderBy(asc(schema.buildEvents.id))
    .limit(limit);
  // Also on the way out, for events stored by another path (an imported product's) or before a key was added.
  return rows.map((r) => ({ ...redactSharedValue(r.payload), id: r.id, at: r.at.toISOString() }));
}

/** Adds to a build's running cost and tells the build room. */
export async function addBuildCost(buildId: string, addedUsd: number, what: string): Promise<void> {
  if (!(addedUsd > 0)) return;
  const [row] = await db()
    .update(schema.builds)
    .set({ costUsd: sql`${schema.builds.costUsd} + ${addedUsd}` })
    .where(eq(schema.builds.id, buildId))
    .returning({ costUsd: schema.builds.costUsd });
  await emit(buildId, { type: "cost", totalUsd: row?.costUsd ?? addedUsd, addedUsd, what });
}

/** True while a Prove it run on this build can still write events, so the room's stream stays open past the build's end. */
export async function proveStillRunning(buildId: string): Promise<boolean> {
  const rows = await db()
    .select({ payload: schema.buildEvents.payload, at: schema.buildEvents.at })
    .from(schema.buildEvents)
    .where(and(eq(schema.buildEvents.buildId, buildId), eq(schema.buildEvents.type, "prove")))
    .orderBy(asc(schema.buildEvents.id));
  return proveRunning(rows.map((r) => ({ ...r.payload, at: r.at.toISOString() })), Date.now());
}
