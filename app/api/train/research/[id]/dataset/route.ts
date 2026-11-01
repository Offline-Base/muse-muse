import { start } from "workflow/api";
import { requireAdminOrAutomation } from "@/lib/auth";
import { env, testModel } from "@/lib/env";
import { errorJson, readJson, route } from "@/lib/http";
import { spendPaused } from "@/lib/quota";
import { DATASET_MODEL, makeDataset } from "@/lib/train/datasets";
import { DATASET_MAX_COUNT, DATASET_MIN_COUNT } from "@/lib/train/logic";
import { piiFindings, piiSentences } from "@/lib/train/public/content";
import { groundingNotes } from "@/lib/train/research/logic";
import { getResearch } from "@/lib/train/research/store";
import { attachDatasetRun, createDataset, failDataset } from "@/lib/train/store";

const TITLE_MAX = 200;

/**
 * POST {picks: sourceId[], count, title?} -> 201 {datasetId, href}: starts a dataset whose writer reads the picked
 * sources' notes as background, the task as the admin wrote it. It writes examples and trains nothing. Admins or
 * automation, 404 with TUNE_RESEARCH off, 400 bad input, 409 not_ready, 422 personal data in the notes, 503 as
 * /api/train/datasets, 500 start_failed.
 */
export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireAdminOrAutomation(req);
  if (!env.tuneResearch) return errorJson(404, "not_found");
  const row = await getResearch((await ctx.params).id);
  if (!row) return errorJson(404, "not_found");
  if (row.status !== "ready") return errorJson(409, "not_ready");
  const body = await readJson(req, 16 * 1024);
  const picks = new Set(Array.isArray(body.picks) ? body.picks : []);
  const picked = row.sources.filter((s) => picks.has(s.id));
  if (!picked.length) return errorJson(400, "Pick at least one source.");
  const count = Number(body.count);
  if (!Number.isInteger(count) || count < DATASET_MIN_COUNT || count > DATASET_MAX_COUNT) {
    return errorJson(400, `count must be a whole number from ${DATASET_MIN_COUNT} to ${DATASET_MAX_COUNT}.`);
  }
  const grounding = groundingNotes(picked);
  const pii = piiSentences(piiFindings({ task: grounding }));
  if (pii.length) return errorJson(422, "personal_data", { refusal: pii.join(" ") });
  if (!process.env.MODEL_API_KEY) return errorJson(503, "meta_not_configured");
  if (await spendPaused()) return errorJson(503, "paused");

  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, TITLE_MAX) : row.task.slice(0, 60);
  const dataset = await createDataset({ title, task: row.task, requested: count, writerModel: testModel() ?? DATASET_MODEL, createdBy: user.id, grounding });
  try {
    const { runId } = await start(makeDataset, [{ datasetId: dataset.id }]);
    await attachDatasetRun(dataset.id, runId).catch((err) => console.error("[train/research] attachRun", err));
  } catch (err) {
    console.error("[train/research] start dataset", err);
    await failDataset(dataset.id, "The dataset's workflow could not start, so nothing was written.").catch((e) => console.error("[train/research] fail", e));
    return errorJson(500, "start_failed");
  }
  return Response.json({ datasetId: dataset.id, href: `/fine-tuning/datasets/${dataset.id}` }, { status: 201 });
});
