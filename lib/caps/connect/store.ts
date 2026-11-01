import { and, asc, count, eq, gte, isNotNull, isNull, like, lt, or, sql } from "drizzle-orm";
import { connectBuildBlock } from "@/lib/caps/connect/brief";
import { CONNECT_LIMITS } from "@/lib/caps/connect/limits";
import { buildNamespace } from "@/lib/caps/proof";
import { db, schema } from "@/lib/db/client";
import type { SealedSecret } from "@/lib/secrets/box";

/**
 * The connect cap's database (docs/CAPABILITIES.md, section 11, migration 0022_connect): the fetch cache, the key vault
 * and the sends record, plus its part of the gateway's record (/caps/proof) and cleanup. Every read and write of a key
 * moves sealed bytes only; opening one happens in handler.ts, inside the call that uses it.
 */

export interface CachedAnswer {
  status: number;
  contentType: string | null;
  body: Buffer;
  fetchedAt: Date;
}

export interface KeyRow {
  name: string;
  service: string;
  createdAt: Date;
}

export interface SendRow {
  productId: string;
  namespace: string;
  channel: string;
  recipientHash: string;
  recipients: number;
  approvalNonce: string;
  status: "sent" | "simulated" | "failed";
  providerId: string | null;
}

export interface ConnectStore {
  cacheGet(key: string, now: Date): Promise<CachedAnswer | null>;
  cachePut(row: { key: string; api: string; status: number; contentType: string | null; body: Buffer; fetchedAt: Date; expiresAt: Date }): Promise<void>;
  listKeys(productId: string, namespace: string): Promise<KeyRow[]>;
  /** The active sealed key by name, for the one call that opens it. */
  sealedKey(productId: string, namespace: string, name: string): Promise<(SealedSecret & { service: string }) | null>;
  /**
   * Revokes the active key of that name and saves this one, in one batch. Refuses (false) when the product already keeps
   * `max` other active keys.
   */
  putKey(row: { productId: string; namespace: string; name: string; service: string; sealed: SealedSecret; createdBy: string | null; testHash: string | null }, max: number, now: Date): Promise<boolean>;
  /** True when there was an active key to revoke. */
  revokeKey(productId: string, namespace: string, name: string, now: Date): Promise<boolean>;
  recordSend(row: SendRow): Promise<void>;
}

export const connectStore: ConnectStore = {
  async cacheGet(key, now) {
    const [row] = await db()
      .select({ status: schema.publicFetchCache.status, contentType: schema.publicFetchCache.contentType, body: schema.publicFetchCache.body, fetchedAt: schema.publicFetchCache.fetchedAt })
      .from(schema.publicFetchCache)
      .where(and(eq(schema.publicFetchCache.key, key), gte(schema.publicFetchCache.expiresAt, now)))
      .limit(1);
    return row ?? null;
  },
  async cachePut(row) {
    await db()
      .insert(schema.publicFetchCache)
      .values(row)
      .onConflictDoUpdate({
        target: schema.publicFetchCache.key,
        set: { status: row.status, contentType: row.contentType, body: row.body, fetchedAt: row.fetchedAt, expiresAt: row.expiresAt },
      });
  },
  async listKeys(productId, namespace) {
    return db()
      .select({ name: schema.productSecrets.name, service: schema.productSecrets.service, createdAt: schema.productSecrets.createdAt })
      .from(schema.productSecrets)
      .where(and(eq(schema.productSecrets.productId, productId), eq(schema.productSecrets.namespace, namespace), isNull(schema.productSecrets.revokedAt)))
      .orderBy(asc(schema.productSecrets.name));
  },
  async sealedKey(productId, namespace, name) {
    const [row] = await db()
      .select({
        service: schema.productSecrets.service,
        ciphertext: schema.productSecrets.ciphertext,
        iv: schema.productSecrets.iv,
        tag: schema.productSecrets.tag,
        keyVersion: schema.productSecrets.keyVersion,
      })
      .from(schema.productSecrets)
      .where(and(eq(schema.productSecrets.productId, productId), eq(schema.productSecrets.namespace, namespace), eq(schema.productSecrets.name, name), isNull(schema.productSecrets.revokedAt)))
      .limit(1);
    return row ?? null;
  },
  async putKey(row, max, now) {
    const active = and(eq(schema.productSecrets.productId, row.productId), eq(schema.productSecrets.namespace, row.namespace), isNull(schema.productSecrets.revokedAt));
    const [others] = await db()
      .select({ n: count() })
      .from(schema.productSecrets)
      .where(and(active, sql`${schema.productSecrets.name} <> ${row.name}`));
    if (Number(others?.n ?? 0) >= max) return false;
    await db().batch([
      db().update(schema.productSecrets).set({ revokedAt: now }).where(and(active, eq(schema.productSecrets.name, row.name))),
      db().insert(schema.productSecrets).values({
        productId: row.productId,
        namespace: row.namespace,
        name: row.name,
        service: row.service,
        ciphertext: row.sealed.ciphertext,
        iv: row.sealed.iv,
        tag: row.sealed.tag,
        keyVersion: row.sealed.keyVersion,
        createdBy: row.createdBy,
        testHash: row.testHash,
        createdAt: now,
      }),
    ]);
    return true;
  },
  async revokeKey(productId, namespace, name, now) {
    const rows = await db()
      .update(schema.productSecrets)
      .set({ revokedAt: now })
      .where(and(eq(schema.productSecrets.productId, productId), eq(schema.productSecrets.namespace, namespace), eq(schema.productSecrets.name, name), isNull(schema.productSecrets.revokedAt)))
      .returning({ id: schema.productSecrets.id });
    return rows.length > 0;
  },
  async recordSend(row) {
    await db().insert(schema.productSends).values(row);
  },
};

