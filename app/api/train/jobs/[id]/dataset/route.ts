import { decideJson } from "@/lib/decide/format";
import { hitRateLimits } from "@/lib/gateway/store";
import { errorJson, route } from "@/lib/http";
import { decideEpochs, decisionPage, decisionPageCount, decisionPageRows, isDecideMode } from "@/lib/train/decision-datasets";
import { isQuantRecipe, isServeRecipe, SERVE_ADAPTER_PARAM, type DatasetHead, type TrainJobRow } from "@/lib/train/logic";
import { datasetPage, decisionSplitRows, getDataset, getJob, tunedAnswers } from "@/lib/train/store";
import { requireJobToken } from "../../../shared";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Examples per page. An example is at most about 7,800 characters (a 2,300-character system prompt, a 1,500-character
 * prompt and a 4,000-character answer), so a page stays under 2.5 MB even when every character takes 3 bytes, well
 * inside Vercel's 4.5 MB response limit.
 */
const DATASET_PAGE_SIZE = 100;
/**
 * A 1000-example dataset is 9 train pages and 1 eval page; this leaves room for the runner's retries. A decide job may
 * read its own page count on top (decisionPageCount), since a large decision dataset has more pages than this.
 */
const READS_PER_HOUR = 120;

/**
 * The dataset a job reads: its own datasetId param, or for a glimmer-serve or glimmer-quantize job (which have none)
 * the dataset its adapter's glimmer-lora job trained on, so its demo server answers, or its local files are checked,
 * under the same short system line, made from that dataset's title. With the adapter's job for a glimmer-quantize job,
 * whose eval pages carry that job's own tuned answers. `trainer` is the job that trained on it (the job itself, or
 * the adapter's job), whose mode and epochs a decision dataset's pages follow. Null when there is none.
 */
async function datasetOf(job: TrainJobRow): Promise<{ datasetId: string; answersOf: string | null; trainer: TrainJobRow } | null> {
  if (typeof job.params?.datasetId === "string") return { datasetId: job.params.datasetId, answersOf: null, trainer: job };
  const adapterJobId = job.params?.[SERVE_ADAPTER_PARAM];
  if (!(isServeRecipe(job.recipe) || isQuantRecipe(job.recipe)) || typeof adapterJobId !== "string") return null;
  const adapter = await getJob(adapterJobId);
  if (typeof adapter?.params?.datasetId !== "string") return null;
  return { datasetId: adapter.params.datasetId, answersOf: isQuantRecipe(job.recipe) ? adapter.id : null, trainer: adapter };
}

/**
 * One page of a decision dataset (docs/DECISION_MODELS.md, "Pages for the GPU"): the platform renders everything, and
 * the GPU sees answers only for the rows it trains on. part=train is TrainExample rows (the trainer's epochs, plus
 * balancing copies), part=dev and part=eval (the test split) are {index, row, group, messages, letters} items with no
 * answer, laid out as scoring reads them back. Only the rows the page renders are read. Only for a job in decide mode,
 * which may read its own page count plus 120 pages an hour.
 */
async function decisionPart(head: DatasetHead, trainer: TrainJobRow, part: "train" | "dev" | "eval", page: number, reads: number): Promise<Response> {
  const spec = head.decision;
  if (head.status !== "ready" || !spec) return errorJson(409, "dataset_not_ready");
  if (!isDecideMode(trainer.params)) return errorJson(409, "not_decide_mode");
  const epochs = decideEpochs(trainer.params);
  if (reads > decisionPageCount(spec, epochs) + READS_PER_HOUR) return errorJson(429, "rate_limited");
  const split = part === "eval" ? "test" : part;
  const need = decisionPageRows(spec, split, epochs, page);
  const read = need.length ? await decisionSplitRows(head.id, split, need) : { total: spec.split[split], rows: new Map() };
  if (!read) return errorJson(404, "no_dataset");
  if (read.total !== spec.split[split]) throw new Error(`Dataset ${head.id}'s ${split} rows don't match its spec.`);
  const { items, total, nextPage } = decisionPage(spec, split, epochs, page, read.rows);
  // decide.json, which the GPU writes next to the adapter (docs/DECISION_MODELS.md "Files a decision model produces"):
  // T is fit after the run from the dev scores, so the GPU's copy holds T = 1.
  const decide = decideJson({ question: spec.question, labels: spec.labels, T: 1 });
  return Response.json({ kind: "decision", items, nextPage, total, title: head.title, decideJson: decide });
}

