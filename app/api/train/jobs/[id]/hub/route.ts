import { createHash } from "node:crypto";
import { env } from "@/lib/env";
import { hitRateLimits } from "@/lib/gateway/store";
import { errorJson, HttpError, readJson, route } from "@/lib/http";
import { licenseDuties, recordedBase } from "@/lib/train/base";
import { createRepo, HubApiError, lfsBatch, preupload, redact, type HubRepo, type LfsAction } from "@/lib/train/hub";
import {
  configProblem,
  ggufRepoName,
  ggufSmallProblem,
  hubJobProblem,
  hubMaxBytes,
  hubNameProblem,
  jobUploaded,
  modelRepoName,
  publishOff,
  studentSystem,
  validRepoName,
  validSlug,
  withDone,
  withPlan,
} from "@/lib/train/hub-cards";
import { ADAPTER_RECIPE, hubBusy, trainChannelOf, type TrainJobRow } from "@/lib/train/logic";
import { getAdapterSource, getDataset, getJob, ownerRowsProblem, recordEvent, updateHub } from "@/lib/train/store";
import {
  HUB_CHECKED_NAMES,
  HUB_FILES_MAX,
  HUB_GGUF_SMALL_NAMES,
  HUB_SAMPLE_BYTES,
  HUB_SMALL_FILE_MAX_BYTES,
  HUB_SMALL_TOTAL_MAX_BYTES,
  isTrainTerminal,
  PUBLISH_RECIPE,
  QUANT_RECIPE,
  type HubFile,
  type HubPlanFile,
  type HubUpload,
} from "@/lib/train/types";
import { requireJobToken } from "../../../shared";

type Ctx = { params: Promise<{ id: string }> };

// The plan waits on three calls to the Hub (the repo, preupload and the LFS batch).
export const maxDuration = 60;

/**
 * A plan carries the small files whole, as base64: 3 MB of them is 4 MB of text, plus each file's 512-byte sample.
 * Under Vercel's 4.5 MB request limit.
 */
const PLAN_BODY_MAX = 4_400_000;
/**
 * The plan's answer carries every part URL of every file it plans, in one body under Vercel's 4.5 MB response limit.
 * Past about this, the answer is 413 plan_too_large instead: with perFile when it planned more than one file (runner.py
 * then plans one file at a time), or for one file alone, which this route can't page.
 */
const PLAN_ANSWER_MAX = 3_500_000;
const DONE_BODY_MAX = 64 * 1024;
/** Plans and reports one job may send an hour: a run sends a plan, a fresh one per expired URL, and a report. */
const CALLS_PER_HOUR = 60;
const ERROR_MAX = 300;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** A base64 string's bytes, or null when it isn't base64. */
function base64(text: unknown): Buffer | null {
  if (typeof text !== "string" || text.length % 4 !== 0 || !BASE64_RE.test(text)) return null;
  return Buffer.from(text, "base64");
}

const sha256Of = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/**
 * The plan's files and small files, checked, or the reply that refuses it. Names the platform won't publish for the
 * job are left out (hubNameProblem: an adapter's HUB_FILE_NAMES, or a glimmer-quantize job's builds and their small
 * files), and so is a file the platform reads before it publishes it (an adapter's HUB_CHECKED_NAMES, a GGUF repo's
 * HUB_GGUF_SMALL_NAMES) that didn't come whole in small. Each file is at most its recipe's cap (hubMaxBytes). Every small
 * file must be one that files names, with its size and sha256, and there are at most HUB_FILES_MAX of each: so a plan
 * never holds more than HUB_FILES_MAX files and HUB_SMALL_TOTAL_MAX_BYTES of small ones, and the job's state, which a
 * plan replaces, never does either. `only`, when given, names the files to answer uploads for now (each one files
 * names).
 */
