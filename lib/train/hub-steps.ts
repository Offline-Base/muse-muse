/**
 * Publishing a judged glimmer-lora job to the Hugging Face Hub (docs/TRAINING.md "Hugging Face Hub"): the "use step"
 * functions lib/train/workflow.ts runs once the job is judged, or once the glimmer-publish job that uploaded its
 * adapter succeeded, or when an admin presses Publish.
 *
 *   hubPlanStep     which job to publish, and its claim: hub state "publishing" with a random claim id, taken once
 *                   (lib/train/store.ts updateHub). Off, not eligible or not uploaded yet: the state says why and
 *                   nothing is published. Every later step gets the claim, and stops (FatalError) without writing
 *                   once the state no longer holds it, so a run whose stale claim another run took changes nothing.
 *   hubStoryStep    "Why this exists": Muse Spark 1.3 writes it from the records (usage recorded, the spend cap
 *                   respected), or the template does; saved, so a retry never pays twice for one story.
 *   hubDatasetStep  the dataset repo (one per dataset, made private if it is new): the train and eval JSONL, which are
 *                   the dataset's and the same for every job trained on it.
 *   hubModelStep    the model repo the plan made: the adapter's LFS objects checked with the LFS batch (one the Hub
 *                   doesn't store fails publishing, so Publish uploads it again), then one commit of those objects by
 *                   oid, the small files (each checked config read again, adapter_config.json normalized), the model
 *                   card, the base model's LICENSE and muse_muse_run.json.
 *   hubFinishStep   the dataset card and both repos' visibility (see there), then the state "published", with the
 *                   visibility the Hub reports.
 *   hubFailStep     the state "failed" with a plain reason, when a step ran out of retries and the run still holds its
 *                   claim.
 *
 * Each commit writes only the files that differ from what the repo has, then reads the repo back and checks every
 * path, size and LFS oid, so a step that runs again does nothing twice. HF_TOKEN is read inside lib/train/hub.ts on
 * each call: it is never an argument or a result here (step data is persisted; the claim id isn't a secret), and every
 * error is redacted before it is saved or logged. Nothing here changes a job's status.
 */
import { randomUUID } from "node:crypto";
import { FatalError, RetryableError } from "workflow";
import { env } from "@/lib/env";
import { metaPlatform } from "@/lib/meta/platform";
import { fromResponsesUsage } from "@/lib/meta/pricing";
import { spendPaused } from "@/lib/quota";
import {
  commit,
  createRepo,
  fetchPublicText,
  gitOid,
  HubApiError,
  lfsBatch,
  listFiles,
  preupload,
  rawUrl,
  redact,
  repoUrl,
  repoVisibility,
  setVisibility,
  sha256Hex,
  uploadLfs,
  verifyFiles,
  type ExpectedFile,
  type HubRepo,
  type HubVisibility,
} from "@/lib/train/hub";
import {
  cleanStory,
  configProblem,
  datasetCard,
  datasetLicense,
  datasetRepoName,
  datasetSystem,
  DATASET_EVAL_PATH,
  DATASET_LICENSE_PATH,
  DATASET_TRAIN_PATH,
  dropRepeatedWhy,
  evalJsonl,
  GLIMMER_ORIGIN,
  glimmerTemplate,
  hubFileProblem,
  hubJobProblem,
  hubUploaded,
  modelCard,
  modelRepoName,
  normalizedAdapterConfig,
  pickExample,
  publishOff,
  runItems,
  runRecord,
  STORY_INSTRUCTIONS,
  STORY_MODEL,
  storyProblem,
  storyRequest,
  studentSystem,
  templateStory,
  trainJsonl,
  validRepoName,
  type CardFacts,
  type DatasetModel,
  type StoryFacts,
} from "@/lib/train/hub-cards";
import { ADAPTER_RECIPE, effectiveWhy, hubBusy, type TrainJobRow } from "@/lib/train/logic";
import { recipeById } from "@/lib/train/recipes";
import { GLIMMER_PY } from "@/lib/train/recipes/glimmer";
import {
  datasetPage,
  getAdapterSource,
  getDataset,
  getJob,
  listResultEvents,
  publishedHubModels,
  recordEvent,
  updateHub,
} from "@/lib/train/store";
import {
  HUB_CHECKED_NAMES,
  HUB_SAMPLE_BYTES,
  PUBLISH_RECIPE,
  type EvalExample,
  type HubState,
  type TrainExample,
  type TrainStatus,
} from "@/lib/train/types";
import type { ModelUsage } from "@/lib/types";
import { recordUsage } from "@/lib/usage";