/**
 * GET ?part=train|dev|eval&page=N (N from 0) -> {items: TrainExample[] | EvalExample[], nextPage: number | null, title},
 * from the job's runner with "Authorization: Bearer <job token>" (it works until 15 minutes after the job ended). The
 * job's dataset is params.datasetId (for glimmer-serve and glimmer-quantize, its adapter job's), and title is its name
 * (glimmer-lora's short student prompt is made from it). A glimmer-quantize job's eval items also carry `tuned`, the
 * adapter job's own answer to each. At most 100 items a page. 401 bad token, 400 bad part or page, 404 no_dataset (the
 * job has no dataset, or the dataset is gone), 409 dataset_not_ready, 429 rate_limited past 120 pages an hour.
 *
 * A decision dataset (kind "decision") answers {kind: "decision", items, nextPage, total, title, decideJson} with
 * DECIDE_PAGE_SIZE (50) renderings a page, and takes part=dev too (decisionPart). decideJson is the model's decide.json
 * with T = 1 (decideJson in lib/decide/format.ts), which the GPU writes next to the adapter. 409 not_decide_mode when the job that trained on it
 * isn't in decide mode; 429 past its own page count plus 120 an hour. part=dev on a chat dataset is a 400.
 */
export const GET = route(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  await requireJobToken(req, id);
  const url = new URL(req.url);
  const part = url.searchParams.get("part");
  if (part !== "train" && part !== "dev" && part !== "eval") return errorJson(400, "part must be train, dev or eval.");
  const rawPage = url.searchParams.get("page") ?? "0";
  if (!/^\d{1,4}$/.test(rawPage)) return errorJson(400, "page must be a whole number from 0.");
  const page = Number(rawPage);

  const hour = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
  const key = `train-dataset:${id}`;
  const counts = await hitRateLimits([key], hour);
  const reads = counts[key] ?? 0;

  const job = await getJob(id);
  if (!job) return errorJson(404, "not_found");
  const source = await datasetOf(job);
  if (!source) return errorJson(404, "no_dataset");
  // The head only, without its rows: a decision dataset's pages are rendered here, and may number more than 120.
  const head = await getDataset(source.datasetId);
  if (head?.kind === "decision") return decisionPart(head, source.trainer, part, page, reads);
  if (reads > READS_PER_HOUR) return errorJson(429, "rate_limited");
  if (part === "dev") return errorJson(400, "part=dev is only for decision datasets.");
  const slice = await datasetPage(source.datasetId, part, page * DATASET_PAGE_SIZE, DATASET_PAGE_SIZE);
  if (!slice) return errorJson(404, "no_dataset");
  // While it generates, train still holds the items that become eval.
  if (slice.status !== "ready") return errorJson(409, "dataset_not_ready");
  const nextPage = (page + 1) * DATASET_PAGE_SIZE < slice.total ? page + 1 : null;
  if (part === "eval" && source.answersOf) {
    // The adapter's eval item i is the dataset's held-out item i, the same prompt: its tuned answer rides along.
    const answers = await tunedAnswers(source.answersOf);
    const items = (slice.items as Array<{ prompt: string; reference: string }>).map((item, k) => {
      const own = answers.get(page * DATASET_PAGE_SIZE + k);
      return own && own.prompt && item.prompt.startsWith(own.prompt) ? { ...item, tuned: own.tuned } : item;
    });
    return Response.json({ items, nextPage, title: slice.title });
  }
  return Response.json({ items: slice.items, nextPage, title: slice.title });
});
