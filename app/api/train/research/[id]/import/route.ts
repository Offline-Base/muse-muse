import { requireAdminOrAutomation } from "@/lib/auth";
import { env } from "@/lib/env";
import { reserveCounter } from "@/lib/gateway/store";
import { errorJson, readJson, route } from "@/lib/http";
import { datasetSystemPrompt } from "@/lib/train/logic";
import { importSource } from "@/lib/train/research/import";
import { addResearchImport, getResearch } from "@/lib/train/research/store";
import { createImportedDataset } from "@/lib/train/store";

export const maxDuration = 60;
const HOUR_MS = 3_600_000;
const IMPORTS_PER_HOUR = 10;

/**
 * POST {sourceId, licenseConfirmed?} -> 201 {datasetId, href, rows, read, dropped}: reads a report's source and saves its
 * rows as a ready dataset. No Meta call, and no job starts. Whether it may be imported is decided from the stored source
 * (lib/train/research/import.ts). Admins or automation, 404 with TUNE_RESEARCH off or an unknown source, 409 not_ready or
 * already_imported, 400 confirm_license, 422 {error, message} refused, 429 rate_limited.
 */
export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireAdminOrAutomation(req);
  if (!env.tuneResearch) return errorJson(404, "not_found");
  const row = await getResearch((await ctx.params).id);
  if (!row) return errorJson(404, "not_found");
  if (row.status !== "ready") return errorJson(409, "not_ready");
  const body = await readJson(req, 4 * 1024);
  const source = row.sources.find((s) => s.id === body.sourceId);
  if (!source) return errorJson(404, "not_found");
  const done = row.imports.find((i) => i.sourceId === source.id);
  if (done) return errorJson(409, "already_imported", { datasetId: done.datasetId, href: `/fine-tuning/datasets/${done.datasetId}` });

  const now = new Date();
  const hour = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
  if ((await reserveCounter(`tune-research-import:${user.id}`, hour, 1, IMPORTS_PER_HOUR)) === null) {
    return errorJson(429, "rate_limited", { retryAfterSeconds: Math.max(1, Math.ceil((hour.getTime() + HOUR_MS - now.getTime()) / 1000)) });
  }
  const got = await importSource(source, body.licenseConfirmed === true);
  if (!got.ok) return errorJson(got.status, got.error, { message: got.message });

  const dataset = await createImportedDataset({
    title: source.title,
    task: row.task,
    system: datasetSystemPrompt(row.task),
    rows: got.rows,
    note: got.note,
    createdBy: user.id,
  });
  if (!dataset) return errorJson(500, "import_failed");
  await addResearchImport(row.id, { sourceId: source.id, datasetId: dataset.id, rows: got.rows.length, license: got.license, revision: got.revision, at: now.toISOString() });
  return Response.json({ datasetId: dataset.id, href: `/fine-tuning/datasets/${dataset.id}`, rows: got.rows.length, read: got.read, dropped: got.dropped }, { status: 201 });
});
