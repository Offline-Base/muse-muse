import { and, eq, like, lt, or } from "drizzle-orm";
import { CONNECT_LIMITS } from "@/lib/caps/connect/limits";
import { db, schema } from "@/lib/db/client";

// Cleanup for the connect cap's rows (CAP_CLEANUPS in lib/caps/cleanup.ts, docs/CAPABILITIES.md 2.9). Kept apart from
// lib/caps/connect/store.ts, which imports lib/caps/proof.ts and through it every cap's proof, so the build pipeline's
// cleanup imports only the database. The namespace is b:<buildId> (lib/caps/proof.ts buildNamespace).

/** When a build ends: its test keys and simulated sends go. */
export async function clearConnectBuild(buildId: string): Promise<void> {
  const ns = `b:${buildId}`;
  await db().delete(schema.productSecrets).where(eq(schema.productSecrets.namespace, ns));
  await db().delete(schema.productSends).where(eq(schema.productSends.namespace, ns));
}

/** The hourly sweep: expired cache rows, keys revoked over a day ago, and crashed builds' test keys and sends. */
export async function sweepConnect(now: Date): Promise<number> {
  const old = new Date(now.getTime() - CONNECT_LIMITS.revokedKeepMs);
  const buildOld = new Date(now.getTime() - CONNECT_LIMITS.buildNamespaceMaxAgeMs);
  const cache = await db().delete(schema.publicFetchCache).where(lt(schema.publicFetchCache.expiresAt, now)).returning({ k: schema.publicFetchCache.key });
  const keys = await db()
    .delete(schema.productSecrets)
    .where(or(lt(schema.productSecrets.revokedAt, old), and(like(schema.productSecrets.namespace, "b:%"), lt(schema.productSecrets.createdAt, buildOld))))
    .returning({ id: schema.productSecrets.id });
  const sends = await db()
    .delete(schema.productSends)
    .where(and(like(schema.productSends.namespace, "b:%"), lt(schema.productSends.createdAt, buildOld)))
    .returning({ id: schema.productSends.id });
  return cache.length + keys.length + sends.length;
}
