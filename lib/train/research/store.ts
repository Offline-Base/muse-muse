/** The training_research rows (lib/train/research). No import from components/, so the workflow bundle builds. */
import { desc, eq, and, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import type { ResearchFinding, ResearchImport, ResearchSource } from "@/lib/train/research/types";

const research = schema.trainingResearch;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTE_MAX = 1000;

export type ResearchRow = typeof research.$inferSelect;

export async function createResearch(i: { task: string; maxUsd: number; createdBy?: string | null }): Promise<ResearchRow> {
  const [row] = await db().insert(research).values({ task: i.task, maxUsd: i.maxUsd, createdBy: i.createdBy ?? null }).returning();
  return row;
}

export async function getResearch(id: string): Promise<ResearchRow | null> {
  if (!UUID_RE.test(id)) return null;
  const [row] = await db().select().from(research).where(eq(research.id, id)).limit(1);
  return row ?? null;
}

export async function listResearch(limit = 30): Promise<Array<Pick<ResearchRow, "id" | "task" | "status" | "costUsd" | "createdAt">>> {
  return db()
    .select({ id: research.id, task: research.task, status: research.status, costUsd: research.costUsd, createdAt: research.createdAt })
    .from(research)
    .orderBy(desc(research.createdAt))
    .limit(limit);
}

export async function attachResearchRun(id: string, runId: string): Promise<void> {
  await db().update(research).set({ workflowRunId: runId }).where(eq(research.id, id));
}

export async function saveResearchQuestions(id: string, questions: string[]): Promise<void> {
  await db().update(research).set({ questions }).where(eq(research.id, id));
}

/** Adds what a Meta call cost to the run. */
export async function addResearchCost(id: string, usd: number): Promise<void> {
  if (!(usd > 0)) return;
  await db().update(research).set({ costUsd: sql`round((${research.costUsd} + ${usd})::numeric, 6)::real` }).where(eq(research.id, id));
}

/** Keeps one search's finding, once, so a retried step never asks and pays again. */
export async function addResearchFinding(id: string, finding: ResearchFinding): Promise<void> {
  const one = JSON.stringify([finding]);
  await db()
    .update(research)
    .set({ findings: sql`${research.findings} || ${one}::jsonb` })
    .where(and(eq(research.id, id), sql`not ${research.findings} @> jsonb_build_array(jsonb_build_object('index', ${finding.index}::int))`));
}

export async function finishResearch(id: string, i: { sources: ResearchSource[]; note: string | null }): Promise<void> {
  await db()
    .update(research)
    .set({ status: "ready", sources: i.sources, note: i.note?.slice(0, NOTE_MAX) ?? null, finishedAt: new Date() })
    .where(and(eq(research.id, id), eq(research.status, "running")));
}

export async function failResearch(id: string, error: string): Promise<void> {
  await db()
    .update(research)
    .set({ status: "failed", error: error.slice(0, NOTE_MAX), finishedAt: new Date() })
    .where(and(eq(research.id, id), eq(research.status, "running")));
}

export async function addResearchImport(id: string, item: ResearchImport): Promise<void> {
  await db()
    .update(research)
    .set({ imports: sql`${research.imports} || ${JSON.stringify([item])}::jsonb` })
    .where(eq(research.id, id));
}