function parsePlan(
  body: Record<string, unknown>,
  target: TrainJobRow,
): { files: HubPlanFile[]; small: Map<string, Buffer>; only: Set<string> | null } | Response {
  if (!Array.isArray(body.files) || !body.files.length) return errorJson(400, "Send the adapter folder's files.");
  if (body.files.length > HUB_FILES_MAX) return errorJson(413, "too_many_files", { max: HUB_FILES_MAX });
  const listed = new Map<string, HubPlanFile>();
  const seen = new Set<string>();
  for (const raw of body.files) {
    const f = raw as Record<string, unknown> | null;
    const path = typeof f?.path === "string" ? f.path : "";
    if (!path || path.length > 200 || seen.has(path)) return errorJson(400, "Each file needs a name of its own.");
    seen.add(path);
    const size = f?.size;
    if (typeof size !== "number" || !Number.isInteger(size) || size < 0) return errorJson(400, `Send ${path}'s size in bytes.`);
    const max = hubMaxBytes(target, path);
    if (size > max) return errorJson(413, "too_large", { path, maxBytes: max });
    const sha256 = typeof f?.sha256 === "string" ? f.sha256.toLowerCase() : "";
    if (!SHA256_RE.test(sha256)) return errorJson(400, `Send ${path}'s SHA-256 as 64 hex characters.`);
    const sample = base64(f?.sample);
    if (!sample || sample.length > Math.min(HUB_SAMPLE_BYTES, size)) {
      return errorJson(400, `Send the base64 of ${path}'s first ${HUB_SAMPLE_BYTES} bytes as its sample.`);
    }
    // A name the platform won't publish (a folder, a pickle, a README of PEFT's) is left out, not refused.
    if (hubNameProblem(target, path)) continue;
    listed.set(path, { path, size, sha256, sample: f!.sample as string });
  }
  const small = new Map<string, Buffer>();
  const rawSmall = body.small ?? {};
  if (!rawSmall || typeof rawSmall !== "object" || Array.isArray(rawSmall)) return errorJson(400, "small must map file names to base64.");
  const entries = Object.entries(rawSmall as Record<string, unknown>);
  if (entries.length > HUB_FILES_MAX) return errorJson(413, "too_many_files", { max: HUB_FILES_MAX });
  let total = 0;
  for (const [path, value] of entries) {
    const bytes = base64(value);
    if (!bytes) return errorJson(400, `small["${path.slice(0, 100)}"] isn't base64.`);
    if (bytes.length > HUB_SMALL_FILE_MAX_BYTES) return errorJson(413, "small_too_large", { path, maxBytes: HUB_SMALL_FILE_MAX_BYTES });
    total += bytes.length;
    if (total > HUB_SMALL_TOTAL_MAX_BYTES) return errorJson(413, "small_too_large", { maxTotalBytes: HUB_SMALL_TOTAL_MAX_BYTES });
    if (hubNameProblem(target, path)) continue;
    // runner.py sends every file in files and the small ones in small too, so each is one files names, as that file.
    const file = listed.get(path);
    if (!file || file.size !== bytes.length || file.sha256 !== sha256Of(bytes)) {
      return errorJson(400, `${path.slice(0, 100)} in small isn't a file files names, as that file.`);
    }
    small.set(path, bytes);
  }
  // A file the platform reads before it publishes it, sent only as a file to upload, can't be read: it stays out.
  const checked = target.recipe === QUANT_RECIPE ? HUB_GGUF_SMALL_NAMES : HUB_CHECKED_NAMES;
  const files = [...listed.values()].filter((f) => !checked.includes(f.path) || small.has(f.path));
  let only: Set<string> | null = null;
  if (body.only !== undefined && body.only !== null) {
    if (!Array.isArray(body.only) || !body.only.length || body.only.length > HUB_FILES_MAX || body.only.some((n) => typeof n !== "string" || !seen.has(n))) {
      return errorJson(400, "only must name files the plan names.");
    }
    only = new Set(body.only as string[]);
  }
  return { files, small, only };
}

