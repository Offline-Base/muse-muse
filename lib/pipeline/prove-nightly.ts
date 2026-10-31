import { and, eq, inArray, isNotNull, max, notInArray } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { TERMINAL_STATUSES } from "@/lib/types";

export interface NightlyCandidate {
  buildId: string;
  productId: string;
}

/** The products to re-check, the ones checked longest ago first, and any never checked before those. Pure. */
export function pickNightly(candidates: readonly NightlyCandidate[], lastChecked: ReadonlyMap<string, number>, count: number): NightlyCandidate[] {
  return [...candidates].sort((a, b) => (lastChecked.get(a.buildId) ?? 0) - (lastChecked.get(b.buildId) ?? 0)).slice(0, count);
}

/** Live products with a live link, a sandbox, and no build running in it. */
export async function nightlyCandidates(count: number): Promise<NightlyCandidate[]> {
  const live = await db()
    .select({ buildId: schema.products.latestBuildId, productId: schema.products.id })
    .from(schema.products)
    .where(and(inArray(schema.products.status, ["live", "partial"]), isNotNull(schema.products.liveUrl), isNotNull(schema.products.sandboxName), isNotNull(schema.products.latestBuildId)));
  const rows = live.filter((r): r is NightlyCandidate => Boolean(r.buildId));
  if (!rows.length) return [];
  const running = await db()
    .select({ productId: schema.builds.productId })
    .from(schema.builds)
    .where(and(notInArray(schema.builds.status, [...TERMINAL_STATUSES]), inArray(schema.builds.productId, rows.map((r) => r.productId))));
  const busy = new Set(running.map((r) => r.productId));
  const buildIds = rows.map((r) => r.buildId);
  const checked = await db()
    .select({ buildId: schema.buildEvents.buildId, at: max(schema.buildEvents.at) })
    .from(schema.buildEvents)
    .where(and(eq(schema.buildEvents.type, "prove"), inArray(schema.buildEvents.buildId, buildIds)))
    .groupBy(schema.buildEvents.buildId);
  const lastChecked = new Map(checked.map((c) => [c.buildId, c.at ? new Date(c.at).getTime() : 0]));
  return pickNightly(rows.filter((r) => !busy.has(r.productId)), lastChecked, count);
}
