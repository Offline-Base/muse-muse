import { and, asc, desc, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import type { DocsObjectKind } from "@/lib/docs/proxy/endpoints";
import type { DocsHoldState } from "@/lib/docs/proxy/types";

export { adjustCounter, counterValue, reserveCounter } from "@/lib/gateway/store";

/**
 * The docs proxy's database calls: the docs_objects table of what each visitor created. The per-minute, in-flight and
 * multi-unit counters (the IP's micro-dollars) are the gateway's (lib/gateway/store.ts).
 */

/** Notes that a visitor created a file or a stored response. Recording the same id twice keeps the first. */
export async function recordDocsObject(object: {
  id: string;
  kind: DocsObjectKind;
  visitor: string;
  hold?: DocsHoldState | null;
}): Promise<void> {
  await db()
    .insert(schema.docsObjects)
    .values({ ...object, hold: object.hold ?? null })
    .onConflictDoNothing();
}

/** A background response's held spend, or null. */
export async function pendingDocsHold(id: string): Promise<DocsHoldState | null> {
  const [row] = await db()
    .select({ hold: schema.docsObjects.hold })
    .from(schema.docsObjects)
    .where(eq(schema.docsObjects.id, id))
    .limit(1);
  return row?.hold ?? null;
}

/**
 * Takes a background response's held spend off its row and returns it, once: the clearing update only matches while
 * the hold is still there, so a reader's poll and the hourly sweep can't both settle the same response. A hold is
 * written only when the row is created and only ever cleared, so the value read first is the one this call cleared.
 */
export async function claimDocsHold(id: string): Promise<DocsHoldState | null> {
  const hold = await pendingDocsHold(id);
  if (!hold) return null;
  const rows = await db()
    .update(schema.docsObjects)
    .set({ hold: null })
    .where(and(eq(schema.docsObjects.id, id), isNotNull(schema.docsObjects.hold)))
    .returning({ id: schema.docsObjects.id });
  return rows.length ? hold : null;
}

/** Which of `ids` this visitor created, with their kinds. */
export async function ownedDocsIds(
  visitor: string,
  ids: string[],
): Promise<Array<{ id: string; kind: DocsObjectKind }>> {
  if (!ids.length) return [];
  return db()
    .select({ id: schema.docsObjects.id, kind: schema.docsObjects.kind })
    .from(schema.docsObjects)
    .where(and(eq(schema.docsObjects.visitor, visitor), inArray(schema.docsObjects.id, ids)));
}

/** A visitor's objects of one kind, newest first. */
export async function visitorDocsObjects(visitor: string, kind: DocsObjectKind, limit: number): Promise<string[]> {
  const rows = await db()
    .select({ id: schema.docsObjects.id })
    .from(schema.docsObjects)
    .where(and(eq(schema.docsObjects.visitor, visitor), eq(schema.docsObjects.kind, kind)))
    .orderBy(desc(schema.docsObjects.createdAt))
    .limit(limit);
  return rows.map((r) => r.id);
}

export async function forgetDocsObject(id: string): Promise<void> {
  await db().delete(schema.docsObjects).where(eq(schema.docsObjects.id, id));
}

/** Objects of a kind created before `before`, oldest first: what the hourly cleanup deletes. */
export async function staleDocsObjects(kind: DocsObjectKind, before: Date, limit: number): Promise<string[]> {
  const rows = await db()
    .select({ id: schema.docsObjects.id })
    .from(schema.docsObjects)
    .where(and(eq(schema.docsObjects.kind, kind), lt(schema.docsObjects.createdAt, before)))
    .orderBy(asc(schema.docsObjects.createdAt))
    .limit(limit);
  return rows.map((r) => r.id);
}

/** Background responses still holding their spend, created before `before`, oldest first: what the sweep settles. */
export async function pendingDocsHolds(before: Date, limit: number): Promise<Array<{ id: string; hold: DocsHoldState }>> {
  const rows = await db()
    .select({ id: schema.docsObjects.id, hold: schema.docsObjects.hold })
    .from(schema.docsObjects)
    .where(and(isNotNull(schema.docsObjects.hold), lt(schema.docsObjects.createdAt, before)))
    .orderBy(asc(schema.docsObjects.createdAt))
    .limit(limit);
  return rows.flatMap((r) => (r.hold ? [{ id: r.id, hold: r.hold }] : []));
}

export async function forgetDocsObjects(ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const rows = await db()
    .delete(schema.docsObjects)
    .where(inArray(schema.docsObjects.id, ids))
    .returning({ id: schema.docsObjects.id });
  return rows.length;
}