/** The report's uploaded and failed files, checked, or the reply that refuses it. */
function parseDone(body: Record<string, unknown>):
  | { uploaded: Array<{ path: string; oid: string; size: number }>; failed: Array<{ path: string; error: string }> }
  | Response {
  const uploadedRaw = body.uploaded ?? [];
  const failedRaw = body.failed ?? [];
  if (!Array.isArray(uploadedRaw) || !Array.isArray(failedRaw)) return errorJson(400, "uploaded and failed must be lists.");
  if (uploadedRaw.length > HUB_FILES_MAX || failedRaw.length > HUB_FILES_MAX) return errorJson(413, "too_many_files", { max: HUB_FILES_MAX });
  const uploaded: Array<{ path: string; oid: string; size: number }> = [];
  for (const raw of uploadedRaw) {
    const u = raw as Record<string, unknown> | null;
    const oid = typeof u?.oid === "string" ? u.oid.toLowerCase() : "";
    if (typeof u?.path !== "string" || !SHA256_RE.test(oid) || typeof u.size !== "number") {
      return errorJson(400, "Each uploaded file needs its path, oid and size.");
    }
    uploaded.push({ path: u.path, oid, size: u.size });
  }
  const failed = failedRaw.map((raw) => {
    const f = raw as Record<string, unknown> | null;
    const path = typeof f?.path === "string" ? f.path.slice(0, 200) : "a file";
    // A GPU's error could hold an upload URL: those are blanked out before it is kept.
    const error = redact(typeof f?.error === "string" ? f.error : "it didn't say why").replace(/\s+/g, " ").trim().slice(0, ERROR_MAX);
    return { path, error: error || "it didn't say why" };
  });
  return { uploaded, failed };
}

/**
 * The job a call acts for: a glimmer-lora or glimmer-quantize job's own (a glimmer-quantize job keeps its GGUF repo's
 * state on its own row), or for a glimmer-publish job the adapter job its params name (its token can act for that job
 * only). Null when the caller's recipe doesn't publish, with why.
 */
async function targetOf(caller: TrainJobRow): Promise<{ target: TrainJobRow } | { skip: string }> {
  if (caller.recipe === ADAPTER_RECIPE || caller.recipe === QUANT_RECIPE) return { target: caller };
  if (caller.recipe !== PUBLISH_RECIPE) return { skip: "This job's recipe doesn't publish to Hugging Face." };
  const adapterJobId = typeof caller.params?.adapterJobId === "string" ? caller.params.adapterJobId : "";
  const target = UUID_RE.test(adapterJobId) ? await getJob(adapterJobId) : null;
  return target ? { target } : { skip: "The adapter's job is gone." };
}

/** Why the GPU's files for `target` aren't taken now, or null when they are. */
function planProblem(caller: TrainJobRow, target: TrainJobRow): string | null {
  if (isTrainTerminal(caller.status)) return "This job already ended.";
  if (Number(target.params?.dryRun) >= 1) return "A dry run's adapter is a stand-in, so it isn't published.";
  if (caller.id === target.id) {
    if (publishOff(target.params)) return "Publish to Hugging Face is 0 for this job.";
  } else {
    const problem = hubJobProblem(target);
    if (problem) return `The adapter's job can't be published: ${problem}`;
  }
  if (hubBusy(target.hub, Date.now())) return "It is being published right now.";
  if (target.hub?.status === "published") return "It is already on Hugging Face.";
  return null;
}

/** Saves why the plan was skipped on the job publishing is for (only what changed), and answers it. */
async function skip(targetId: string | null, reason: string, status: "off" | "failed" | null = null): Promise<Response> {
  if (targetId && status) {
    const at = new Date().toISOString();
    await updateHub(targetId, (hub) =>
      hub?.status === status && hub.reason === reason ? null : { ...(hub ?? {}), status, reason, updatedAt: at },
    ).catch((err) => console.error("[train/hub] saving the skip", err instanceof Error ? err.message : err));
  }
  return Response.json({ skip: reason });
}

/**
 * The answer for a Hub call that failed, with the redacted reason, which runner.py logs. The Hub down, rate limiting or
 * busy (a timeout, a network error, a 5xx, a 429, a conflicting operation) is 502 hub_unavailable, which runner.py
 * tries again. A refusal (any other 4xx, such as a token that can't write repos under HF_NAMESPACE) is 409
 * hub_refused, not tried again, and saved on the job as "failed" so its page says why before anyone pays for a retry.
 */
