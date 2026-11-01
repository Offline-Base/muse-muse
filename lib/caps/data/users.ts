import { and, eq, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { collectionRules } from "@/lib/caps/data/types";

/** End users and their passkeys on the platform (docs/CAPABILITIES.md, section 9). */

export interface StoredPasskey {
  id: string;
  endUserId: string;
  publicKey: Buffer;
  counter: number;
  displayName: string | null;
}

/** A new person and their first passkey, together. */
export async function createEndUser(input: { endUserId: string; name: string; credentialId: string; publicKey: Buffer; counter: number; transports: string[] }): Promise<void> {
  await db().batch([
    db().insert(schema.endUsers).values({ id: input.endUserId, displayName: input.name }),
    db().insert(schema.endUserPasskeys).values({
      endUserId: input.endUserId,
      credentialId: input.credentialId,
      publicKey: input.publicKey,
      counter: input.counter,
      transports: input.transports,
    }),
  ]);
}

export async function findPasskey(credentialId: string): Promise<StoredPasskey | null> {
  const [row] = await db()
    .select({
      id: schema.endUserPasskeys.id,
      endUserId: schema.endUserPasskeys.endUserId,
      publicKey: schema.endUserPasskeys.publicKey,
      counter: schema.endUserPasskeys.counter,
      displayName: schema.endUsers.displayName,
    })
    .from(schema.endUserPasskeys)
    .innerJoin(schema.endUsers, eq(schema.endUsers.id, schema.endUserPasskeys.endUserId))
    .where(eq(schema.endUserPasskeys.credentialId, credentialId))
    .limit(1);
  return row ? { ...row, counter: Number(row.counter) } : null;
}

/**
 * Records a sign-in: the new counter, only while the stored one is still what was checked, so two sign-ins with the same
 * copy can't both pass. False when it changed in between.
 */
export async function usePasskey(passkeyId: string, endUserId: string, from: number, to: number): Promise<boolean> {
  const [updated] = await db().batch([
    db()
      .update(schema.endUserPasskeys)
      .set({ counter: to, lastUsedAt: new Date() })
      .where(and(eq(schema.endUserPasskeys.id, passkeyId), eq(schema.endUserPasskeys.counter, from)))
      .returning({ id: schema.endUserPasskeys.id }),
    db().update(schema.endUsers).set({ lastSeenAt: sql`now()` }).where(eq(schema.endUsers.id, endUserId)),
  ]);
  return (updated as unknown[]).length > 0;
}

/** A product people may sign in to: live with a link, not off or taken down, and saving data with a collection list. */
export async function productForSignIn(slug: string): Promise<{ id: string; name: string; liveUrl: string } | null> {
  const [row] = await db()
    .select({ id: schema.products.id, name: schema.products.name, liveUrl: schema.products.liveUrl, status: schema.products.status, manifest: schema.products.manifest })
    .from(schema.products)
    .where(and(eq(schema.products.slug, slug), isNull(schema.products.takenDownAt)))
    .limit(1);
  if (!row?.liveUrl || (row.status !== "live" && row.status !== "partial")) return null;
  if (!collectionRules((row.manifest as { data?: unknown } | null)?.data)?.length) return null;
  return { id: row.id, name: row.name, liveUrl: row.liveUrl };
}
