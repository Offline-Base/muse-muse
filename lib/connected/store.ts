/**
 * Accounts people connect from outside, one active row per provider and owner (docs/GITHUB_EXPORT.md). Generic on purpose:
 * GitHub is the first provider and Hugging Face can be the next. A token is only ever sealed here, bound to its provider,
 * owner and outside account, and it leaves only as a return value of openConnection. No route may send it to a browser.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { openSecret, parseKeyring, sealSecret, type BoxKeyring } from "@/lib/secrets/box";
import type { ConnectionOwner } from "@/lib/connected/owner";

export type Provider = "github";

export interface Connection {
  provider: Provider;
  externalId: string;
  externalLogin: string;
  scopes: string;
  connectedAt: Date;
}

const aadFor = (provider: Provider, owner: ConnectionOwner, externalId: string) => `connected:${provider}:${owner.kind}:${owner.key}:${externalId}`;

function ring(): BoxKeyring {
  const keys = parseKeyring(env.connectedAccountsKey);
  if (!keys) throw new Error("CONNECTED_ACCOUNTS_KEY isn't set");
  return keys;
}

const ownedBy = (provider: Provider, owner: ConnectionOwner) => and(eq(schema.connectedAccounts.provider, provider), eq(schema.connectedAccounts.ownerKind, owner.kind), eq(schema.connectedAccounts.ownerKey, owner.key), isNull(schema.connectedAccounts.revokedAt));

/** Connects this account, replacing any this owner already has for the provider. */
export async function saveConnection(input: { provider: Provider; owner: ConnectionOwner; externalId: string; externalLogin: string; scopes: string; token: string }): Promise<void> {
  const sealed = sealSecret(input.token, ring(), aadFor(input.provider, input.owner, input.externalId));
  const values = { externalId: input.externalId, externalLogin: input.externalLogin, scopes: input.scopes, ciphertext: sealed.ciphertext, iv: sealed.iv, tag: sealed.tag, keyVersion: sealed.keyVersion };
  await db()
    .insert(schema.connectedAccounts)
    .values({ provider: input.provider, ownerKind: input.owner.kind, ownerKey: input.owner.key, ...values })
    .onConflictDoUpdate({
      target: [schema.connectedAccounts.provider, schema.connectedAccounts.ownerKind, schema.connectedAccounts.ownerKey],
      targetWhere: sql`${schema.connectedAccounts.revokedAt} is null`,
      set: { ...values, updatedAt: new Date() },
    });
}

/** What may be shown about this owner's connection. Never the token. */
export async function findConnection(provider: Provider, owner: ConnectionOwner): Promise<Connection | null> {
  const [row] = await db()
    .select({ externalId: schema.connectedAccounts.externalId, externalLogin: schema.connectedAccounts.externalLogin, scopes: schema.connectedAccounts.scopes, connectedAt: schema.connectedAccounts.updatedAt })
    .from(schema.connectedAccounts)
    .where(ownedBy(provider, owner))
    .limit(1);
  return row ? { provider, ...row } : null;
}

/** This owner's token, for a server-side call to the provider. Null when they have none or it no longer opens. */
export async function openConnection(provider: Provider, owner: ConnectionOwner): Promise<(Connection & { token: string }) | null> {
  const [row] = await db().select().from(schema.connectedAccounts).where(ownedBy(provider, owner)).limit(1);
  if (!row) return null;
  try {
    const token = openSecret({ ciphertext: row.ciphertext, iv: row.iv, tag: row.tag, keyVersion: row.keyVersion }, ring(), aadFor(provider, owner, row.externalId));
    return { provider, externalId: row.externalId, externalLogin: row.externalLogin, scopes: row.scopes, connectedAt: row.updatedAt, token };
  } catch {
    return null;
  }
}

/** Ends this owner's connection and destroys the sealed token, so a later database read holds nothing to open. */
export async function revokeConnection(provider: Provider, owner: ConnectionOwner): Promise<boolean> {
  const empty = Buffer.alloc(0);
  const rows = await db().update(schema.connectedAccounts).set({ ciphertext: empty, iv: empty, tag: empty, revokedAt: new Date() }).where(ownedBy(provider, owner)).returning({ id: schema.connectedAccounts.id });
  return rows.length > 0;
}