const DB_RETRY_AFTER = "30s";
/** How long a step waits before trying the Hub again after it stayed down through the client's own retries. */
const HUB_RETRY_AFTER = "1m";
/** The most examples a dataset holds (DATASET_MAX_COUNT) and holds out, read in one page each. */
const TRAIN_READ_MAX = 1000;
const EVAL_READ_MAX = 100;
/**
 * The story's call: effort low, one SDK retry. Its reasoning counts toward the output budget: at effort low Muse Spark
 * 1.3 reasoned for about 1,500 tokens before writing about 200 (a real call on 2026-10-28), so a budget of 1,500 came
 * back "incomplete" with no text at all. Only the tokens it uses are paid for.
 */
const STORY_MAX_OUTPUT_TOKENS = 6000;
const STORY_TIMEOUT_MS = 90_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The waiting reason of a judged job whose adapter files aren't all on the Hub. */
export const NOT_UPLOADED =
  "The adapter's files aren't on Hugging Face yet. Publish uploads them from the model cache with a short GPU job, then publishes.";

/** Why a step stops when its run no longer holds the publishing claim. */
const LOST_CLAIM = "Another run took over publishing this job, so this one stopped without writing.";

/** What hubPlanStep decided: publish this job (its claim is taken, with this id), or nothing. */
export type HubPlan = { action: "publish"; jobId: string; claim: string } | { action: "none" };

const NONE: HubPlan = { action: "none" };

// ---------------------------------------------------------------------------------------------------------------
// Helpers (not steps)

function message(err: unknown): string {
  return redact(err instanceof Error ? err.message : String(err));
}

/** A database call whose failure is retried after 30 s rather than 1 s. */
async function fromDb<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw new RetryableError(`The database did not answer: ${message(err)}`, { retryAfter: DB_RETRY_AFTER });
  }
}

/**
 * A Hub call, with its failure sorted: the Hub down or rate limiting (after the client's own retries) is tried again
 * in a minute; a refusal (a bad token, a name the Hub won't take, a commit it rejects) is fatal, with what to check.
 */
async function fromHub<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof FatalError || err instanceof RetryableError) throw err;
    const status = err instanceof HubApiError ? err.status : 0;
    if (status === 0 || status === 429 || status >= 500) throw new RetryableError(message(err), { retryAfter: HUB_RETRY_AFTER });
    if (status === 401 || status === 403) {
      throw new FatalError(`${message(err)} Check that HF_TOKEN can write repos under HF_NAMESPACE.`);
    }
    throw new FatalError(message(err));
  }
}

/** True while the state is "publishing" under this run's claim. */
const holds = (hub: HubState | null | undefined, claim: string) => hub?.status === "publishing" && hub.claim === claim;

type DatasetRow = NonNullable<Awaited<ReturnType<typeof getDataset>>>;

/** The job, its hub state and its dataset, or a FatalError that says what is missing or that the claim was lost. */
async function load(jobId: string, claim: string): Promise<{ job: TrainJobRow; hub: HubState; dataset: DatasetRow }> {
  const job = await fromDb(() => getJob(jobId));
  if (!job) throw new FatalError("The job is gone.");
  if (!job.hub) throw new FatalError("The job has no Hugging Face state to publish from.");
  if (!holds(job.hub, claim)) throw new FatalError(LOST_CLAIM);
  const datasetId = typeof job.params?.datasetId === "string" ? job.params.datasetId : null;
  const dataset = datasetId ? await fromDb(() => getDataset(datasetId)) : null;
  if (!dataset || dataset.status !== "ready") throw new FatalError("The job's dataset is gone or not ready, so its data can't be published.");
  return { job, hub: job.hub, dataset };
}

/** The namespace the repos go under, checked as the Hub checks a name. */
function namespace(): string {
  const ns = env.hfNamespace;
  if (!ns || !validRepoName(ns)) throw new FatalError("HF_NAMESPACE isn't set to a Hugging Face user or organization name.");
  return ns;
}

/** The model repo: the one the GPU's plan made, else the name it would have. */
function modelRepoOf(job: TrainJobRow, hub: HubState, datasetTitle: string): HubRepo {
  return { type: "model", id: hub.modelRepo || `${namespace()}/${modelRepoName(datasetTitle, job.id)}` };
}

function datasetRepoOf(hub: HubState, dataset: { id: string; title: string }): HubRepo {
  return { type: "dataset", id: hub.datasetRepo || `${namespace()}/${datasetRepoName(dataset.title, dataset.id)}` };
}

