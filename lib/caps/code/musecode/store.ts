import { and, eq, gte, inArray, isNotNull, like, lt, or, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { MUSE_CODE_LIMITS } from "@/lib/caps/code/musecode/limits";
import type { CodeSessionRow, CodeSessionStore, NewCodeSession } from "@/lib/caps/code/musecode/handler";
import type { CodeSessionStatus } from "@/lib/caps/code/musecode/types";

/** Muse Code sessions' database (0028_code_sessions, docs/CAPABILITIES.md 15b), and their spend in `usage`. */

const ACTIVE: CodeSessionStatus[] = ["starting", "running"];

function startOfUtcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export const codeSessionStore: CodeSessionStore = {
  async insert(row: NewCodeSession) {
    await db().insert(schema.codeSessions).values(row);
  },
  async get(id) {
    const [row] = await db().select().from(schema.codeSessions).where(eq(schema.codeSessions.id, id)).limit(1);
    return (row as CodeSessionRow | undefined) ?? null;
  },
  async update(id, patch, whileStatus) {
    const { id: _id, ...rest } = patch;
    const rows = await db()
      .update(schema.codeSessions)
      .set(rest)
      .where(and(eq(schema.codeSessions.id, id), ...(whileStatus ? [inArray(schema.codeSessions.status, [...whileStatus])] : [])))
      .returning({ id: schema.codeSessions.id });
    return rows.length > 0;
  },
  async countActive(productId, now) {
    // A session past its limit and its sandbox's grace isn't running any more, whatever its row says yet.
    const live = and(inArray(schema.codeSessions.status, ACTIVE), gte(schema.codeSessions.endsAt, new Date(now.getTime() - MUSE_CODE_LIMITS.sandboxGraceMs)));
    const [row] = await db()
      .select({
        product: sql<number>`count(*) filter (where ${schema.codeSessions.productId} = ${productId})::int`,
        all: sql<number>`count(*)::int`,
      })
      .from(schema.codeSessions)
      .where(live);
    return { product: Number(row?.product ?? 0), all: Number(row?.all ?? 0) };
  },
  async buildTotals(namespace, now) {
    const rows = await db()
      .select({ tokenId: schema.codeSessions.tokenId, worked: schema.codeSessions.worked, status: schema.codeSessions.status, budgetUsd: schema.codeSessions.budgetUsd, startedAt: schema.codeSessions.startedAt, createdAt: schema.codeSessions.createdAt, endedAt: schema.codeSessions.endedAt, endsAt: schema.codeSessions.endsAt })
      .from(schema.codeSessions)
      .where(eq(schema.codeSessions.namespace, namespace));
    // A session that never started doesn't count against the build's two.
    const real = rows.filter((r) => r.startedAt !== null || ACTIVE.includes(r.status));
    let ms = 0;
    for (const r of real) {
      // A running session counts all the time it may still take, so two at once can't pass the build's minutes.
      const end = ACTIVE.includes(r.status) ? r.endsAt.getTime() : (r.endedAt ?? now).getTime();
      ms += Math.max(0, end - (r.startedAt ?? r.createdAt).getTime());
    }
    // Spent by sessions that ended, and the whole budget of any still running, so two at once can't pass the build's $0.50.
    const endedIds = real.filter((r) => !ACTIVE.includes(r.status)).map((r) => r.tokenId).filter((t): t is string => Boolean(t));
    let usd = real.filter((r) => ACTIVE.includes(r.status)).reduce((n, r) => n + r.budgetUsd, 0);
    if (endedIds.length) {
      const [row] = await db().select({ total: sql<number>`coalesce(sum(${schema.usage.costUsd}), 0)` }).from(schema.usage).where(and(inArray(schema.usage.tokenId, endedIds), eq(schema.usage.source, "gateway")));
      usd += Number(row?.total ?? 0);
    }
    return { sessions: real.length, ms, usd, worked: real.filter((r) => r.worked).length };
  },
};

/** All a session token has spent. */
export async function sessionSpendUsd(tokenId: string): Promise<number> {
  const [row] = await db().select({ total: sql<number>`coalesce(sum(${schema.usage.costUsd}), 0)` }).from(schema.usage).where(eq(schema.usage.tokenId, tokenId));
  return Number(row?.total ?? 0);
}

/**
 * A token's spend today together with the spend of every session it started: what the product's (or the build's)
 * daily budget sees once Muse Code is on. For a session's own token it is that token's spend today.
 */
export async function familySpendToday(tokenId: string, now = new Date()): Promise<number> {
  const children = db().select({ id: schema.codeSessions.tokenId }).from(schema.codeSessions).where(and(eq(schema.codeSessions.parentTokenId, tokenId), isNotNull(schema.codeSessions.tokenId)));
  const [row] = await db()
    .select({ total: sql<number>`coalesce(sum(${schema.usage.costUsd}), 0)` })
    .from(schema.usage)
    .where(and(or(eq(schema.usage.tokenId, tokenId), inArray(schema.usage.tokenId, children)), gte(schema.usage.at, startOfUtcDay(now))));
  return Number(row?.total ?? 0);
}

/** The session a token belongs to. */
export async function sessionByToken(tokenId: string): Promise<CodeSessionRow | null> {
  const [row] = await db().select().from(schema.codeSessions).where(eq(schema.codeSessions.tokenId, tokenId)).limit(1);
  return (row as CodeSessionRow | undefined) ?? null;
}

/** Whether the brief behind a token asks for Muse Code: a build token's build, or a live token's product's latest build. */
export async function briefOfToken(token: { scope: string; productId: string; buildId: string | null }): Promise<unknown> {
  if (token.scope === "build") {
    if (!token.buildId) return null;
    const [row] = await db().select({ brief: schema.builds.brief }).from(schema.builds).where(eq(schema.builds.id, token.buildId)).limit(1);
    return row?.brief ?? null;
  }
  const [row] = await db()
    .select({ brief: schema.builds.brief })
    .from(schema.products)
    .innerJoin(schema.builds, eq(schema.builds.id, schema.products.latestBuildId))
    .where(eq(schema.products.id, token.productId))
    .limit(1);
  return row?.brief ?? null;
}

// ---------- The sweep's reads ----------

/** Sessions still marked starting or running, by product or build namespace. */
export async function activeSessionsWhere(by: { productId?: string; namespace?: string }): Promise<CodeSessionRow[]> {
  const rows = await db()
    .select()
    .from(schema.codeSessions)
    .where(and(inArray(schema.codeSessions.status, ACTIVE), ...(by.productId ? [eq(schema.codeSessions.productId, by.productId)] : []), ...(by.namespace ? [eq(schema.codeSessions.namespace, by.namespace)] : [])));
  return rows as CodeSessionRow[];
}

/** Every sandbox name a session still starting or running holds. */
export async function activeSandboxNames(): Promise<Set<string>> {
  const rows = await db().select({ name: schema.codeSessions.sandboxName }).from(schema.codeSessions).where(inArray(schema.codeSessions.status, ACTIVE));
  return new Set(rows.map((r) => r.name));
}

/** Result zips past their 24 hours. */
export async function expiredResults(now: Date): Promise<Array<{ id: string; url: string }>> {
  const rows = await db()
    .select({ id: schema.codeSessions.id, url: schema.codeSessions.resultUrl })
    .from(schema.codeSessions)
    .where(and(isNotNull(schema.codeSessions.resultUrl), lt(schema.codeSessions.resultExpiresAt, now)))
    .limit(200);
  return rows.filter((r): r is { id: string; url: string } => Boolean(r.url));
}

export async function clearResult(id: string): Promise<void> {
  await db().update(schema.codeSessions).set({ resultUrl: null }).where(eq(schema.codeSessions.id, id));
}

/**
 * Clears what a person's task may be quoted in, once a session has been over a day: its steps, final text, file names and
 * reason. The row stays, with its counts and cost, since the day's spend finds its token through it. Returns how many.
 */
export async function clearOldSessionText(before: Date): Promise<number> {
  const rows = await db()
    .update(schema.codeSessions)
    .set({ events: [], condense: {}, finalText: null, files: [], dropped: [], reason: null })
    .where(and(lt(schema.codeSessions.endedAt, before), sql`${schema.codeSessions.status} not in ('starting', 'running')`, sql`(${schema.codeSessions.finalText} is not null or ${schema.codeSessions.reason} is not null or jsonb_array_length(${schema.codeSessions.events}) > 0 or jsonb_array_length(${schema.codeSessions.files}) > 0 or jsonb_array_length(${schema.codeSessions.dropped}) > 0)`))
    .returning({ id: schema.codeSessions.id });
  return rows.length;
}

/** A build's session rows once it has ended (their zips first), and crashed builds' after two days. */
export async function deleteBuildSessions(namespace: string): Promise<void> {
  await db().delete(schema.codeSessions).where(and(eq(schema.codeSessions.namespace, namespace), sql`${schema.codeSessions.status} not in ('starting', 'running')`));
}

export async function oldBuildSessionResults(before: Date): Promise<Array<{ id: string; url: string | null; namespace: string }>> {
  return db()
    .select({ id: schema.codeSessions.id, url: schema.codeSessions.resultUrl, namespace: schema.codeSessions.namespace })
    .from(schema.codeSessions)
    .where(and(like(schema.codeSessions.namespace, "b:%"), lt(schema.codeSessions.createdAt, before), sql`${schema.codeSessions.status} not in ('starting', 'running')`))
    .limit(200);
}

export async function deleteSession(id: string): Promise<void> {
  await db().delete(schema.codeSessions).where(eq(schema.codeSessions.id, id));
}

/**
 * The gateway's record of a build's sessions (CAP_PROOF.code): real ones, and those that worked, over the whole build
 * and not one verify. A build gets 2 real sessions and many verifies, so a run that worked holds for the verifies after it.
 */
export async function museCodeProof(namespace: string): Promise<{ museCode: number; museCodeWorked: number }> {
  const [row] = await db()
    .select({ n: sql<number>`count(*) filter (where ${schema.codeSessions.startedAt} is not null)::int`, worked: sql<number>`count(*) filter (where ${schema.codeSessions.worked})::int` })
    .from(schema.codeSessions)
    .where(eq(schema.codeSessions.namespace, namespace));
  return { museCode: Number(row?.n ?? 0), museCodeWorked: Number(row?.worked ?? 0) };
}

/** A build's result zips, so they go with its rows. */
export async function buildResultUrls(namespace: string): Promise<string[]> {
  const rows = await db().select({ url: schema.codeSessions.resultUrl }).from(schema.codeSessions).where(and(eq(schema.codeSessions.namespace, namespace), isNotNull(schema.codeSessions.resultUrl)));
  return rows.map((r) => r.url).filter((u): u is string => Boolean(u));
}
