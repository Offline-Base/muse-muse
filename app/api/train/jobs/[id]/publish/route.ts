import { start } from "workflow/api";
import { requireAdminOrAutomation } from "@/lib/auth";
import { noEmDashes } from "@/lib/brief/normalize";
import { env } from "@/lib/env";
import { errorJson, readJson, route } from "@/lib/http";
import { createRepo, HubApiError, redact } from "@/lib/train/hub";
import { ggufJobProblem, ggufUploaded, hubJobProblem, hubUploaded, modelRepoName, validRepoName } from "@/lib/train/hub-cards";
import { GGUF_NOT_UPLOADED } from "@/lib/train/hub-steps";
import { effectiveWhy, hubBusy, toHubView, type TrainJobRow } from "@/lib/train/logic";
import { getAdapterSource, getDataset, getJob, recordEvent, updateHub } from "@/lib/train/store";
import { HUB_WHY_MAX, isTrainTerminal, PUBLISH_RECIPE, QUANT_RECIPE, type HubPublishResponse, type HubState } from "@/lib/train/types";
import { publishToHub } from "@/lib/train/workflow";
import { POST as startJob } from "../../route";

type Ctx = { params: Promise<{ id: string }> };

// Starting the upload job asks Lambda for a GPU, as POST /api/train/jobs does.
export const maxDuration = 60;

const TITLE_MAX = 200;
/** A Publish that began starting an upload job this long ago and never finished was left by a request that died. */
const UPLOAD_STARTING_STALE_MS = 3 * 60_000;

/**
 * Starts a glimmer-publish job for the adapter of job `jobId` through POST /api/train/jobs itself, so it gets every
 * check a GPU job gets there (the sweep, the GPU and daily caps, the adapter on the model cache, a GPU in its region)
 * and its replies. The admin's session is the same request's; automation's bearer secret is passed on.
 */
function startUploadJob(req: Request, jobId: string, title: string): Promise<Response> {
  const auth = req.headers.get("authorization");
  return startJob(
    new Request(new URL("/api/train/jobs", req.url), {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify({
        recipe: PUBLISH_RECIPE,
        title: `Publish to Hugging Face: ${title}`.slice(0, TITLE_MAX),
        params: { adapterJobId: jobId },
      }),
    }),
  );
}

