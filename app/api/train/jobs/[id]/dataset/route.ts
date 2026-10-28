import { hitRateLimits } from "@/lib/gateway/store";
import { errorJson, route } from "@/lib/http";
import { datasetPage, getJob } from "@/lib/train/store";
import { requireJobToken } from "../../../shared";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Examples per page. An example is at most about 7,800 characters (a 2,300-character system prompt, a 1,500-character
 * prompt and a 4,000-character answer), so a page stays under 2.5 MB even when every character takes 3 bytes, well
 * inside Vercel's 4.5 MB response limit.
 */
const DATASET_PAGE_SIZE = 100;
/** A 1000-example dataset is 9 train pages and 1 eval page; this leaves room for the runner's retries. */
const READS_PER_HOUR = 120;

/**
 * GET ?part=train|eval&page=N (N from 0) -> {items: TrainExample[] | EvalExample[], nextPage: number | null, title},
 * from the job's runner with "Authorization: Bearer <job token>" (it works until 15 minutes after the job ended). The
 * job's dataset is params.datasetId, and title is its name (glimmer-lora's short student prompt is made from it). At most 100 items a page. 401 bad token, 400 bad part or page, 404 no_dataset (the job
 * has no dataset param, or the dataset is gone), 409 dataset_not_ready, 429 rate_limited past 120 pages an hour.
 */
export const GET = route(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  await requireJobToken(req, id);
  const url = new URL(req.url);
  const part = url.searchParams.get("part");
  if (part !== "train" && part !== "eval") return errorJson(400, "part must be train or eval.");
  const rawPage = url.searchParams.get("page") ?? "0";
  if (!/^\d{1,4}$/.test(rawPage)) return errorJson(400, "page must be a whole number from 0.");
  const page = Number(rawPage);

  const hour = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
  const key = `train-dataset:${id}`;
  const counts = await hitRateLimits([key], hour);
  if ((counts[key] ?? 0) > READS_PER_HOUR) return errorJson(429, "rate_limited");

  const job = await getJob(id);
  if (!job) return errorJson(404, "not_found");
  const datasetId = typeof job.params?.datasetId === "string" ? job.params.datasetId : null;
  if (!datasetId) return errorJson(404, "no_dataset");
  const slice = await datasetPage(datasetId, part, page * DATASET_PAGE_SIZE, DATASET_PAGE_SIZE);
  if (!slice) return errorJson(404, "no_dataset");
  // While it generates, train still holds the items that become eval.
  if (slice.status !== "ready") return errorJson(409, "dataset_not_ready");
  const nextPage = (page + 1) * DATASET_PAGE_SIZE < slice.total ? page + 1 : null;
  return Response.json({ items: slice.items, nextPage, title: slice.title });
});