// ---------------------------------------------------------------------------------------------------------------
// The gateway's record and cleanup

/**
 * CAP_PROOF.connect: what the gateway saw in a build's namespace since `since` (fetches answered with samples, brokered
 * calls, simulated sends, test keys saved), the brief's picks as `brief:api:<id>`, `brief:key:<service>` and
 * `brief:send:<channel>` (from connectBuildBlock, so keys and sends switched off since the brief was written aren't
 * required), and `secret-sha:<hash>` for every test key of the build, whenever saved, which verify's leak
 * scan looks for in the build's pages and files. A test key is made up by the test, never a real one.
 */
export async function connectProof(buildId: string, window: { since: Date | null }): Promise<Record<string, number>> {
  const ns = buildNamespace(buildId);
  const since = window.since;
  const usageCount = async (source: "fetch" | "vault") => {
    const [row] = await db()
      .select({ n: count() })
      .from(schema.usage)
      .where(and(eq(schema.usage.buildId, buildId), eq(schema.usage.source, source), since ? gte(schema.usage.at, since) : undefined));
    return Number(row?.n ?? 0);
  };
  const [sends] = await db()
    .select({ n: count() })
    .from(schema.productSends)
    .where(and(eq(schema.productSends.namespace, ns), eq(schema.productSends.status, "simulated"), since ? gte(schema.productSends.createdAt, since) : undefined));
  const keys = await db()
    .select({ testHash: schema.productSecrets.testHash, createdAt: schema.productSecrets.createdAt })
    .from(schema.productSecrets)
    .where(and(eq(schema.productSecrets.namespace, ns), isNotNull(schema.productSecrets.testHash)));
  const [build] = await db().select({ brief: schema.builds.brief }).from(schema.builds).where(eq(schema.builds.id, buildId)).limit(1);
  // What the build was told to use, with the flags as they are now: the same picks its prompt and the gateway rules have.
  const block = connectBuildBlock((build?.brief ?? null) as object | null);
  const out: Record<string, number> = {
    fetches: await usageCount("fetch"),
    calls: await usageCount("vault"),
    sends: Number(sends?.n ?? 0),
    keys: keys.filter((k) => !since || k.createdAt >= since).length,
  };
  for (const k of keys) if (k.testHash) out[`secret-sha:${k.testHash}`] = 1;
  for (const id of block?.publicApis ?? []) out[`brief:api:${id}`] = 1;
  for (const k of block?.keys ?? []) out[`brief:key:${k.service}`] = 1;
  for (const s of block?.sends ?? []) out[`brief:send:${s.channel}`] = 1;
  return out;
}

/** When a build ends: its test keys and simulated sends go. */
export async function clearConnectBuild(buildId: string): Promise<void> {
  const ns = buildNamespace(buildId);
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
