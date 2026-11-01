// Runs one claimed job from start to finish: checks it, gives the runner its context, heartbeats, enforces the deadline,
// uploads what came out and reports the result. A job always ends in a finish call, so the platform never has to guess.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { composeClip } from "../compose.mjs";
import { contentTypeOf } from "../jobs/common.mjs";
import { RUNNERS } from "../jobs/index.mjs";
import { uploadThroughSlot } from "./blob.mjs";
import { labFailureSummary, summaryFor } from "./caption.mjs";
import { downloadFile } from "./download.mjs";
import { downloadHubFile } from "./hub-download.mjs";
import { LabError } from "./errors.mjs";
import { run, sleep as sleepFor, start } from "./proc.mjs";
import { findFfmpeg } from "./tools.mjs";
import { validateJob } from "./validate.mjs";

const CACHE_MAX_BYTES = 20 * 1024 * 1024 * 1024;
const FINAL_UPLOAD_MS = 120_000;

const ABORT_MESSAGES = {
  canceled: "The job was stopped.",
  timeout: "The job ran past its time limit.",
  agent_restarted: "The lab agent restarted during the job.",
};

function sha256Of(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** Removes the oldest cached downloads once the cache is over its limit. */
export async function pruneCache(cacheDir, maxBytes = CACHE_MAX_BYTES) {
  const names = await readdir(cacheDir).catch(() => []);
  const entries = await Promise.all(
    names.map(async (name) => {
      const file = path.join(cacheDir, name);
      const info = await stat(file).catch(() => null);
      return info?.isFile() ? { file, bytes: info.size, used: info.mtimeMs } : null;
    }),
  );
  const files = entries.filter(Boolean).sort((a, b) => a.used - b.used);
  let total = files.reduce((sum, f) => sum + f.bytes, 0);
  for (const file of files) {
    if (total <= maxBytes) break;
    await rm(file.file, { force: true });
    total -= file.bytes;
  }
}

/**
 * Uploads files through the slots the platform gives this job. A file that won't go up becomes a warning: losing a clip
 * shouldn't lose the check.
 *
 * @returns {Promise<{ artifacts: object[], warnings: string[] }>}
 */
export async function uploadFiles({ api, job, files, log, fetch: doFetch, signal }) {
  const artifacts = [];
  const warnings = [];
  if (files.length === 0) return { artifacts, warnings };
  const described = await Promise.all(
    files.map(async (file) => ({
      ...file,
      contentType: file.contentType ?? contentTypeOf(file.name),
      bytes: (await stat(file.path)).size,
      sha256: await sha256Of(file.path),
    })),
  );
  let slots;
  try {
    slots = await api.requestUploads(
      job.id,
      job.token,
      described.map(({ name, contentType, bytes, sha256 }) => ({ name, contentType, bytes, sha256 })),
    );
  } catch (err) {
    log.warn("upload slots failed", { job: job.id, error: String(err?.message ?? err) });
    return { artifacts, warnings: ["The lab couldn't upload this check's screenshots and clip."] };
  }
  for (const file of described) {
    const slot = slots.find((s) => s.name === file.name);
    if (!slot) {
      warnings.push(`The platform didn't accept ${file.name}.`);
      continue;
    }
    try {
      const placed = await uploadThroughSlot(slot, file.path, file.contentType, { fetch: doFetch, signal });
      artifacts.push({
        name: file.name,
        role: file.role,
        url: placed.url,
        pathname: placed.pathname,
        bytes: file.bytes,
        sha256: file.sha256,
        contentType: file.contentType,
        ...(file.caption ? { caption: file.caption } : {}),
      });
    } catch (err) {
      log.warn("upload failed", { job: job.id, file: file.name, error: String(err?.message ?? err) });
      warnings.push(`${file.name} didn't upload.`);
    }
  }
  return { artifacts, warnings };
}

/** Makes the finish call's body from what the runner returned. Pure. */
export function resultBody({ job, config, result, artifacts, warnings, durationMs }) {
  const { evaluation, device } = result;
  const loadMs = result.facts?.report?.loadMs ?? result.facts?.loadMs ?? evaluation.loadMs ?? null;
  return {
    outcome: evaluation.passed ? "passed" : "failed",
    informational: evaluation.informational === true,
    summary: summaryFor(job.kind, device, { passed: evaluation.passed, reasons: evaluation.reasons, loadMs }),
    device,
    checks: evaluation.checks,
    reasons: evaluation.reasons,
    warnings: [...evaluation.warnings, ...(result.warnings ?? []), ...warnings],
    captionBurned: result.captionBurned === true,
    loadMs,
    durationMs,
    attempt: job.attempt,
    agentVersion: config.version,
    artifacts,
    error: null,
    ...(result.simTune ? { simTune: result.simTune } : {}),
  };
}

/** The finish call's body for a check the lab couldn't run. Pure. */
export function labErrorBody({ job, config, code, message, artifacts = [], warnings = [], durationMs }) {
  return {
    outcome: "lab_error",
    informational: job.kind === "glasses_sim",
    summary: labFailureSummary(job.kind, job.input?.device ?? {}),
    device: null,
    checks: [],
    reasons: [],
    warnings,
    captionBurned: false,
    loadMs: null,
    durationMs,
    attempt: job.attempt ?? 1,
    agentVersion: config.version,
    artifacts,
    error: { code, message },
  };
}

/**
 * @param {unknown} raw the job from the claim response
 * @param {object} deps
 * @param {object} deps.config
 * @param {object} deps.api
 * @param {object} deps.log
 * @param {AbortSignal} [deps.stopSignal] the agent is shutting down
 * @param {typeof fetch} [deps.fetch]
 * @param {typeof run} [deps.exec]
 * @param {typeof start} [deps.startProc]
 * @param {typeof composeClip} [deps.compose]
 * @param {Record<string, Function>} [deps.runners]
 * @param {() => number} [deps.now]
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [deps.sleep]
 * @returns {Promise<{ jobId: string | null, outcome: string, finished: boolean }>}
 */
export async function executeJob(raw, deps) {
  const {
    config,
    api,
    log,
    stopSignal,
    fetch: doFetch = fetch,
    exec = run,
    startProc = start,
    compose = composeClip,
    runners = RUNNERS,
    now = Date.now,
    sleep = sleepFor,
  } = deps;
  const startedAt = now();
  if (typeof raw?.token === "string") log.addSecret(raw.token);

  const checked = validateJob(raw, { lane: config.lane, platformOrigin: config.platformOrigin, allowInsecure: config.allowInsecure });
  if (!checked.ok) {
    log.warn("invalid job", { job: raw?.id, error: checked.error });
    if (typeof raw?.id !== "string" || typeof raw?.token !== "string") return { jobId: null, outcome: "lab_error", finished: false };
    const body = labErrorBody({
      job: { kind: raw.kind, attempt: raw.attempt },
      config,
      code: "invalid_input",
      message: checked.error,
      durationMs: now() - startedAt,
    });
    const finished = await api.finish(raw.id, raw.token, body).catch(() => false);
    return { jobId: raw.id, outcome: "lab_error", finished };
  }

  const { job } = checked;
  log.addSecret(job.input.selftest?.token);
  const lines = [];
  const logLine = (line) => lines.push(`${new Date(now()).toISOString()} ${line}`);
  const dir = path.join(config.dataDir, "jobs", job.id);
  await mkdir(dir, { recursive: true });

  const controller = new AbortController();
  const { signal } = controller;
  const onStop = () => controller.abort("agent_restarted");
  if (stopSignal?.aborted) onStop();
  else stopSignal?.addEventListener("abort", onStop, { once: true });
  const deadline = setTimeout(() => controller.abort("timeout"), job.input.limitSeconds * 1000);

  let phase = "start";
  const beat = async () => {
    try {
      const reply = await api.heartbeat(job.id, job.token, { phase, attempt: job.attempt });
      if (reply.cancel) controller.abort("canceled");
    } catch (err) {
      log.warn("heartbeat failed", { job: job.id, error: String(err?.message ?? err) });
    }
  };
  const beating = setInterval(beat, config.heartbeatSeconds * 1000);
  void beat();

  const procs = [];
  const ctx = {
    job,
    input: job.input,
    config,
    dir,
    signal,
    log,
    logLine,
    now,
    redact: (text) => log.redact(text),
    sleep: (ms) => sleep(ms, signal),
    exec: (argv, opts = {}) => exec(argv, { signal, ...opts }),
    startProc: (argv, opts = {}) => {
      const proc = startProc(argv, { signal, ...opts });
      if (!opts.detach) procs.push(proc);
      return proc;
    },
    compose,
    ffmpeg: null,
    fetchSelftest: () => (api.fetchSelftest ? api.fetchSelftest(job.id, job.token).catch(() => null) : Promise.resolve(null)),
    setPhase: (name) => {
      phase = name;
      logLine(`phase: ${name}`);
    },
    throwIfAborted: () => {
      if (signal.aborted) throw new LabError(String(signal.reason), ABORT_MESSAGES[signal.reason] ?? "The job was stopped.");
    },
    fetch: doFetch,
    downloadHub: (spec) => downloadHubFile(spec, { cacheDir: path.join(config.dataDir, "cache"), tempDir: dir, fetch: doFetch, signal }),
    download: (spec) =>
      downloadFile(spec, {
        cacheDir: path.join(config.dataDir, "cache"),
        tempDir: dir,
        platformOrigin: config.platformOrigin,
        allowInsecure: config.allowInsecure,
        fetch: doFetch,
        signal,
      }),
  };

  let result = null;
  let failure = null;
  try {
    ctx.ffmpeg = await findFfmpeg({ configured: config.ffmpeg, exec: ctx.exec });
    if (!ctx.ffmpeg) throw new LabError("tool_missing", "ffmpeg isn't installed.");
    // A runner can come back normally from an abort, with facts made wrong by its tools being killed: a pid that reads as
    // empty looks like a crash. Those facts must not reach the verdict, so `result` is only set once this has passed.
    const produced = await runners[job.kind](ctx);
    ctx.throwIfAborted();
    result = produced;
  } catch (err) {
    if (signal.aborted) {
      const code = String(signal.reason);
      failure = { code, message: ABORT_MESSAGES[code] ?? "The job was stopped." };
    } else if (err instanceof LabError) {
      failure = { code: err.code, message: err.message };
    } else {
      failure = { code: "internal", message: "The lab agent hit an unexpected error." };
    }
    log.error("job failed", { job: job.id, code: failure.code, error: String(err?.stack ?? err) });
    logLine(`failed: ${failure.code}: ${String(err?.message ?? err)}`);
  } finally {
    clearTimeout(deadline);
    stopSignal?.removeEventListener("abort", onStop);
    for (const proc of procs) if (!proc.exited) proc.kill();
  }

  phase = "upload";
  const files = [...(result?.files ?? [])];
  const reportFile = path.join(dir, "report.json");
  const logFile = path.join(dir, "log.txt");
  let outcome = result ? (result.evaluation.passed ? "passed" : "failed") : "lab_error";
  let finished = false;
  try {
    if (result) {
      await writeFile(reportFile, log.redact(JSON.stringify({ evaluation: result.evaluation, device: result.device, facts: result.facts }, null, 2)));
      files.push({ path: reportFile, name: "report.json", role: "report" });
    }
    await writeFile(logFile, log.redact(lines.join("\n") || "No log lines."));
    files.push({ path: logFile, name: "log.txt", role: "log" });

    // A canceled job's results aren't wanted, and the signal above may already be aborted, so uploads get their own limit.
    const uploadSignal = failure?.code === "canceled" ? AbortSignal.abort() : AbortSignal.timeout(FINAL_UPLOAD_MS);
    const uploaded =
      failure?.code === "canceled"
        ? { artifacts: [], warnings: [] }
        : await uploadFiles({ api, job, files, log, fetch: doFetch, signal: uploadSignal });
    const durationMs = now() - startedAt;
    const body = result
      ? resultBody({ job, config, result, artifacts: uploaded.artifacts, warnings: uploaded.warnings, durationMs })
      : labErrorBody({ job, config, ...failure, artifacts: uploaded.artifacts, warnings: uploaded.warnings, durationMs });
    finished = await api.finish(job.id, job.token, body);
    log.info("job finished", { job: job.id, kind: job.kind, outcome, durationMs, accepted: finished });
  } catch (err) {
    outcome = "lab_error";
    log.error("finish failed", { job: job.id, error: String(err?.message ?? err) });
  } finally {
    clearInterval(beating);
    log.removeSecret(job.token);
    log.removeSecret(job.input.selftest?.token);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    await pruneCache(path.join(config.dataDir, "cache")).catch(() => {});
  }
  return { jobId: job.id, outcome, finished };
}