async function hubFailed(targetId: string, err: HubApiError): Promise<Response> {
  const text = redact(err.message).replace(/\s+/g, " ").trim().slice(0, 500);
  console.error("[train/hub]", text);
  if (err.status === 0 || err.status === 429 || err.status >= 500 || err.code === "conflict") {
    return errorJson(502, "hub_unavailable", { message: text });
  }
  const check = err.status === 401 || err.status === 403 ? " Check that HF_TOKEN can write repos under HF_NAMESPACE." : "";
  const reason = `${text}${check}`;
  await updateHub(targetId, (hub) => ({ ...(hub ?? {}), status: "failed", reason, updatedAt: new Date().toISOString() })).catch((e) =>
    console.error("[train/hub] saving the refusal", e instanceof Error ? e.message : e),
  );
  return errorJson(409, "hub_refused", { message: reason });
}

/**
 * A glimmer-quantize job's plan, checked before any upload: at least one build; its system and params inline, and
 * tuned.jinja for an adapter trained before trainChannel; each of them the file the platform will commit
 * (ggufSmallProblem, against the system message its adapter trained under); and its repo's name. The repo id, or the
 * skip that refuses the plan (with the status to save it under, when it is the GPU's mistake).
 */
async function ggufPlan(target: TrainJobRow, parsed: { files: HubPlanFile[]; small: Map<string, Buffer> }): Promise<{ repo: string } | { skip: string; save: "failed" | null }> {
  const adapterJobId = typeof target.params?.adapterJobId === "string" ? target.params.adapterJobId : "";
  const slug = target.params?.slug;
  if (!UUID_RE.test(adapterJobId) || !validSlug(slug)) return { skip: "The job's params don't name its adapter and slug.", save: null };
  if (!parsed.files.some((f) => f.path.endsWith(".gguf"))) return { skip: "The folder has none of the job's GGUF builds.", save: null };
  const channel = trainChannelOf(target.params);
  for (const name of ["system", "params", ...(channel === 1 ? [] : ["tuned.jinja"])]) {
    if (!parsed.small.has(name)) return { skip: `${name} isn't in the plan's small files.`, save: null };
  }
  const source = await getAdapterSource(adapterJobId);
  const datasetId = typeof source?.job.params?.datasetId === "string" ? source.job.params.datasetId : "";
  const dataset = datasetId ? await getDataset(datasetId) : null;
  if (!source || !dataset) return { skip: "The adapter's job or its dataset is gone, so its files' card can't say what they learned.", save: null };
  const ran = typeof source.metrics?.student_system === "string" ? source.metrics.student_system.trim() : "";
  const role = ran.startsWith("You are ") ? ran : studentSystem(dataset.title);
  for (const [path, bytes] of parsed.small) {
    const problem = ggufSmallProblem(path, bytes, sha256Of(bytes), { role, trainChannel: channel, params: target.params });
    if (problem) return { skip: `The local files aren't published: ${problem}.`, save: "failed" };
  }
  const repo = target.hub?.modelRepo || `${env.hfNamespace!}/${ggufRepoName(slug, adapterJobId, target.params)}`;
  if (!validRepoName(repo.split("/")[1] ?? "")) return { skip: "The GGUF repo's name isn't one the Hub takes.", save: null };
  return { repo };
}

