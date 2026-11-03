import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import type { CocoBox } from "@/lib/train/sam/label";
import { samTuneRuns as t } from "@/lib/db/schema";
import { SAM_TUNE_LIMITS, type SamData, type SamDistractor, type SamPhoto, type SamStatus } from "@/lib/train/sam/types";

/**
 * U6's writes to a SAM tune run: the person's own photos, their boxes and the look-alikes, all while the run is a draft
 * on the person's own photos (data "uploads"). Each write is one UPDATE whose WHERE holds the rule, so two requests at
 * once can't pass a count cap or edit a run that was started meanwhile. The table is U1's samTuneRuns (migration 0033).
 */

export interface UploadRun {
  id: string;
  word: string;
  generic: string;
  data: SamData;
  status: SamStatus;
  photos: SamPhoto[];
  distractors: SamDistractor[];
  costUsd: number;
  maxUsd: number;
}

/** Why a run can't take an upload edit, or null when it can. */
export function editProblem(run: Pick<UploadRun, "data" | "status"> | null): "not_found" | "not_uploads" | "not_draft" | null {
  if (!run) return "not_found";
  if (run.data !== "uploads") return "not_uploads";
  if (run.status !== "draft") return "not_draft";
  return null;
}

export async function getUploadRun(id: string): Promise<UploadRun | null> {
  const [row] = await db()
    .select({
      id: t.id,
      word: t.word,
      generic: t.generic,
      data: t.data,
      status: t.status,
      photos: t.photos,
      distractors: t.distractors,
      costUsd: t.costUsd,
      maxUsd: t.maxUsd,
    })
    .from(t)
    .where(eq(t.id, id))
    .limit(1);
  if (!row) return null;
  return { ...row, photos: row.photos ?? [], distractors: row.distractors ?? [], costUsd: Number(row.costUsd ?? 0), maxUsd: Number(row.maxUsd ?? 0) };
}

const editable = (id: string) => and(eq(t.id, id), eq(t.status, "draft"), eq(t.data, "uploads"));

type ListColumn = typeof t.photos | typeof t.distractors;

/** Appends one item when the list has fewer than `max`; the new list, or null when full or not editable. */
async function append<T>(id: string, column: ListColumn, key: "photos" | "distractors", item: T, max: number): Promise<T[] | null> {
  const rows = await db()
    .update(t)
    .set({ [key]: sql`coalesce(${column}, '[]'::jsonb) || ${JSON.stringify([item])}::jsonb`, updatedAt: new Date() })
    .where(and(editable(id), sql`jsonb_array_length(coalesce(${column}, '[]'::jsonb)) < ${max}`))
    .returning({ list: column });
  return rows.length ? ((rows[0].list ?? []) as T[]) : null;
}

/** Merges `patch` into the one item whose url is `url`; true when it was there and the run is editable. */
async function patchByUrl(id: string, column: ListColumn, key: "photos" | "distractors", url: string, patch: Record<string, unknown>): Promise<boolean> {
  const rows = await db()
    .update(t)
    .set({
      [key]: sql`(select coalesce(jsonb_agg(case when x.e->>'url' = ${url} then x.e || ${JSON.stringify(patch)}::jsonb else x.e end order by x.o), '[]'::jsonb)
        from jsonb_array_elements(coalesce(${column}, '[]'::jsonb)) with ordinality as x(e, o))`,
      updatedAt: new Date(),
    })
    .where(and(editable(id), sql`coalesce(${column}, '[]'::jsonb) @> ${JSON.stringify([{ url }])}::jsonb`))
    .returning({ id: t.id });
  return rows.length > 0;
}

/** Adds a photo of the person's object, up to SAM_TUNE_LIMITS.photosMax. */
export function addPhoto(id: string, photo: SamPhoto): Promise<SamPhoto[] | null> {
  return append(id, t.photos, "photos", photo, SAM_TUNE_LIMITS.photosMax);
}

/** Adds a look-alike (made or the person's own), up to SAM_TUNE_LIMITS.distractorsMax. */
export function addDistractor(id: string, distractor: SamDistractor): Promise<SamDistractor[] | null> {
  return append(id, t.distractors, "distractors", distractor, SAM_TUNE_LIMITS.distractorsMax);
}

/** A photo's box (SAM's or the person's) and skipped mark. */
export function savePhoto(id: string, url: string, patch: { box: CocoBox | null; skipped: boolean }): Promise<boolean> {
  return patchByUrl(id, t.photos, "photos", url, patch);
}

/** Keeps or drops a look-alike. */
export function setDistractorKept(id: string, url: string, kept: boolean): Promise<boolean> {
  return patchByUrl(id, t.distractors, "distractors", url, { kept });
}

/** Adds a paid call's cost to the run. Any status: a call that was out when the run started still cost what it cost. */
export async function addRunCost(id: string, usd: number): Promise<void> {
  if (!(usd > 0)) return;
  await db()
    .update(t)
    .set({ costUsd: sql`${t.costUsd} + ${usd}`, updatedAt: new Date() })
    .where(eq(t.id, id));
}
