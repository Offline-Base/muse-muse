import { requireAdminOrAutomation } from "@/lib/auth";
import { env } from "@/lib/env";
import { errorJson, route } from "@/lib/http";
import { localFilesFor } from "@/lib/train/local-files-server";
import { quantBaseForAdapter } from "@/lib/train/quant-targets";
import { ADAPTER_RECIPE, adapterProblem, quantProblem, toHubView, type TrainJobRow } from "@/lib/train/logic";
import { getAdapterSource, getJob, quantJobsOf } from "@/lib/train/store";
import { QUANT_RECIPE, type TrainStatus } from "@/lib/train/types";
import { POST as startJob } from "../../route";

type Ctx = { params: Promise<{ id: string }> };

// Starting the job asks Lambda for a GPU, as POST /api/train/jobs does.
export const maxDuration = 60;

const TITLE_MAX = 200;

/** A local files job of the adapter, as the adapter's page shows it. */
interface QuantJobSummary {
  id: string;
  title: string;
  status: TrainStatus;
  createdAt: string;
  finishedAt: string | null;
  terminatedAt: string | null;
  error: string | null;
  hub: ReturnType<typeof toHubView> | null;
}

function summary(row: TrainJobRow, now: Date): QuantJobSummary {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    terminatedAt: row.terminatedAt ? row.terminatedAt.toISOString() : null,
    error: row.error,
    hub: row.hub ? toHubView(row.hub, row.params, now) : null,
  };
}

/**
 * Why this job's adapter can't have its local files made now, as the jobs route would refuse it, or null: not a
 * glimmer-lora job whose adapter is on its region's cache (adapterProblem), not judged or not trained under the short
 * student prompt (quantProblem), or not published on the Hub, which its GGUF repo links to.
 */
async function problemOf(jobId: string): Promise<string | null> {
  const source = await getAdapterSource(jobId);
  const targets = env.quantTargets;
  const problem =
    adapterProblem(source?.job ?? null, source?.metrics ?? null, { smallQuantBase: targets }) ?? (source ? quantProblem(source.job, source.metrics, { targets }) : null);
  if (problem) return `This adapter can't have local files made: ${problem}`;
  if (source?.job.hub?.status !== "published") return "Publish the adapter to Hugging Face first: its local files go to a repo whose card links to it.";
  return null;
}

/**
 * GET -> {quantOff, hubOff, problem, latest, files, targets, smallBase}: what a glimmer-lora job's page needs for Make local files
 * (docs/TRAINING.md "Local files"). quantOff and hubOff say why making or publishing them is off here (QUANT_ENABLED,
 * env.hubOffReason), problem why this adapter can't have them now, latest its newest local files job (with the GGUF
 * repo's hub view), files the newest ones that passed (localFilesFor), targets whether QUANT_TARGETS is on, and smallBase
 * the small base this adapter merges into with it on, by name. Admins or automation only. 404 for an
 * unknown job or one that isn't a glimmer-lora job.
 */
export const GET = route(async (req: Request, { params }: Ctx) => {
  await requireAdminOrAutomation(req);
  const { id } = await params;
  const job = await getJob(id);
  if (!job || job.recipe !== ADAPTER_RECIPE) return errorJson(404, "not_found");
  const now = new Date();
  const [problem, jobs, files] = await Promise.all([problemOf(job.id), quantJobsOf(job.id, 1), localFilesFor(job.id)]);
  return Response.json(
    {
      quantOff: env.quantEnabled ? null : "QUANT_ENABLED isn't on",
      hubOff: env.hubOffReason,
      problem,
      latest: jobs[0] ? summary(jobs[0], now) : null,
      files,
      targets: env.quantTargets,
      smallBase: env.quantTargets ? (quantBaseForAdapter(job.params)?.label ?? null) : null,
    },
    { headers: { "cache-control": "no-store" } },
  );
});

/**
 * POST -> 202 {quantJobId, job}: Make local files. Starts a glimmer-quantize job for this glimmer-lora job's adapter
 * through POST /api/train/jobs itself, so it gets every check a GPU job gets there (the switch, a judged and published
 * adapter, one local files job per adapter at a time, the sweep, the GPU and daily caps, a GPU in the adapter's region,
 * the run's estimate) and its replies, which come back as they are. The admin's session is the same request's;
 * automation's bearer secret is passed on. Admins or automation only. 404 for an unknown job or one that isn't a
 * glimmer-lora job, 500 start_failed.
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  await requireAdminOrAutomation(req);
  const { id } = await params;
  const job = await getJob(id);
  if (!job || job.recipe !== ADAPTER_RECIPE) return errorJson(404, "not_found");
  const auth = req.headers.get("authorization");
  const res = await startJob(
    new Request(new URL("/api/train/jobs", req.url), {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify({ recipe: QUANT_RECIPE, title: `Local files: ${job.title}`.slice(0, TITLE_MAX), params: { adapterJobId: job.id } }),
    }),
  );
  if (res.status !== 201) return res;
  const created = (await res.json().catch(() => null)) as { job?: { id?: unknown } } | null;
  const quantJobId = typeof created?.job?.id === "string" ? created.job.id : null;
  if (!quantJobId) return errorJson(500, "start_failed");
  return Response.json({ quantJobId, job: created!.job }, { status: 202, headers: { "cache-control": "no-store" } });
});
