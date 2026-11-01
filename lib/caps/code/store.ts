import { and, eq, gte, sql } from "drizzle-orm";
import { codeBlock } from "@/lib/caps/code/brief";
import { buildNamespace } from "@/lib/caps/proof";
import { buildBrief } from "@/lib/caps/store";
import { db, schema } from "@/lib/db/client";

/** The code cap's database (docs/CAPABILITIES.md, section 15): exec_runs (0024_code) and its spend in `usage`. */

export type ExecRunRow = typeof schema.execRuns.$inferInsert;

export async function recordExecRun(row: ExecRunRow): Promise<void> {
  await db().insert(schema.execRuns).values(row);
}

function startOfUtcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** What a source ("exec" or "browse") has spent across the platform today (UTC), reservations included. */
export async function codeSpendToday(source: "exec" | "browse"): Promise<number> {
  const [row] = await db()
    .select({ total: sql<number>`coalesce(sum(${schema.usage.costUsd}), 0)` })
    .from(schema.usage)
    .where(and(eq(schema.usage.source, source), gte(schema.usage.at, startOfUtcDay())));
  return Number(row?.total ?? 0);
}

/**
 * The gateway's record of a build's runs (CAP_PROOF.code): runs in its namespace since `since`, by kind and outcome, and
 * which parts its brief asked for (`brief:<part>`), so the fixed checks know what to require. Product code writes none
 * of it.
 */
export async function codeProof(buildId: string, window: { since: Date | null }): Promise<Record<string, number>> {
  const rows = await db()
    .select({ kind: schema.execRuns.kind, status: schema.execRuns.status, n: sql<number>`count(*)::int` })
    .from(schema.execRuns)
    .where(and(eq(schema.execRuns.namespace, buildNamespace(buildId)), ...(window.since ? [gte(schema.execRuns.createdAt, window.since)] : [])))
    .groupBy(schema.execRuns.kind, schema.execRuns.status);
  const out: Record<string, number> = { exec: 0, execOk: 0, browse: 0 };
  for (const r of rows) {
    if (r.kind === "exec") {
      out.exec! += Number(r.n);
      if (r.status === "ok") out.execOk! += Number(r.n);
    } else if (r.kind === "browse" && (r.status === "ok" || r.status === "simulated")) out.browse! += Number(r.n);
  }
  const block = codeBlock((await buildBrief(buildId)) as object | null);
  for (const part of block?.runtimes ?? []) out[`brief:${part}`] = 1;
  if (block?.browse) out["brief:browse"] = 1;
  return out;
}