function reply(job: TrainJobRow, hub: HubState | null | undefined, extra: Partial<HubPublishResponse> = {}, status = 200): Response {
  const body: HubPublishResponse = { hub: hub ? toHubView(hub, job.params) : null, offReason: env.hubOffReason, ...extra };
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/** True while another Publish is starting an upload job for this one (HubState.uploadStartingAt, not yet stale). */
function uploadStarting(hub: HubState | null | undefined, now: number): boolean {
  const at = Date.parse(hub?.uploadStartingAt ?? "");
  return Number.isFinite(at) && now - at < UPLOAD_STARTING_STALE_MS;
}

/**
 * Makes the model repo (private), or finds it, before a paid upload job starts: a token that can't write repos under
 * HF_NAMESPACE is refused here, not after a GPU booted. The plan route makes it again, which is fine. Null when the Hub
 * took it, else the reply.
 */
async function hubPreflight(job: TrainJobRow): Promise<Response | null> {
  const datasetId = typeof job.params?.datasetId === "string" ? job.params.datasetId : "";
  const dataset = datasetId ? await getDataset(datasetId) : null;
  if (!dataset) return errorJson(409, "not_publishable", { reason: "Its dataset is gone, so its card can't say what it learned." });
  const id = job.hub?.modelRepo || `${env.hfNamespace}/${modelRepoName(dataset.title, job.id)}`;
  if (!validRepoName(id.split("/")[1] ?? "")) return errorJson(409, "not_publishable", { reason: "The model repo's name isn't one the Hub takes." });
  try {
    await createRepo({ type: "model", id }, { license: "apache-2.0" });
    return null;
  } catch (err) {
    if (!(err instanceof HubApiError)) throw err;
    const text = redact(err.message).replace(/\s+/g, " ").trim().slice(0, 500);
    console.error("[train/publish] preflight", text);
    if (err.status === 0 || err.status === 429 || err.status >= 500 || err.code === "conflict") {
      return errorJson(503, "hub_unavailable", { reason: text });
    }
    const check = err.status === 401 || err.status === 403 ? " Check that HF_TOKEN can write repos under HF_NAMESPACE." : "";
    return errorJson(409, "hub_refused", { reason: `${text}${check}` });
  }
}

/**
 * Publish for a local files job (docs/TRAINING.md "Local files"): its GGUF repo, with the publishToHub workflow, once
 * it can (ggufJobProblem: it succeeded, its files passed and reached the Hub, its adapter is published). Its files were
 * only on its GPU, so a plan whose files aren't all on the Hub can't be finished: Make local files again.
 */
async function publishGguf(job: TrainJobRow): Promise<Response> {
  const own = await getAdapterSource(job.id);
  const adapterJobId = typeof job.params?.adapterJobId === "string" ? job.params.adapterJobId : "";
  const adapter = adapterJobId ? await getJob(adapterJobId) : null;
  const problem = ggufJobProblem(job, own?.metrics ?? null, adapter);
  if (problem) return errorJson(409, "not_publishable", { reason: problem });
  const off = env.hubOffReason;
  if (off) return errorJson(503, "hub_off", { reason: off });
  if (hubBusy(job.hub, Date.now())) return errorJson(409, "publishing");
  if (!ggufUploaded(job.hub, job.params)) return errorJson(409, "not_publishable", { reason: GGUF_NOT_UPLOADED });
  try {
    await start(publishToHub, [{ jobId: job.id }]);
  } catch (err) {
    console.error("[train/publish] start", err);
    return errorJson(500, "start_failed");
  }
  await recordEvent(job.id, { type: "log", text: "An admin asked to publish these local files to Hugging Face." }).catch(() => undefined);
  return reply(job, job.hub, { started: "publish" }, 202);
}

/** GET -> {hub: HubView | null, offReason}: where the job's publishing to Hugging Face stands. Admins or automation only. */
export const GET = route(async (req: Request, { params }: Ctx) => {
  await requireAdminOrAutomation(req);
  const { id } = await params;
  const job = await getJob(id);
  if (!job) return errorJson(404, "not_found");
  return reply(job, job.hub);
});

/**
 * POST {why?} -> 202 {hub, offReason, started, publishJobId?}. Admins or automation only (docs/TRAINING.md "Hugging Face
 * Hub"). Publishes a judged glimmer-lora job now. `why` (at most 2,000 characters, em dashes taken out) is the why the
 * card leads with: when it differs from the one the card would print now (the one saved with Publish, else the job's
 * "why" param), it is saved and the story is written again around it; "" clears it, the param's too. When every file
 * of its adapter is on the Hub, the publishToHub workflow commits the cards and repos ("publish"); otherwise the model
 * repo is made (or found) on the Hub first, so a token that can't write there costs no GPU, and a glimmer-publish job
 * is started through POST /api/train/jobs to upload the files from the model cache in the adapter's region ("upload",
 * with its id), and its workflow publishes once it succeeds. Two presses at once start one upload job. A job published
 * before is published again, which writes only what changed (a new why, say).
 *
 * A glimmer-quantize job publishes its GGUF repo instead (publishGguf), with no why and no upload job.
 *
 * 400 bad input, 404 unknown job, 409 not_publishable with {reason} (not a judged glimmer-lora job, a dry run, its
 * dataset gone), 409 publishing (a run is publishing it now), 409 upload_running with {publishJobId} (or without, while
 * another press starts one), 409 hub_refused or 503 hub_unavailable with {reason} (the Hub refused or didn't answer
 * the model repo), 503 hub_off with {reason} (HF_TOKEN or HF_NAMESPACE isn't set), 500 start_failed, and any refusal
 * of POST /api/train/jobs as it is.
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  await requireAdminOrAutomation(req);
  const { id } = await params;
  const body = await readJson(req, 16 * 1024);
  if (body.why !== undefined && body.why !== null && typeof body.why !== "string") return errorJson(400, "why must be text.");
  const why = typeof body.why === "string" ? noEmDashes(body.why).trim() : null;
  if (why !== null && why.length > HUB_WHY_MAX) {
    return errorJson(400, `Keep the why to ${HUB_WHY_MAX.toLocaleString("en-US")} characters.`, { max: HUB_WHY_MAX });
  }

  const job = await getJob(id);
  if (!job) return errorJson(404, "not_found");
  if (job.recipe === QUANT_RECIPE) return publishGguf(job);
  const problem = hubJobProblem(job);
  if (problem) return errorJson(409, "not_publishable", { reason: problem });
  const off = env.hubOffReason;
  if (off) return errorJson(503, "hub_off", { reason: off });
  if (hubBusy(job.hub, Date.now())) return errorJson(409, "publishing");

  let hub = job.hub;
  if (why !== null && (effectiveWhy(hub, job.params) ?? "") !== why) {
    // Saved as written ("" when cleared, which wins over the param), and the story is written again around it.
    const at = new Date().toISOString();
    hub = (await updateHub(id, (h) => ({ ...(h ?? { status: "waiting" }), why, story: null, storyBy: null, updatedAt: at }))) ?? hub;
  }

  if (hubUploaded(hub)) {
    try {
      await start(publishToHub, [{ jobId: id }]);
    } catch (err) {
      console.error("[train/publish] start", err);
      return errorJson(500, "start_failed");
    }
    await recordEvent(id, { type: "log", text: "An admin asked to publish this job to Hugging Face." }).catch(() => undefined);
    return reply(job, hub, { started: "publish" }, 202);
  }

  const seen = hub?.publishJobId ?? null;
  const upload = seen ? await getJob(seen) : null;
  if (upload && !isTrainTerminal(upload.status)) return errorJson(409, "upload_running", { publishJobId: upload.id });
  const refused = await hubPreflight(job);
  if (refused) return refused;

  // The claim: only the press that still sees the same upload job, and no other press starting one, goes on.
  const startedAt = new Date();
  const mark = startedAt.toISOString();
  const claimed = await updateHub(id, (h) =>
    (h?.publishJobId ?? null) !== seen || uploadStarting(h, startedAt.getTime()) ? null : { ...(h ?? { status: "waiting" }), uploadStartingAt: mark },
  );
  if (!claimed) return errorJson(409, "upload_running");
  const release = () =>
    updateHub(id, (h) => (h?.uploadStartingAt === mark ? { ...h, uploadStartingAt: null } : null)).catch((err) =>
      console.error("[train/publish] release", err instanceof Error ? err.message : err),
    );

  let res: Response;
  try {
    res = await startUploadJob(req, id, job.title);
  } catch (err) {
    await release();
    throw err;
  }
  if (res.status !== 201) {
    await release();
    return res;
  }
  const created = (await res.json().catch(() => null)) as { job?: { id?: unknown; title?: unknown } } | null;
  const publishJobId = typeof created?.job?.id === "string" ? created.job.id : null;
  if (!publishJobId) {
    await release();
    return errorJson(500, "start_failed");
  }
  const at = new Date().toISOString();
  const reason = `Uploading the adapter's files from the model cache with job "${String(created?.job?.title ?? PUBLISH_RECIPE)}". It publishes once that job succeeds.`;
  hub =
    (await updateHub(id, (h) => ({ ...(h ?? {}), status: "waiting", reason, publishJobId, uploadStartingAt: null, updatedAt: at }))) ?? hub;
  await recordEvent(id, { type: "log", text: reason }).catch(() => undefined);
  return reply(job, hub, { started: "upload", publishJobId }, 202);
});
