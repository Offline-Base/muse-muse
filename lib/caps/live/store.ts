import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { liveBlock } from "@/lib/caps/live/brief";
import { liveProofKey } from "@/lib/caps/live/captions";
import type { DataScope } from "@/lib/caps/data/types";
import { readCapDrops, withoutCaps } from "@/lib/caps/ready";

/**
 * The live cap's database reads (docs/CAPABILITIES.md, section 13). It stores nothing of its own: updates read
 * product_rows.seq and deleted_at from 0020_data, and counts are rate_limits rows.
 *
 * Why reading by seq can't skip a change: every write, delete included, holds its namespace's product_data_counts row
 * locked (lockCounts in lib/caps/data/store.ts) while it takes the next seq and commits. So within one namespace rows
 * commit in seq order, and a row with a lower seq can't appear after one with a higher seq was read.
 */

export interface LiveRowsKey {
  productId: string;
  namespace: string;
  collection: string;
  scope: DataScope;
  ownerKey: string | null;
}

export interface LiveChange {
  seq: number;
  op: "put" | "delete";
  id: string;
  /** Null for a delete. */
  data: unknown;
}

const rowsOf = <T>(result: unknown): T[] => {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
};

/**
 * Changes after `after`, oldest first. From 0 a browser has nothing to take away, so a first read leaves out rows
 * already deleted.
 */
export async function liveChanges(k: LiveRowsKey, after: number, limit: number): Promise<LiveChange[]> {
  const live = after === 0 ? sql`and deleted_at is null` : sql``;
  const rows = rowsOf<{ seq: string | number; doc_id: string; data: unknown; deleted: boolean }>(
    await db().execute(sql`select seq, doc_id, data, deleted_at is not null as deleted from product_rows
      where product_id = ${k.productId}::uuid and namespace = ${k.namespace} and seq > ${after}::bigint
        and collection = ${k.collection} and scope = ${k.scope} and owner_key is not distinct from ${k.ownerKey}::text ${live}
      order by seq asc limit ${limit}::int`),
  );
  return rows.map((r) => (r.deleted ? { seq: Number(r.seq), op: "delete", id: r.doc_id, data: null } : { seq: Number(r.seq), op: "put", id: r.doc_id, data: r.data }));
}

/** The origin of a build's preview, for a build ticket's stream. */
export async function buildPreviewOrigin(buildId: string): Promise<string | null> {
  const [row] = await db().select({ previewUrl: schema.builds.previewUrl }).from(schema.builds).where(eq(schema.builds.id, buildId)).limit(1);
  try {
    return row?.previewUrl ? new URL(row.previewUrl).origin : null;
  } catch {
    return null;
  }
}

/**
 * What the gateway saw for a build (CAP_PROOF.live, docs/CAPABILITIES.md, 2.8): caption chunks accepted, tickets made,
 * streams opened and changes sent, all since `since`, and what its brief asks for, as this build has it.
 */
export async function liveProof(buildId: string, window: { since: Date | null }): Promise<Record<string, number>> {
  const [build] = await db().select({ brief: schema.builds.brief, capsDropped: schema.builds.capsDropped }).from(schema.builds).where(eq(schema.builds.id, buildId)).limit(1);
  const dropped = (readCapDrops(build?.capsDropped) ?? []).map((d) => d.cap);
  const block = build?.brief ? liveBlock(withoutCaps(build.brief as object, dropped)) : null;
  const count = async (what: "chunks" | "tickets" | "streams" | "events") => {
    const since = window.since ? sql`and window_start >= ${window.since.toISOString()}::timestamptz` : sql``;
    const [row] = rowsOf<{ n: number | string }>(await db().execute(sql`select coalesce(sum(count), 0)::int as n from rate_limits where key = ${liveProofKey(what, buildId)} ${since}`));
    return Number(row?.n ?? 0);
  };
  return {
    chunks: await count("chunks"),
    tickets: await count("tickets"),
    streams: await count("streams"),
    events: await count("events"),
    ...(block?.captions ? { "brief:captions": 1 } : {}),
    ...(block?.updates ? { "brief:updates": 1 } : {}),
  };
}
