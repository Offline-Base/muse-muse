import { start } from "workflow/api";
import { requireAdminOrAutomation } from "@/lib/auth";
import { env } from "@/lib/env";
import { adjustCounter, reserveCounter } from "@/lib/gateway/store";
import { errorJson, readJson, route } from "@/lib/http";
import { spendPaused } from "@/lib/quota";
import { DATASET_TASK_MAX, DATASET_TASK_MIN } from "@/lib/train/logic";
import { attachResearchRun, createResearch, failResearch, listResearch } from "@/lib/train/research/store";
import { researchData } from "@/lib/train/research/workflow";

const HOUR_MS = 3_600_000;
const RUNS_PER_HOUR = 5;

/** GET -> {research: [...]}, newest first. Admins or automation, 404 with TUNE_RESEARCH off. */
export const GET = route(async (req: Request) => {
  await requireAdminOrAutomation(req);
  if (!env.tuneResearch) return errorJson(404, "not_found");
  return Response.json({ research: await listResearch() });
});

/**
 * POST {task} -> 201 {id, href}: starts the researchData workflow. Admins or automation, 404 with TUNE_RESEARCH off, 400
 * bad task, 503 meta_not_configured or paused, 429 rate_limited with {retryAfterSeconds} past 5 an hour, 500 start_failed.
 */
export const POST = route(async (req: Request) => {
  const user = await requireAdminOrAutomation(req);
  if (!env.tuneResearch) return errorJson(404, "not_found");
  const body = await readJson(req, 16 * 1024);
  const task = typeof body.task === "string" ? body.task.trim() : "";
  if (task.length < DATASET_TASK_MIN) return errorJson(400, `Describe the task in at least ${DATASET_TASK_MIN} characters.`);
  if (task.length > DATASET_TASK_MAX) return errorJson(400, `Keep the task under ${DATASET_TASK_MAX} characters.`);
  if (!process.env.MODEL_API_KEY) return errorJson(503, "meta_not_configured");
  if (await spendPaused()) return errorJson(503, "paused");

  const now = new Date();
  const hour = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
  const key = `tune-research:${user.id}`;
  if ((await reserveCounter(key, hour, 1, RUNS_PER_HOUR)) === null) {
    return errorJson(429, "rate_limited", { retryAfterSeconds: Math.max(1, Math.ceil((hour.getTime() + HOUR_MS - now.getTime()) / 1000)) });
  }
  const row = await createResearch({ task, maxUsd: env.tuneResearchMaxUsd, createdBy: user.id });
  try {
    const { runId } = await start(researchData, [{ researchId: row.id }]);
    await attachResearchRun(row.id, runId).catch((err) => console.error("[train/research] attach", err));
  } catch (err) {
    console.error("[train/research] start", err);
    await failResearch(row.id, "The research's workflow could not start, so nothing was spent.").catch((e) => console.error("[train/research] fail", e));
    await adjustCounter(key, hour, -1).catch((e) => console.error("[train/research] release", e));
    return errorJson(500, "start_failed");
  }
  return Response.json({ id: row.id, href: `/fine-tuning/research/${row.id}` }, { status: 201 });
});