/** The story's facts, from the records: the dataset's title and task, and the admin's why. */
function storyFactsOf(job: TrainJobRow, hub: HubState, dataset: { title: string; task: string }): StoryFacts {
  return { datasetTitle: dataset.title, task: dataset.task, why: effectiveWhy(hub, job.params) };
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

/** The adapter's config, from the small files the GPU sent: its JSON, or null. */
function adapterConfig(hub: HubState): Record<string, unknown> | null {
  const b64 = hub.small?.["adapter_config.json"];
  if (typeof b64 !== "string") return null;
  try {
    const parsed = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Everything the cards say, from the records: the job and its done metrics, the eval summary and items, the dataset,
 * the recipe's template, the base revision adapter_config.json pins (else the recipe's), and the system message the
 * run trained and answered under.
 */
async function cardFactsOf(job: TrainJobRow, hub: HubState, dataset: DatasetRow) {
  const template = glimmerTemplate(GLIMMER_PY);
  const source = await fromDb(() => getAdapterSource(job.id));
  const metrics = source?.metrics ?? {};
  const events = await fromDb(() => listResultEvents(job.id));
  const items = runItems(events);
  const first = await fromDb(() => datasetPage(dataset.id, "train", 0, 1));
  const shared = datasetSystem((first?.items ?? []) as TrainExample[], dataset.task);
  // The run's own student_prompt metric, else the param as glimmer.py's read_params takes it (trimmed, lowercased,
  // "short" when blank). A job with neither predates the param, when glimmer.py always trained and answered under the
  // dataset's own system message, as "full" does now.
  const asRun = typeof metrics.student_prompt === "string" ? metrics.student_prompt : job.params?.studentPrompt;
  const studentPrompt = asRun === undefined || asRun === null ? "full" : String(asRun).trim().toLowerCase() || "short";
  // The run's student_system metric is the message itself only for the short prompt. With "full" it only describes the
  // dataset's own ("the dataset's own (1234 characters)"), and the run answered under that shared message.
  const ran = typeof metrics.student_system === "string" ? metrics.student_system.trim() : "";
  const system = studentPrompt === "full" ? shared : ran.startsWith("You are ") ? ran : studentSystem(dataset.title, shared);
  const config = adapterConfig(hub);
  const revision = typeof config?.revision === "string" && /^[0-9a-f]{40}$/.test(config.revision) ? config.revision : template.revision;
  const recipe = recipeById(job.recipe);
  const start = (job.launchedAt ?? job.createdAt).getTime();
  const end = (job.terminatedAt ?? job.finishedAt ?? job.createdAt).getTime();
  const modelRepo = modelRepoOf(job, hub, dataset.title);
  const datasetRepo = datasetRepoOf(hub, dataset);
  const facts: CardFacts = {
    modelRepo: modelRepo.id,
    datasetRepo: datasetRepo.id,
    job: {
      id: job.id,
      title: job.title,
      instanceType: job.instanceType,
      gpuLabel: recipe?.gpus.find((g) => g.instanceType === job.instanceType)?.label ?? job.instanceType,
      gpuMinutes: Math.max(0, Math.ceil((end - start) / 60_000)),
      costUsd: job.costUsd,
      finishedAt: job.finishedAt ? job.finishedAt.toISOString() : null,
      maxSteps: num(job.params?.maxSteps),
      learningRate: num(job.params?.learningRate),
      loraRank: num(job.params?.loraRank),
      studentPrompt,
    },
    metrics,
    summary: job.evalSummary!,
    example: pickExample(items),
    dataset: {
      id: dataset.id,
      title: dataset.title,
      task: dataset.task,
      trainCount: dataset.trainCount,
      evalCount: dataset.evalCount,
      costUsd: dataset.costUsd,
    },
    template,
    revision,
    system,
    why: effectiveWhy(hub, job.params),
    story: hub.story ?? templateStory(storyFactsOf(job, hub, dataset)),
  };
  return { facts, items, modelRepo, datasetRepo };
}

/** A file the platform writes into a repo itself. */
interface PlatformFile {
  path: string;
  content: Buffer;
}

/**
 * Commits `files` (the platform's own) and `lfsRefs` (objects already in the repo's LFS storage) to main, leaving out
 * what main already has, then reads the repo back and checks every path, size and oid. A file the Hub's preupload
 * marks "lfs" goes up through the LFS bridge first, from the platform; a file .gitignore ignores is left out. Returns
 * the new commit's oid, or null when main already had everything.
 */
async function writeFiles(
  repo: HubRepo,
  files: PlatformFile[],
  lfsRefs: Array<{ path: string; oid: string; size: number }>,
  summary: string,
  description: string,
): Promise<string | null> {
  const tree = new Map((await fromHub(() => listFiles(repo))).map((f) => [f.path, f]));
  const changed = files.filter((f) => {
    const have = tree.get(f.path);
    return !have || have.size !== f.content.length || (have.lfsOid ? have.lfsOid !== sha256Hex(f.content) : have.oid !== gitOid(f.content));
  });
  const refs = lfsRefs.filter((r) => tree.get(r.path)?.lfsOid !== r.oid);
  const modes = await fromHub(() =>
    preupload(
      repo,
      changed.map((f) => ({ path: f.path, size: f.content.length, sample: f.content.subarray(0, HUB_SAMPLE_BYTES).toString("base64") })),
    ),
  );
  const mode = new Map(modes.map((m) => [m.path, m]));
  const ignored = new Set(modes.filter((m) => m.shouldIgnore).map((m) => m.path));
  const regular = changed.filter((f) => !ignored.has(f.path) && mode.get(f.path)?.uploadMode === "regular");
  const asLfs = changed.filter((f) => !ignored.has(f.path) && mode.get(f.path)?.uploadMode !== "regular");
  if (asLfs.length) {
    const actions = await fromHub(() => lfsBatch(repo, asLfs.map((f) => ({ oid: sha256Hex(f.content), size: f.content.length }))));
    for (const [i, f] of asLfs.entries()) await fromHub(() => uploadLfs(actions[i]!, f.content));
  }
  let commitOid: string | null = null;
  if (regular.length || asLfs.length || refs.length) {
    const done = await fromHub(() =>
      commit(repo, {
        summary,
        description,
        files: regular,
        lfsFiles: [...asLfs.map((f) => ({ path: f.path, oid: sha256Hex(f.content), size: f.content.length })), ...refs],
      }),
    );
    commitOid = done.commitOid;
  }
  const lfsPaths = new Set([...asLfs.map((f) => f.path)]);
  const expected: ExpectedFile[] = [
    ...files
      .filter((f) => !ignored.has(f.path))
      .map((f) => {
        const lfs = lfsPaths.has(f.path) || Boolean(tree.get(f.path)?.lfsOid && !changed.includes(f));
        return lfs ? { path: f.path, size: f.content.length, lfsOid: sha256Hex(f.content) } : { path: f.path, size: f.content.length, gitOid: gitOid(f.content) };
      }),
    ...lfsRefs.map((r) => ({ path: r.path, size: r.size, lfsOid: r.oid })),
  ];
  const problems = await fromHub(() => verifyFiles(repo, expected));
  if (problems.length) {
    throw new RetryableError(`Reading ${repo.id} back after the commit found: ${problems.slice(0, 3).join(" ")}`, { retryAfter: HUB_RETRY_AFTER });
  }
  return commitOid;
}

/**
 * Saves a change of the hub state, from the state as it is now, while this run holds its claim. A FatalError when it
 * no longer does (another run took the claim, or it was cleared), so a stale run never undoes a newer one's state.
 */
async function saveHub(jobId: string, claim: string, change: (hub: HubState) => HubState): Promise<HubState> {
  let seen: HubState | null | undefined;
  const written = await fromDb(() =>
    updateHub(jobId, (hub) => {
      seen = hub;
      return holds(hub, claim) ? change(hub!) : null;
    }),
  );
  if (written) return written;
  if (seen === undefined) throw new FatalError("The job is gone.");
  if (!holds(seen, claim)) throw new FatalError(LOST_CLAIM);
  throw new RetryableError("The job's Hugging Face state couldn't be saved: other writers kept changing it.", { retryAfter: DB_RETRY_AFTER });
}

/**
 * Takes the publishing claim on a job: the hub state turns "publishing" with a new claim id when publishing is on, the
 * job can be published (hubJobProblem), every file of its plan is on the Hub, and no other run holds a fresh claim.
 * Otherwise the state says why it waits (off, not uploaded yet), and an upload that failed keeps its reason. The claim
 * id when this run holds it, else null.
 */
async function claim(jobId: string, now: Date): Promise<string | null> {
  const off = env.hubOffReason;
  const at = now.toISOString();
  const id = randomUUID();
  const written = await fromDb(() =>
    updateHub(jobId, (hub, job) => {
      if (off) {
        const reason = `Publishing to Hugging Face is off here: ${off}.`;
        return hub?.status === "off" && hub.reason === reason ? null : { ...(hub ?? {}), status: "off", reason, updatedAt: at };
      }
      if (hubJobProblem(job) || hubBusy(hub, now.getTime())) return null;
      if (!hubUploaded(hub)) {
        // A failed upload keeps its reason, and an upload a glimmer-publish job is doing is left to it.
        if (hub?.status === "failed" || (hub?.publishJobId && (hub.status === "waiting" || hub.status === "uploading"))) return null;
        return hub?.status === "waiting" && hub.reason === NOT_UPLOADED ? null : { ...(hub ?? {}), status: "waiting", reason: NOT_UPLOADED, updatedAt: at };
      }
      return { ...hub!, status: "publishing", reason: null, claim: id, updatedAt: at };
    }),
  );
  return holds(written, id) ? id : null;
}

/** The dataset card as `from` (a published job, or the one publishing now) tells it, committed where it differs. */
async function writeDatasetCard(repo: HubRepo, dataset: DatasetRow, from: { job: TrainJobRow; hub: HubState }, others: DatasetModel[], forJob: string) {
  const { facts } = await cardFactsOf(from.job, from.hub, dataset);
  const readme = Buffer.from(datasetCard(facts, others), "utf8");
  const files = [
    { path: "README.md", content: readme },
    { path: DATASET_LICENSE_PATH, content: Buffer.from(datasetLicense(), "utf8") },
  ];
  return writeFiles(repo, files, [], `Publish the card of ${dataset.title}`, `Muse Muse dataset ${dataset.id}, for job ${forJob}.`);
}

// ---------------------------------------------------------------------------------------------------------------
// Steps

/**
 * What to publish once a job has ended with `status`, and its claim. A glimmer-lora job that succeeded publishes itself
 * when it can (hubJobProblem: judged, not a dry run), unless its "publish" param is 0 and nobody pressed Publish
 * (`manual`). A glimmer-publish job that succeeded publishes the adapter job its params name; one that didn't marks that
 * job's upload failed, when it was still waiting on this one. Every other job publishes nothing.
 */
export async function hubPlanStep(jobId: string, status: TrainStatus, manual = false): Promise<HubPlan> {
  "use step";
  const job = await fromDb(() => getJob(jobId));
  if (!job) return NONE;
  if (job.recipe === PUBLISH_RECIPE) {
    const adapterJobId = typeof job.params?.adapterJobId === "string" ? job.params.adapterJobId.toLowerCase() : "";
    if (!UUID_RE.test(adapterJobId)) return NONE;
    if (status !== "succeeded") {
      const reason = `The upload job "${job.title}" ended as ${status} before the adapter's files were all on Hugging Face. Publish tries again.`;
      await fromDb(() =>
        updateHub(adapterJobId, (hub) =>
          hub?.publishJobId === job.id && (hub.status === "waiting" || hub.status === "uploading")
            ? { ...hub, status: "failed", reason, updatedAt: new Date().toISOString() }
            : null,
        ),
      );
      return NONE;
    }
    const held = await claim(adapterJobId, new Date());
    return held ? { action: "publish", jobId: adapterJobId, claim: held } : NONE;
  }
  if (job.recipe !== ADAPTER_RECIPE || status !== "succeeded") return NONE;
  if (publishOff(job.params) && !manual) return NONE;
  const held = await claim(job.id, new Date());
  return held ? { action: "publish", jobId: job.id, claim: held } : NONE;
}
hubPlanStep.maxRetries = 3;

/**
 * Writes the card's "Why this exists" once: Muse Spark 1.3 from the records (the dataset's title and task, what Muse
 * Muse is, and why an open model you run yourself should learn what Spark does), building on the admin's why when
 * there is one. It is asked for no counts or results: the card adds those itself (resultText). Usage is recorded before
 * the story is saved. When MODEL_API_KEY isn't set, the spend cap is reached, the call fails or the story fails its
 * checks (storyProblem: too long, markup, a claim about Meta, a number, a count word or a result of its own), the
 * template's story from the task is used. A copy of the admin's why in Spark's story is taken out first
 * (dropRepeatedWhy), since the card prints the why just before it. A story already saved is kept.
 */
export async function hubStoryStep(jobId: string, claim: string): Promise<{ by: "spark" | "template" }> {
  "use step";
  const { job, hub, dataset } = await load(jobId, claim);
  if (hub.story && hub.storyBy) return { by: hub.storyBy };
  const facts = storyFactsOf(job, hub, dataset);
  let story: string | null = null;
  let note: string;
  let costUsd = 0;
  if (!process.env.MODEL_API_KEY) note = "MODEL_API_KEY isn't set";
  else if (await fromDb(() => spendPaused())) note = "the platform's daily spend cap is reached";
  else {
    let usage: ModelUsage[] = [];
    let text = "";
    let failed = "the call failed";
    try {
      const res = await metaPlatform().responses.create(
        { model: STORY_MODEL, instructions: STORY_INSTRUCTIONS, input: storyRequest(facts), reasoning: { effort: "low" }, max_output_tokens: STORY_MAX_OUTPUT_TOKENS },
        { timeout: STORY_TIMEOUT_MS, maxRetries: 1 },
      );
      usage = [fromResponsesUsage(STORY_MODEL, res.usage)];
      if (res.status === "incomplete") failed = `the call stopped early (${res.incomplete_details?.reason ?? "incomplete"})`;
      else text = res.output_text ?? "";
    } catch (err) {
      console.error("[train/hub] story", message(err));
    }
    if (usage.length) {
      await fromDb(() => recordUsage({ source: "platform", endpoint: "responses" }, usage));
      costUsd = Math.round(usage.reduce((s, u) => s + (u.costUsd || 0), 0) * 1e6) / 1e6;
    }
    // The card prints the admin's why just before the story, so a copy of it in the story is taken out.
    const told = text ? dropRepeatedWhy(cleanStory(text), facts.why) : "";
    const problem = !text ? failed : !told ? "it only repeated the admin's why" : storyProblem(told, facts);
    if (problem) note = `Muse Spark 1.3's story wasn't used: ${problem}`;
    else {
      story = told;
      note = "Muse Spark 1.3 wrote the story";
    }
  }
  const by = story ? "spark" : "template";
  await saveHub(jobId, claim, (h) => ({ ...h, story: story ?? templateStory(facts), storyBy: by, storyCostUsd: costUsd, updatedAt: new Date().toISOString() }));
  await fromDb(() => recordEvent(jobId, { type: "log", text: `Hugging Face card: ${by === "spark" ? note : `the template's story, since ${note.replace(/^Muse Spark 1\.3's story wasn't used: /, "")}`}.` }));
  return { by };
}
hubStoryStep.maxRetries = 3;

/**
 * The dataset repo, one per dataset and shared by every job trained on it: made private if it isn't there, then the
 * train and eval JSONL (data/train.jsonl, data/eval.jsonl, in the messages format the job trained on), committed where
 * they differ and read back. They are the dataset's own, the same for every job, so committing them to a repo another
 * job made public shows nothing new. Its card, which tells a job's story, waits for hubFinishStep. Returns the repo
 * and the commit (null when it had them all).
 */
export async function hubDatasetStep(jobId: string, claim: string): Promise<{ repo: string; commit: string | null }> {
  "use step";
  const { job, hub, dataset } = await load(jobId, claim);
  const datasetRepo = datasetRepoOf(hub, dataset);
  const [train, held] = await Promise.all([
    fromDb(() => datasetPage(dataset.id, "train", 0, TRAIN_READ_MAX)),
    fromDb(() => datasetPage(dataset.id, "eval", 0, EVAL_READ_MAX)),
  ]);
  const trainItems = (train?.items ?? []) as TrainExample[];
  const evalItems = (held?.items ?? []) as EvalExample[];
  if (!trainItems.length || !evalItems.length) throw new FatalError("The job's dataset has no examples to publish.");
  const files: PlatformFile[] = [
    { path: DATASET_TRAIN_PATH, content: Buffer.from(trainJsonl(trainItems), "utf8") },
    { path: DATASET_EVAL_PATH, content: Buffer.from(evalJsonl(evalItems, datasetSystem(trainItems, dataset.task)), "utf8") },
  ];
  await fromHub(() => createRepo(datasetRepo, { license: "apache-2.0" }));
  const commitOid = await writeFiles(datasetRepo, files, [], `Publish ${dataset.title}`, `Muse Muse dataset ${dataset.id}, for job ${job.id}.`);
  await saveHub(jobId, claim, (h) => ({ ...h, datasetRepo: datasetRepo.id, ...(commitOid ? { datasetCommit: commitOid } : {}), updatedAt: new Date().toISOString() }));
  return { repo: datasetRepo.id, commit: commitOid };
}
hubDatasetStep.maxRetries = 3;

/**
 * The model repo. A repo that is public although this job was never published (made public by hand, or left so by a
 * run that failed), or while HF_PUBLIC asks for private repos, is made private first, so nothing unverified or unwanted
 * shows. Every LFS object of the GPU's plan is asked of
 * the LFS batch again: the Hub answers no upload for one it stores, so one it answers an upload for isn't there, comes
 * off the uploaded list and fails publishing ("Publish uploads it again"). Then one commit, where it differs, read
 * back: those objects by oid, the adapter's small files (each checked config read again with configProblem, and
 * adapter_config.json as a normalized copy with the base model and the revision the card states), the model card, the
 * base model's LICENSE (fetched from <HF_ENDPOINT>/meta-models/Muse-Glimmer-30B/raw/main/LICENSE) and
 * muse_muse_run.json. A name the platform doesn't publish (HUB_FILE_NAMES) is never committed.
 */
export async function hubModelStep(jobId: string, claim: string): Promise<{ repo: string; commit: string | null }> {
  "use step";
  const { job, hub, dataset } = await load(jobId, claim);
  if (!hubUploaded(hub)) throw new FatalError("Not every one of the adapter's files is on Hugging Face.");
  const { facts, items, modelRepo } = await cardFactsOf(job, hub, dataset);
  await fromHub(() => createRepo(modelRepo, { license: "apache-2.0" }));
  // Only a job published before, publishing again with HF_PUBLIC on, commits to a public repo.
  if ((!hub.publishedAt || !env.hfPublic) && (await fromHub(() => repoVisibility(modelRepo))) === "public") {
    await fromHub(() => setVisibility(modelRepo, "private"));
    const why = hub.publishedAt ? "HF_PUBLIC asks for private repos here" : "this job was never published";
    await fromDb(() => recordEvent(jobId, { type: "log", text: `Hugging Face: ${modelRepo.id} was public, and ${why}, so it was made private before the commit.` }));
  }
  const planned = (hub.files ?? []).filter((f) => !hubFileProblem(f.path));
  const actions = await fromHub(() => lfsBatch(modelRepo, planned.map((f) => ({ oid: f.sha256, size: f.size }))));
  const pathOf = (oid: string) => planned.find((f) => f.sha256 === oid)?.path ?? oid;
  const refused = actions.find((a) => a.kind === "error");
  if (refused?.kind === "error") throw new FatalError(`Hugging Face wouldn't say whether it stores ${pathOf(refused.oid)}: ${refused.error}`);
  const gone = new Set(actions.filter((a) => a.kind !== "none").map((a) => a.oid));
  if (gone.size) {
    await saveHub(jobId, claim, (h) => ({ ...h, uploaded: (h.uploaded ?? []).filter((oid) => !gone.has(oid)), updatedAt: new Date().toISOString() }));
    const names = planned.filter((f) => gone.has(f.sha256)).map((f) => f.path);
    throw new FatalError(`Hugging Face doesn't have ${names.join(", ")} in ${modelRepo.id}'s storage. Publish uploads it again.`);
  }
  const small: PlatformFile[] = [];
  for (const [path, b64] of Object.entries(hub.small ?? {})) {
    if (hubFileProblem(path)) continue;
    const bytes = Buffer.from(b64, "base64");
    const problem = HUB_CHECKED_NAMES.includes(path) ? configProblem(path, bytes, facts.template.model) : null;
    if (problem) throw new FatalError(`The adapter isn't published: ${problem}.`);
    small.push({ path, content: path === "adapter_config.json" ? normalizedAdapterConfig(bytes, facts.template.model, facts.revision) : bytes });
  }
  const license = await fromHub(() => fetchPublicText(rawUrl({ type: "model", id: GLIMMER_ORIGIN }, "LICENSE")));
  if (!/apache license/i.test(license)) throw new FatalError(`The base model's LICENSE at ${GLIMMER_ORIGIN} isn't the Apache License any more.`);
  const files: PlatformFile[] = [
    { path: "README.md", content: Buffer.from(modelCard(facts), "utf8") },
    { path: "LICENSE", content: Buffer.from(license, "utf8") },
    { path: "muse_muse_run.json", content: Buffer.from(`${JSON.stringify(runRecord(facts, items, hub.storyBy ?? "template"), null, 2)}\n`, "utf8") },
    ...small,
  ];
  const refs = planned.map((f) => ({ path: f.path, oid: f.sha256, size: f.size }));
  const commitOid = await writeFiles(modelRepo, files, refs, `Publish ${job.title}`, `Muse Muse job ${job.id}: a LoRA adapter for ${facts.template.model}.`);
  await saveHub(jobId, claim, (h) => ({ ...h, modelRepo: modelRepo.id, ...(commitOid ? { modelCommit: commitOid } : {}), updatedAt: new Date().toISOString() }));
  return { repo: modelRepo.id, commit: commitOid };
}
hubModelStep.maxRetries = 3;

/**
 * The dataset card and both repos' visibility, once the model repo's commit is verified, then the state "published"
 * with the links and `public` as the Hub reports both repos (public only when both are). The dataset card is the
 * dataset's, shared: it tells the story of the latest public model published from it and lists every one.
 *
 * - HF_PUBLIC on: the model repo public first, then the dataset card (this job's story, this model and every other
 *   public one), then the dataset repo public. A public card never names a private model, and a part that fails puts
 *   back each repo this run made public, so a failure leaves both as they were.
 * - HF_PUBLIC asking for private: this job's model repo private. With no other public model on the dataset, the
 *   dataset repo goes private too and gets this job's card; with others, it stays as it is, and its card becomes the
 *   newest of theirs first, so it never names this private model.
 */
export async function hubFinishStep(jobId: string, claim: string): Promise<{ public: boolean }> {
  "use step";
  const { job, hub, dataset } = await load(jobId, claim);
  const model = modelRepoOf(job, hub, dataset.title);
  const data = datasetRepoOf(hub, dataset);
  const open = env.hfPublic;
  const others: DatasetModel[] = (await fromDb(() => publishedHubModels(data.id, job.id))).map((m) => ({ repo: m.modelRepo, jobId: m.jobId, title: m.title }));
  const was = { model: await fromHub(() => repoVisibility(model)), data: await fromHub(() => repoVisibility(data)) };
  const changed: Array<{ repo: HubRepo; back: HubVisibility }> = [];
  const make = async (repo: HubRepo, from: HubVisibility, to: HubVisibility) => {
    if (from === to) return;
    await fromHub(() => setVisibility(repo, to));
    changed.push({ repo, back: from });
  };
  try {
    if (open) {
      await make(model, was.model, "public");
      await writeDatasetCard(data, dataset, { job, hub }, others, job.id);
      await make(data, was.data, "public");
    } else if (others.length) {
      // The card first: if making the model private then fails, the card only leaves out a model that is still public.
      const newest = await fromDb(() => getJob(others[0]!.jobId));
      if (newest?.hub) await writeDatasetCard(data, dataset, { job: newest, hub: newest.hub }, others.slice(1), job.id);
      await make(model, was.model, "private");
    } else {
      await make(model, was.model, "private");
      await make(data, was.data, "private");
      await writeDatasetCard(data, dataset, { job, hub }, [], job.id);
    }
  } catch (err) {
    for (const { repo, back } of changed.reverse()) {
      try {
        await setVisibility(repo, back);
      } catch (undo) {
        const text = `Hugging Face: making ${repo.id} ${back} again failed, so it is still ${back === "public" ? "private" : "public"}: ${message(undo)}`;
        await recordEvent(jobId, { type: "log", text }).catch(() => undefined);
      }
    }
    throw err;
  }
  const now = { model: await fromHub(() => repoVisibility(model)), data: await fromHub(() => repoVisibility(data)) };
  const isPublic = now.model === "public" && now.data === "public";
  const modelUrl = repoUrl(model);
  const datasetUrl = repoUrl(data);
  const at = new Date().toISOString();
  await saveHub(jobId, claim, (h) => ({ ...h, status: "published", reason: null, claim: null, modelUrl, datasetUrl, public: isPublic, publishedAt: at, updatedAt: at }));
  await fromDb(() =>
    recordEvent(jobId, {
      type: "log",
      text: `Published to Hugging Face${isPublic ? "" : ` (the model repo is ${now.model}, the dataset repo ${now.data})`}: ${modelUrl} and ${datasetUrl}.`,
    }),
  );
  return { public: isPublic };
}
hubFinishStep.maxRetries = 5;

/** Fails the publishing this run holds a claim on, with a plain reason (redacted), and logs it. */
export async function hubFailStep(jobId: string, claim: string, reason: string): Promise<void> {
  "use step";
  const text = `Publishing to Hugging Face failed: ${redact(reason).replace(/\s+/g, " ").trim().slice(0, 500)}`;
  const written = await fromDb(() =>
    updateHub(jobId, (hub) => (holds(hub, claim) ? { ...hub!, status: "failed", reason: text, claim: null, updatedAt: new Date().toISOString() } : null)),
  );
  if (written) await fromDb(() => recordEvent(jobId, { type: "log", text }));
}
hubFailStep.maxRetries = 20;
