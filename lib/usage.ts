import { and, gte, sql, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import type { ModelUsage } from "@/lib/types";

export interface UsageContext {
  /** "docs" is the live docs demos (lib/docs/proxy), which run on the platform's key with no product. */
  source: "gateway" | "muse_code" | "platform" | "docs";
  endpoint: string;
  productId?: string | null;
  buildId?: string | null;
  tokenId?: string | null;
}

/** Records Meta usage. One row per model per call. */
export async function recordUsage(ctx: UsageContext, items: ModelUsage[]): Promise<void> {
  const rows = items
    .filter((u) => u.inputTokens || u.outputTokens || u.images || u.videoFrames || u.audioSeconds || u.costUsd)
    .map((u) => ({
      source: ctx.source,
      endpoint: ctx.endpoint,
      productId: ctx.productId ?? null,
      buildId: ctx.buildId ?? null,
      tokenId: ctx.tokenId ?? null,
      model: u.model,
      inputTokens: Math.round(u.inputTokens),
      cachedInputTokens: Math.round(u.cachedInputTokens),
      outputTokens: Math.round(u.outputTokens),
      images: u.images ?? 0,
      videoFrames: u.videoFrames ?? 0,
      audioSeconds: u.audioSeconds ?? 0,
      costUsd: u.costUsd,
    }));
  if (rows.length) await db().insert(schema.usage).values(rows);
}

function startOfUtcDay(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Spend today (UTC) for one gateway token. */
export async function tokenSpendToday(tokenId: string): Promise<number> {
  const [row] = await db()
    .select({ total: sql<number>`coalesce(sum(${schema.usage.costUsd}), 0)` })
    .from(schema.usage)
    .where(and(eq(schema.usage.tokenId, tokenId), gte(schema.usage.at, startOfUtcDay())));
  return Number(row?.total ?? 0);
}

/** Spend today (UTC) on the live docs demos, reservations included. Compared with DOCS_DAILY_SPEND_CAP_USD. */
export async function docsSpendToday(): Promise<number> {
  const [row] = await db()
    .select({ total: sql<number>`coalesce(sum(${schema.usage.costUsd}), 0)` })
    .from(schema.usage)
    .where(and(eq(schema.usage.source, "docs"), gte(schema.usage.at, startOfUtcDay())));
  return Number(row?.total ?? 0);
}

/** Spend today (UTC) across the whole platform. Compared with DAILY_SPEND_CAP_USD before any new spend. */
export async function platformSpendToday(): Promise<number> {
  const [row] = await db()
    .select({ total: sql<number>`coalesce(sum(${schema.usage.costUsd}), 0)` })
    .from(schema.usage)
    .where(gte(schema.usage.at, startOfUtcDay()));
  return Number(row?.total ?? 0);
}