async function plan(caller: TrainJobRow, target: TrainJobRow, body: Record<string, unknown>): Promise<Response> {
  const parsed = parsePlan(body, target);
  if (parsed instanceof Response) return parsed;
  const problem = planProblem(caller, target) ?? (await ownerRowsProblem(target));
  if (problem) return skip(null, problem);
  const off = env.hubOffReason;
  if (off) return skip(target.id, `Publishing to Hugging Face is off here: ${off}.`, "off");
  // Every plan is the whole plan (runner.py sends it whole again after an expired URL), and it replaces the one before.
  let id: string;
  if (target.recipe === QUANT_RECIPE) {
    const gguf = await ggufPlan(target, parsed);
    if ("skip" in gguf) return skip(gguf.save ? target.id : null, gguf.skip, gguf.save);
    id = gguf.repo;
  } else {
    if (!parsed.files.some((f) => f.path === "adapter_model.safetensors")) return skip(null, "The folder has no adapter_model.safetensors.");
    if (!parsed.small.has("adapter_config.json")) return skip(null, "adapter_config.json isn't in the plan's small files.");
    // The base the adapter must be for: the one its job recorded (lib/train/base.ts), r30b for every job since the
    // switch, plain Glimmer for one from before it.
    const base = recordedBase(target).model;
    for (const [path, bytes] of parsed.small) {
      const problem = HUB_CHECKED_NAMES.includes(path) ? configProblem(path, bytes, base) : null;
      if (problem) return skip(target.id, `The adapter isn't published: ${problem}.`, "failed");
    }
    const datasetId = typeof target.params?.datasetId === "string" ? target.params.datasetId : "";
    const dataset = datasetId ? await getDataset(datasetId) : null;
    if (!dataset) return skip(null, "The adapter's dataset is gone, so its card can't say what it learned.");
    const namespace = env.hfNamespace!;
    id = target.hub?.modelRepo || `${namespace}/${modelRepoName(dataset.title, target.id, target.params?.baseModel)}`;
    if (!validRepoName(id.split("/")[1] ?? "")) return skip(null, "The model repo's name isn't one the Hub takes.");
  }
  const repo: HubRepo = { type: "model", id };

  let uploads: HubUpload[];
  let lfsFiles: HubFile[];
  let small: Record<string, string>;
  let present: string[];
  try {
    await createRepo(repo, licenseDuties({ params: target.params }).family === "glimmer" ? { license: "apache-2.0" } : {});
    const modes = new Map((await preupload(repo, parsed.files.map((f) => ({ path: f.path, size: f.size, sample: f.sample })))).map((m) => [m.path, m]));
    const kept = parsed.files.filter((f) => !modes.get(f.path)?.shouldIgnore);
    // A small file the Hub keeps as a regular file is committed by the platform; everything else goes through LFS.
    const inline = kept.filter((f) => parsed.small.has(f.path) && modes.get(f.path)?.uploadMode === "regular");
    lfsFiles = kept.filter((f) => !inline.includes(f)).map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 }));
    small = Object.fromEntries(inline.map((f) => [f.path, parsed.small.get(f.path)!.toString("base64")]));
    // Only the files the GPU asks about now get uploads; the plan the job keeps is still every file.
    const asked = parsed.only ? lfsFiles.filter((f) => parsed.only!.has(f.path)) : lfsFiles;
    const actions = await lfsBatch(repo, asked.map((f) => ({ oid: f.sha256, size: f.size })));
    const refused = actions.find((a): a is Extract<LfsAction, { kind: "error" }> => a.kind === "error");
    if (refused) {
      const path = asked.find((f) => f.sha256 === refused.oid)?.path ?? "a file";
      const reason = `Hugging Face refused the upload of ${path}: ${refused.error}`;
      await updateHub(target.id, (hub) => ({ ...(hub ?? {}), status: "failed", reason, updatedAt: new Date().toISOString() }));
      return errorJson(409, "hub_refused", { message: reason });
    }
    present = actions.filter((a) => a.kind === "none").map((a) => a.oid);
    uploads = actions.map((a, i): HubUpload => {
      const f = asked[i]!;
      if (a.kind === "basic") return { path: f.path, oid: f.sha256, size: f.size, transfer: "basic", href: a.href, header: a.header };
      if (a.kind === "multipart") {
        return { path: f.path, oid: f.sha256, size: f.size, transfer: "multipart", chunkSize: a.chunkSize, parts: a.parts, completionUrl: a.completionUrl };
      }
      return { path: f.path, oid: f.sha256, size: f.size, transfer: "none" };
    });
  } catch (err) {
    if (err instanceof HubApiError) return hubFailed(target.id, err);
    throw err;
  }
  // Every part URL goes back in this one answer: past PLAN_ANSWER_MAX it would pass the response limit.
  const answer = JSON.stringify({ repo: repo.id, uploads });
  if (Buffer.byteLength(answer) > PLAN_ANSWER_MAX) {
    const parts = uploads.reduce((n, u) => n + (u.transfer === "multipart" ? u.parts.length : 1), 0);
    if (uploads.length > 1) {
      return errorJson(413, "plan_too_large", {
        perFile: true,
        maxBytes: PLAN_ANSWER_MAX,
        message: `The upload plan's ${parts} upload URLs for ${uploads.length} files would pass ${PLAN_ANSWER_MAX} bytes in one answer. Plan one file at a time.`,
      });
    }
    return errorJson(413, "plan_too_large", {
      path: uploads[0]?.path,
      parts,
      maxBytes: PLAN_ANSWER_MAX,
      message: `Hugging Face's upload plan for ${uploads[0]?.path ?? "the file"} has ${parts} parts, whose URLs pass ${PLAN_ANSWER_MAX} bytes in one answer, and one file's parts can't be paged yet.`,
    });
  }
  // A publishing claim taken, or a publish that finished, since the checks above: the plan doesn't land.
  const saved = await updateHub(target.id, (hub) =>
    hubBusy(hub, Date.now()) || hub?.status === "published"
      ? null
      : withPlan(hub, { uploaderJobId: caller.id, modelRepo: repo.id, files: lfsFiles, small, present }, new Date()),
  );
  if (!saved) return errorJson(409, "busy");
  const sending = uploads.filter((u) => u.transfer !== "none").length;
  const what = target.recipe === QUANT_RECIPE ? "local files'" : "adapter's";
  const when = target.recipe === QUANT_RECIPE ? "once the job succeeds" : "once the job is judged";
  await recordEvent(target.id, {
    type: "log",
    text:
      `Hugging Face: ${repo.id} is ready for the ${what} ${lfsFiles.length + Object.keys(small).length} files. The GPU uploads ${sending} ` +
      `${parsed.only ? `of the ${uploads.length} asked about now ` : ""}(${uploads.length - sending} already there), and the platform commits them with the cards ${when}.`,
  }).catch(() => undefined);
  // Presigned URLs are credentials while they last: they go to the GPU only, and are never logged or stored.
  return new Response(answer, { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

async function done(caller: TrainJobRow, target: TrainJobRow, body: Record<string, unknown>): Promise<Response> {
  const parsed = parseDone(body);
  if (parsed instanceof Response) return parsed;
  // A report comes from a GPU still running, about the plan it made, while that plan is uploading. A job that ended
  // (its token still works for a while) or a state that moved on (uploaded, publishing, published, failed) can't
  // change what the Hub has, so neither does its report.
  if (isTrainTerminal(caller.status)) return errorJson(409, "ended");
  const hub = target.hub;
  if (!hub?.files || hub.uploaderJobId !== caller.id) return errorJson(409, "no_plan");
  if (hub.status !== "uploading") return errorJson(409, "not_uploading", { status: hub.status });
  const byPath = new Map(hub.files.map((f) => [f.path, f]));
  for (const u of parsed.uploaded) {
    const f = byPath.get(u.path);
    // A small file the platform commits itself has no upload to report.
    if (!f && hub.small?.[u.path] !== undefined) continue;
    if (!f || f.sha256 !== u.oid || f.size !== u.size) return errorJson(400, `${u.path.slice(0, 200)} isn't in the upload plan as that object.`);
  }
  const saved = await updateHub(target.id, (h) =>
    h && h.uploaderJobId === caller.id && h.status === "uploading"
      ? withDone(h, { uploaded: parsed.uploaded.map((u) => u.oid), failed: parsed.failed }, new Date(), (x) => jobUploaded(target, x))
      : null,
  );
  if (!saved) return errorJson(409, "no_plan");
  const gguf = target.recipe === QUANT_RECIPE;
  const text =
    saved.status === "failed"
      ? (saved.reason ?? "The upload to Hugging Face failed.")
      : saved.status === "uploaded"
        ? gguf
          ? `Hugging Face has all of the local files for ${saved.modelRepo}. The platform commits them once the job succeeds.`
          : `Hugging Face has all of the adapter's files for ${saved.modelRepo}. The platform commits them once the job is judged.`
        : `The GPU uploaded ${parsed.uploaded.length} of the ${gguf ? "local files" : "adapter's files"} to Hugging Face; some are still missing.`;
  await recordEvent(target.id, { type: "log", text }).catch(() => undefined);
  return new Response(null, { status: 204 });
}

/**
 * POST {action: "plan" | "done", ...} from the job's runner with "Authorization: Bearer <job token>", the same token rules
 * as the events route (docs/TRAINING.md "Hugging Face Hub"). A glimmer-lora job acts for itself; a glimmer-publish job
 * for the adapter job its adapterJobId param names, and for no other; a glimmer-quantize job for itself, with its GGUF
 * builds and their small files (ggufPlan), each build up to HUB_GGUF_FILE_MAX_BYTES.
 *
 * plan {files: [{path, size, sha256, sample}], small: {path: base64}} -> 200 {skip: reason} when publishing is off here
 * (saved on the job as "off"), the job isn't one that publishes (a dry run, publish 0, ended, already published or
 * being published), the folder lacks adapter_model.safetensors or adapter_config.json, or a config the platform reads
 * (HUB_CHECKED_NAMES) isn't a JSON object, has an auto_map, or (adapter_config.json) names another base model or a bad
 * revision (saved on the job as "failed"); else the platform makes the model repo (private), asks the Hub's preupload
 * about every file, keeps the small ones it marks "regular" to commit itself, asks the LFS batch (basic and multipart,
 * never xet) about the rest and answers 200 {repo, uploads}: for each, "none" (the Hub has it), "basic" ({href,
 * header}) or "multipart" ({chunkSize, parts, completionUrl}), every URL presigned and never logged or stored. Only
 * HUB_FILE_NAMES are published: any other name gets no upload. Small files: at most 1 MB each and 3 MB in all, each one
 * files names, with its size and sha256 (413 small_too_large, 400 otherwise). A plan replaces the one before. With
 * {only: [path]} only those files get uploads in the answer. An answer past about 3.5 MB of part URLs is 413
 * plan_too_large instead: {perFile: true} when it planned more than one file, else {path, parts} for one file alone.
 * done {uploaded: [{path, oid, size}], failed: [{path, error}]} -> 204: the oids join the uploaded list, a failure fails
 * the upload with its reason (URLs blanked out), and with every file in the job's hub state is "uploaded". 409 ended
 * from a job that ended, no_plan without a plan from this job, not_uploading once the state moved on.
 *
 * 401 bad token, 400 bad input, 404 unknown job, 413 too large, 429 rate_limited past 60 calls an hour, 502
 * hub_unavailable (the Hub down or busy: tried again) or 409 hub_refused (a refusal, saved on the job), with the reason.
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  await requireJobToken(req, id);
  const hour = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
  const key = `train-hub:${id}`;
  const counts = await hitRateLimits([key], hour);
  if ((counts[key] ?? 0) > CALLS_PER_HOUR) return errorJson(429, "rate_limited");
  const body = await readJson(req, PLAN_BODY_MAX);
  if (body.action !== "plan" && body.action !== "done") return errorJson(400, 'Send action "plan" or "done".');
  if (body.action === "done" && Buffer.byteLength(JSON.stringify(body)) > DONE_BODY_MAX) throw new HttpError(413, "body_too_large");
  const caller = await getJob(id);
  if (!caller) return errorJson(404, "not_found");
  const found = await targetOf(caller);
  if ("skip" in found) return body.action === "plan" ? skip(null, found.skip) : errorJson(409, "no_plan");
  return body.action === "plan" ? plan(caller, found.target, body) : done(caller, found.target, body);
});
