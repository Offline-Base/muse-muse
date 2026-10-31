import { and, desc, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import type { ToolFixtures, ToolPrincipal } from "@/lib/tools/ids";

/** The tool gateway's database calls, kept apart so its logic stays testable. */

function startOfUtcDay(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** What tools cost today across every product, reservations included. Compared with TOOLS_DAILY_SPEND_CAP_USD. */
export async function toolsSpendToday(): Promise<number> {
  const [row] = await db()
    .select({ total: sql<number>`coalesce(sum(${schema.usage.costUsd}), 0)` })
    .from(schema.usage)
    .where(and(eq(schema.usage.source, "tools"), gte(schema.usage.at, startOfUtcDay())));
  return Number(row?.total ?? 0);
}

export async function productInfo(productId: string): Promise<{ manifest: unknown; liveUrl: string | null } | null> {
  const [row] = await db()
    .select({ manifest: schema.products.manifest, liveUrl: schema.products.liveUrl })
    .from(schema.products)
    .where(eq(schema.products.id, productId))
    .limit(1);
  return row ?? null;
}

/** The canned outputs of this product's newest build that has any. Unit B's fixtures step writes them. */
export async function buildFixtures(productId: string): Promise<ToolFixtures | null> {
  const [row] = await db()
    .select({ fixtures: schema.builds.toolFixtures })
    .from(schema.builds)
    .where(and(eq(schema.builds.productId, productId), isNotNull(schema.builds.toolFixtures)))
    .orderBy(desc(schema.builds.startedAt))
    .limit(1);
  return row?.fixtures ?? null;
}

export async function findToolSession(productId: string, composioUserId: string) {
  const [row] = await db()
    .select({ sessionId: schema.toolSessions.sessionId, configHash: schema.toolSessions.configHash })
    .from(schema.toolSessions)
    .where(and(eq(schema.toolSessions.productId, productId), eq(schema.toolSessions.composioUserId, composioUserId)))
    .limit(1);
  return row ?? null;
}

export async function saveToolSession(row: { productId: string; composioUserId: string; sessionId: string; configHash: string }): Promise<void> {
  await db()
    .insert(schema.toolSessions)
    .values(row)
    .onConflictDoUpdate({
      target: [schema.toolSessions.productId, schema.toolSessions.composioUserId],
      set: { sessionId: row.sessionId, configHash: row.configHash, updatedAt: new Date() },
    });
}

/** Active rows: the toolkit and Composio's id for the account. Never a credential, which only Composio holds. */
export async function activeConnections(productId: string, composioUserId: string): Promise<Array<{ toolkit: string; connectedAccountId: string }>> {
  return db()
    .select({ toolkit: schema.toolConnections.toolkit, connectedAccountId: schema.toolConnections.connectedAccountId })
    .from(schema.toolConnections)
    .where(
      and(
        eq(schema.toolConnections.productId, productId),
        eq(schema.toolConnections.composioUserId, composioUserId),
        isNull(schema.toolConnections.revokedAt),
      ),
    );
}

export async function revokeConnection(productId: string, composioUserId: string, toolkit: string): Promise<void> {
  await db()
    .update(schema.toolConnections)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.toolConnections.productId, productId),
        eq(schema.toolConnections.composioUserId, composioUserId),
        eq(schema.toolConnections.toolkit, toolkit),
        isNull(schema.toolConnections.revokedAt),
      ),
    );
}

export async function saveConnection(row: {
  productId: string;
  principal: ToolPrincipal;
  composioUserId: string;
  toolkit: string;
  connectedAccountId: string;
}): Promise<void> {
  await revokeConnection(row.productId, row.composioUserId, row.toolkit);
  await db().insert(schema.toolConnections).values(row);
}

/** Active connections of products that were turned off or failed, for the hourly cleanup. */
export async function connectionsOfOffProducts(): Promise<Array<{ id: string; connectedAccountId: string }>> {
  return db()
    .select({ id: schema.toolConnections.id, connectedAccountId: schema.toolConnections.connectedAccountId })
    .from(schema.toolConnections)
    .innerJoin(schema.products, eq(schema.products.id, schema.toolConnections.productId))
    .where(and(isNull(schema.toolConnections.revokedAt), inArray(schema.products.status, ["disabled", "failed"])));
}

export async function markConnectionRevoked(id: string): Promise<void> {
  await db().update(schema.toolConnections).set({ revokedAt: new Date() }).where(eq(schema.toolConnections.id, id));
}
