import { start } from "workflow/api";
import { requireAdminOrAutomation } from "@/lib/auth";
import { errorJson, readJson, route } from "@/lib/http";
import { spendPaused } from "@/lib/quota";
import { DATASET_MODEL, makeDataset } from "@/lib/train/datasets";
import { DATASET_MAX_COUNT, DATASET_MIN_COUNT, DATASET_TASK_MAX, DATASET_TASK_MIN, toDatasetView } from "@/lib/train/logic";
import { attachDatasetRun, createDataset, failDataset, listDatasets } from "@/lib/train/store";

const TITLE_MAX = 200;
/** A dataset with no title is named after the start of its task. */
const TITLE_FROM_TASK = 60;

/** The start of the task, cut at a word when it is longer than TITLE_FROM_TASK. */
function titleFrom(task: string): string {
  if (task.length <= TITLE_FROM_TASK) return task;
  return task.slice(0, TITLE_FROM_TASK).replace(/\s+\S*$/, "") || task.slice(0, TITLE_FROM_TASK);
}

/** GET -> {datasets: DatasetView[]}, newest first, without their examples. Admins only. */
export const GET = route(async (req: Request) => {
  await requireAdminOrAutomation(req);
  const rows = await listDatasets(100);
  return Response.json({ datasets: rows.map(toDatasetView) });
});

/**
 * POST {title?, task, count} -> 201 {dataset}. Admins or automation only. Saves a dataset in "generating", with
 * DATASET_MODEL (Muse Wonder) as its writer_model, and starts the makeDataset workflow, in which that model writes
 * `count` (20 to 1000) prompts for the task and answers them, with 10% held out for eval. 400 bad input, 503
 * meta_not_configured (no MODEL_API_KEY), 503 paused (the platform's daily spend cap is reached), 500 start_failed.
 */
export const POST = route(async (req: Request) => {
  const user = await requireAdminOrAutomation(req);
  const body = await readJson(req, 16 * 1024);

  if (typeof body.task !== "string") return errorJson(400, "Describe the task the model should learn.");
  const task = body.task.trim();
  if (task.length < DATASET_TASK_MIN) return errorJson(400, `Describe the task in at least ${DATASET_TASK_MIN} characters.`);
  if (task.length > DATASET_TASK_MAX) return errorJson(400, `Keep the task under ${DATASET_TASK_MAX} characters.`);
  if (body.title !== undefined && body.title !== null && typeof body.title !== "string") {
    return errorJson(400, "title must be text.");
  }
  const title =
    typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, TITLE_MAX) : titleFrom(task);
  const count = typeof body.count === "number" ? body.count : typeof body.count === "string" ? Number(body.count.trim()) : NaN;
  if (!Number.isInteger(count) || count < DATASET_MIN_COUNT || count > DATASET_MAX_COUNT) {
    return errorJson(400, `count must be a whole number from ${DATASET_MIN_COUNT} to ${DATASET_MAX_COUNT}.`);
  }

  if (!process.env.MODEL_API_KEY) return errorJson(503, "meta_not_configured");
  if (await spendPaused()) return errorJson(503, "paused");

  const dataset = await createDataset({ title, task, requested: count, writerModel: DATASET_MODEL, createdBy: user.id });
  let runId: string;
  try {
    runId = (await start(makeDataset, [{ datasetId: dataset.id }])).runId;
  } catch (err) {
    console.error("[train/datasets] start", err);
    await failDataset(dataset.id, "The dataset's workflow could not start, so nothing was written.").catch((e) =>
      console.error("[train/datasets] markStartFailed", e),
    );
    return errorJson(500, "start_failed");
  }
  await attachDatasetRun(dataset.id, runId).catch((err) => console.error("[train/datasets] attachRun", err));
  return Response.json({ dataset: toDatasetView(dataset) }, { status: 201 });
});
