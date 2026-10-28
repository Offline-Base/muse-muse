import path from "node:path";
import { APIError, Sandbox } from "@vercel/sandbox";
import { noEmDashes } from "@/lib/brief/normalize";
import { env } from "@/lib/env";
import { fetchBytes, putFile } from "@/lib/storage";
import type { Manifest, ModelUsage, MuseLogLine, Reference, Screenshot, VerifySummary } from "@/lib/types";
import {
  captionFromFileName,
  captionTimeline,
  DEMO,
  demoFilterGraph,
  demoRunFromReport,
  demoRunPassed,
  type DemoStudioSpec,
  demoVideoProblem,
  parseStudioSummary,
  parseVerifySummary,
  verifyOutcome,
  wrapText,
} from "@/lib/sandbox/artifacts";
import {
  childUsageLine,
  completeLines,
  condenseMuseLines,
  highlightsFrom,
  parseSessionUsage,
  SESSION_USAGE_SCRIPT,
  type SessionUsage,
} from "@/lib/sandbox/muse-log";
import { type BuildModel, isSessionId, museEnv, museExecArgs, optionalFlagsPrelude } from "@/lib/sandbox/muse";
import {
  BUILDER_MARKER,
  DEMO_OUT_DIR,
  DEMO_RECORDING_DIR,
  DEMO_SPEC_PATH,
  DEMO_STUDIO_MARKER,
  FIX_SCREENSHOTS_DIR,
  LOG_DIR,
  OUT_DIR,
  PLATFORM_FILES,
  PRISTINE_DIR,
  PRODUCT_DIR,
  RUN_DIR,
} from "@/lib/sandbox/paths";
import { builderNetworkPolicy, placeholderKey, publicHost, SNAPSHOT_POLICY } from "@/lib/sandbox/policy";
import { q, readBytes, sh, tailText, writeRunner } from "@/lib/sandbox/shell";
import { makeDirs, readTemplateFiles, setupBuilder } from "@/lib/sandbox/setup";
import {
  PREVIEW_WAIT_S,
  previewAnswered,
  previewWaitScript,
  pristineCopyScript,
  type SandboxTask,
  shrinkImagesScript,
  STUDIO_PROJECT,
  studioCommand,
  taskScript,
  VIDEO_PROJECT,
} from "@/lib/sandbox/tasks";

/**
 * CONTRACT (owned by the sandbox agent). Signatures are fixed; add optional fields only.
 *
 * Every function is safe to call from a workflow step: it takes plain values, returns small plain values, and finishes
 * well under a minute. Long work (Muse Code, verify, demo recording) starts detached and is polled, so a 20-minute
 * build is many short steps with durable sleeps between them.
 *
 * Product sandboxes are persistent and named `product-<slug>`. The product source lives in PRODUCT_DIR.
 */
export { PRODUCT_DIR };

const MIN = 60_000;
/** Session length for product sandboxes. Pro allows up to 24 hours; long work extends it with extendTimeout. */
const SANDBOX_TIMEOUT_MS = 60 * MIN;
/** How much session time must be left before long work starts. */
const LONG_WORK_MS = 40 * MIN;
const POLL_WORK_MS = 15 * MIN;
const VCPUS = 4;
/** Cap on new log bytes read per pollMuse call. */
const POLL_CAP_BYTES = 1024 * 1024;
const TASK_TAIL_BYTES = 4000;
/** How long a poll waits on a detached command to learn whether it has exited. */
const WAIT_PROBE_MS = 1200;
const MAX_SCREENSHOTS = 8;
/** Screenshots a fix round attaches with --image: as many as the judge looks at (lib/judge.ts). */
const MAX_FIX_SCREENSHOTS = 4;
/** Largest screenshot a fix round attaches. A bigger one is downscaled, or left out. */
const MAX_FIX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
/** How long one fix-round screenshot download may take before the round goes on without it. */
const FIX_SCREENSHOT_FETCH_MS = 20_000;
/** Batch size for writeFiles uploads, so one large video doesn't make a huge request. */
const WRITE_BATCH_BYTES = 24 * 1024 * 1024;
/**
 * How long finishDemo gives Demo Studio's basic cut when the task's render didn't come out. With the upload it keeps
 * the step under about four minutes.
 */
const BASIC_RENDER_S = 180;
/** Names of forkForDryRun's throwaway copies start with this. */
const DRY_RUN_PREFIX = "dryrun-";

// ---------------------------------------------------------------------------------------------------------------
// Helpers

export function sandboxNameFor(slug: string): string {
  const clean = slug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  if (!clean) throw new Error(`Invalid product slug: ${slug}`);
  return `product-${clean}`;
}

/** A reference's file name, made safe to use as a single path segment in inspo/ or fixtures/. */
export function safeFileName(name: string): string {
  const base = path.posix.basename(name.replace(/\\/g, "/")).replace(/[\u0000-\u001f]/g, "").trim();
  return base && base !== "." && base !== ".." ? base : "file";
}

/** A path relative to PRODUCT_DIR, refusing anything that climbs out of it. */
function productPath(rel: string): string {
  const norm = path.posix.normalize(rel.replace(/\\/g, "/")).replace(/^\.\/+/, "");
  if (!norm || norm.startsWith("/") || norm === ".." || norm.startsWith("../")) throw new Error(`Path must stay inside the product: ${rel}`);
  return `${PRODUCT_DIR}/${norm}`;
}

/** What Muse Code in this sandbox sends as its Meta key. The firewall swaps in the real one (policy.ts). */
function sandboxPlaceholder(sandboxName: string): string {
  return placeholderKey(env.modelApiKey, sandboxName);
}

/**
 * True on a local run (`npm run dev:local`), where PLATFORM_URL is localhost: the sandbox can't reach the gateway, so
 * the product calls Meta directly with the brokered placeholder key instead (policy.ts directProducts).
 */
function productsCallMetaDirectly(): boolean {
  return publicHost(env.platformUrl) === null;
}

function lockedPolicy(sandboxName: string) {
  return builderNetworkPolicy({
    modelApiKey: env.modelApiKey,
    placeholderKey: sandboxPlaceholder(sandboxName),
    platformHost: publicHost(env.platformUrl),
    blobUploads: true,
    directProducts: productsCallMetaDirectly(),
  });
}

function isNotFound(err: unknown): boolean {
  return err instanceof APIError && err.response.status === 404;
}

/** Gets a product sandbox with a running session, resuming it from its last snapshot when it was stopped. */
async function openSandbox(name: string): Promise<Sandbox> {
  return Sandbox.get({ name, resume: true });
}

function sessionStatus(sandbox: Sandbox): string | null {
  try {
    return sandbox.status;
  } catch {
    return null;
  }
}

/** Extends the running session so at least `needMs` is left. Failures (plan limits) are logged, not thrown. */
async function ensureTime(sandbox: Sandbox, needMs: number): Promise<void> {
  const expires = sandbox.expiresAt?.getTime();
  if (!expires) return;
  const remaining = expires - Date.now();
  if (remaining >= needMs) return;
  try {
    await sandbox.extendTimeout(needMs - remaining + 5 * MIN);
  } catch (err) {
    console.warn(`extendTimeout on ${sandbox.name} failed: ${String(err)}`);
  }
}

function envLocal(sandboxName: string, gatewayUrl: string, token: string): string {
  const [url, key] = productsCallMetaDirectly() ? ["https://api.meta.ai", sandboxPlaceholder(sandboxName)] : [gatewayUrl, token];
  return `# Written by the Muse Muse platform for this build. Never commit this file.\nGATEWAY_URL=${url}\nPRODUCT_TOKEN=${key}\n`;
}

async function download(items: Array<{ dir: "inspo" | "fixtures"; fileName: string; url: string }>) {
  const out: Array<{ path: string; content: Buffer }> = [];
  const queue = [...items];
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      out.push({ path: `${PRODUCT_DIR}/${item.dir}/${safeFileName(item.fileName)}`, content: await fetchBytes(item.url) });
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return out;
}

async function writeBatched(sandbox: Sandbox, files: Array<{ path: string; content: string | Buffer }>): Promise<void> {
  let batch: typeof files = [];
  let bytes = 0;
  for (const f of files) {
    const size = typeof f.content === "string" ? Buffer.byteLength(f.content) : f.content.length;
    if (batch.length && bytes + size > WRITE_BATCH_BYTES) {
      await sandbox.writeFiles(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(f);
    bytes += size;
  }
  if (batch.length) await sandbox.writeFiles(batch);
}

/** Remembers which log a detached command writes, so polls and kills only need the command id. */
async function recordCommand(sandbox: Sandbox, tag: string, cmdId: string, logPath: string): Promise<void> {
  await sandbox.writeFiles([
    { path: `${RUN_DIR}/${tag}.cmd`, content: cmdId },
    { path: `${RUN_DIR}/by-id/${cmdId}`, content: logPath },
  ]);
}

/** The id of a command started earlier under `tag` if it is still running, so a retried start doesn't double up. */
async function runningCommand(sandbox: Sandbox, tag: string): Promise<string | null> {
  const buf = await sandbox.readFileToBuffer({ path: `${RUN_DIR}/${tag}.cmd` }).catch(() => null);
  const cmdId = buf?.toString("utf8").trim();
  if (!cmdId) return null;
  const state = await commandState(sandbox, cmdId, "").catch(() => ({ finished: true }));
  return state.finished ? null : cmdId;
}

/**
 * Exit code of a detached command, or null while it runs. Measured on Oct 27: a plain GET of a detached command
 * reports exitCode null even after it exits, until something calls wait on it. Wait returns at once for a finished
 * command, so it is asked with a short deadline. Commands lost with an old session read the runner's .exit file.
 */
async function commandState(sandbox: Sandbox, cmdId: string, logPath: string): Promise<{ finished: boolean; exitCode: number | null }> {
  let cmd;
  try {
    cmd = await sandbox.getCommand(cmdId);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    const buf = logPath ? await sandbox.readFileToBuffer({ path: `${logPath}.exit` }).catch(() => null) : null;
    const code = buf ? Number(buf.toString("utf8").trim()) : NaN;
    return { finished: true, exitCode: Number.isFinite(code) ? code : null };
  }
  if (cmd.exitCode !== null) return { finished: true, exitCode: cmd.exitCode };
  const deadline = AbortSignal.timeout(WAIT_PROBE_MS);
  try {
    const done = await cmd.wait({ signal: deadline });
    return { finished: true, exitCode: done.exitCode };
  } catch (err) {
    if (deadline.aborted) return { finished: false, exitCode: null };
    throw err;
  }
}

async function readJson<T>(sandbox: Sandbox, file: string): Promise<T | null> {
  const buf = await sandbox.readFileToBuffer({ path: file }).catch(() => null);
  if (!buf) return null;
  try {
    return JSON.parse(buf.toString("utf8")) as T;
  } catch {
    return null;
  }
}

/** Local stand-in URL for artifacts when uploads are skipped in tests. */
function sandboxUrl(sandboxName: string, file: string): string {
  return `sandbox://${sandboxName}${file}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Provisioning

export interface ProvisionInput {
  buildId: string;
  slug: string;
  /** User references, copied into inspo/ under their file names. */
  references: Reference[];
  /** Copied into fixtures/. */
  fixtures: Array<{ fileName: string; url: string }>;
  /** Written to brief.md. */
  promptMarkdown: string;
  /** Build-scoped gateway token and URL, written to .env.local for the product's smoke tests. */
  buildToken: string;
  gatewayUrl: string;
}

/**
 * Creates the product's sandbox from BUILDER_SNAPSHOT_ID (or installs everything when no snapshot is set), puts the
 * template in PRODUCT_DIR, writes inspo/, fixtures/, brief.md and .env.local, then locks egress to the build policy
 * (api.meta.ai with the brokered key, registry.npmjs.org, the platform host).
 *
 * Idempotent: a retry reuses the existing sandbox and rewrites the same files.
 */
export async function provisionSandbox(input: ProvisionInput): Promise<{ sandboxName: string }> {
  const name = sandboxNameFor(input.slug);
  const snapshotId = env.builderSnapshotId;
  const common = {
    name,
    resume: true,
    persistent: true,
    resources: { vcpus: VCPUS },
    ports: [3000],
    timeout: SANDBOX_TIMEOUT_MS,
    // Each stop snapshots the VM. Two is enough to resume and to step back once.
    keepLastSnapshots: { count: 2, deleteEvicted: true },
    tags: { app: "musemuse", role: "product", slug: input.slug.slice(0, 60) },
  };
  const sandbox = snapshotId
    ? await Sandbox.getOrCreate({ ...common, source: { type: "snapshot", snapshotId }, networkPolicy: lockedPolicy(name) })
    : await Sandbox.getOrCreate({ ...common, networkPolicy: SNAPSHOT_POLICY });

  const ready = await sandbox.readFileToBuffer({ path: BUILDER_MARKER }).catch(() => null);
  if (!ready) {
    if (snapshotId) throw new Error(`Sandbox ${name} has no builder toolchain. Check BUILDER_SNAPSHOT_ID (${snapshotId}).`);
    if (process.env.VERCEL) throw new Error("BUILDER_SNAPSHOT_ID is not set. Run npm run snapshot and set it; template/ isn't deployed with the platform.");
    // Slow path for scripts (about a minute): install everything from scratch with open egress.
    await sandbox.update({ networkPolicy: SNAPSHOT_POLICY });
    await setupBuilder(sandbox, await readTemplateFiles(process.env.MUSEMUSE_TEMPLATE_DIR ?? "template"), () => {});
  }

  // Lock egress before anything from the user lands in the VM. Saved on the sandbox, so resumed sessions keep it.
  await sandbox.update({ networkPolicy: lockedPolicy(name) });

  await makeDirs(sandbox, [`${PRODUCT_DIR}/inspo`, `${PRODUCT_DIR}/fixtures`, LOG_DIR, RUN_DIR, `${RUN_DIR}/by-id`, OUT_DIR]);
  const downloaded = await download([
    ...input.references.map((r) => ({ dir: "inspo" as const, fileName: r.fileName, url: r.url })),
    ...input.fixtures.map((f) => ({ dir: "fixtures" as const, fileName: f.fileName, url: f.url })),
  ]);
  await writeBatched(sandbox, [
    ...downloaded,
    { path: `${PRODUCT_DIR}/brief.md`, content: input.promptMarkdown },
    { path: `${PRODUCT_DIR}/.env.local`, content: envLocal(name, input.gatewayUrl, input.buildToken) },
  ]);
  return { sandboxName: name };
}

/** Reopens an existing product sandbox for a refinement: resumes it, rewrites .env.local, and resets egress policy. */
export async function reopenSandbox(input: {
  sandboxName: string;
  buildToken: string;
  gatewayUrl: string;
  newReferences: Reference[];
}): Promise<void> {
  const sandbox = await openSandbox(input.sandboxName);
  await sandbox.update({ networkPolicy: lockedPolicy(input.sandboxName) });
  await ensureTime(sandbox, LONG_WORK_MS);
  await makeDirs(sandbox, [`${PRODUCT_DIR}/inspo`, LOG_DIR, RUN_DIR, `${RUN_DIR}/by-id`, OUT_DIR]);
  const downloaded = await download(input.newReferences.map((r) => ({ dir: "inspo" as const, fileName: r.fileName, url: r.url })));
  await writeBatched(sandbox, [...downloaded, { path: `${PRODUCT_DIR}/.env.local`, content: envLocal(input.sandboxName, input.gatewayUrl, input.buildToken) }]);
}

/**
 * A throwaway copy of a product sandbox, for dry runs that must leave the product as it is (scripts/rerecord-demos.ts
 * --dry-run): forked from the sandbox's last snapshot, not persistent, and tagged as a dry run. The copy can't reach
 * the platform. Its product calls Meta directly with the copy's own placeholder key, which the firewall swaps for the
 * real key on the routes products use (policy.ts directProducts), so a run needs no build token and writes nothing to
 * the database or Blob. Uploads through the gateway (files over 4.5 MB) and the gateway's limits don't apply there.
 * Delete the copy with deleteDryRunCopy.
 */
export async function forkForDryRun(sandboxName: string): Promise<{ sandboxName: string }> {
  const name = `${DRY_RUN_PREFIX}${Date.now().toString(36)}-${sandboxName}`.slice(0, 60).replace(/-+$/, "");
  const placeholder = sandboxPlaceholder(name);
  const fork = await Sandbox.fork({
    sourceSandbox: sandboxName,
    name,
    persistent: false,
    timeout: SANDBOX_TIMEOUT_MS,
    networkPolicy: builderNetworkPolicy({ modelApiKey: env.modelApiKey, placeholderKey: placeholder, platformHost: null, directProducts: true }),
    tags: { app: "musemuse", role: "dry-run", source: sandboxName.slice(0, 60) },
  });
  await fork.writeFiles([
    {
      path: `${PRODUCT_DIR}/.env.local`,
      content: `# Written by the Muse Muse platform for a dry run. Never commit this file.\nGATEWAY_URL=https://api.meta.ai\nPRODUCT_TOKEN=${placeholder}\n`,
    },
  ]);
  return { sandboxName: name };
}

/**
 * Deletes a copy made by forkForDryRun, and refuses any other sandbox, so a mix-up can never delete a product's own.
 * The copy isn't persistent and makes no snapshots, so there are none to clean up. One that is already gone is fine.
 */
export async function deleteDryRunCopy(sandboxName: string): Promise<void> {
  if (!sandboxName.startsWith(DRY_RUN_PREFIX)) throw new Error(`${sandboxName} is not a dry run's copy, so it was not deleted`);
  try {
    await (await Sandbox.get({ name: sandboxName })).delete();
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

/**
 * Puts this platform's PLATFORM_FILES (from template/) into a product sandbox and remakes PRISTINE_DIR from them with
 * sudo, so a sandbox from an older snapshot records with Demo Studio (scripts/rerecord-demos.ts). The next task
 * restores from the pristine copy, so a failed remake throws rather than leaving the old files to come back. Installs
 * nothing else.
 */
export async function refreshPlatformFiles(sandboxName: string, files: Array<{ path: string; content: Buffer | string }>): Promise<void> {
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const missing = PLATFORM_FILES.filter((f) => !byPath.has(f));
  if (missing.length) throw new Error(`These platform files are missing from template/: ${missing.join(", ")}`);
  const sandbox = await openSandbox(sandboxName);
  // Replace whatever is there, symlinks included, so the root copy below only ever reads what was just written.
  await sh(sandbox, `cd ${q(PRODUCT_DIR)} && rm -f -- ${PLATFORM_FILES.map(q).join(" ")}`);
  await writeBatched(sandbox, PLATFORM_FILES.map((f) => ({ path: `${PRODUCT_DIR}/${f}`, content: byPath.get(f)! })));
  await sh(sandbox, pristineCopyScript(), { sudo: true });
}

/** Writes a text file inside PRODUCT_DIR, such as fix.md or refine.md. */
export async function writeProductFile(sandboxName: string, path: string, content: string): Promise<void> {
  const sandbox = await openSandbox(sandboxName);
  await sandbox.writeFiles([{ path: productPath(path), content }]);
}

/**
 * Copies the first MAX_FIX_SCREENSHOTS screenshots the judge saw into FIX_SCREENSHOTS_DIR as round-<fix>-<k>.png, so
 * the fix run can attach them with --image. The folder gets its own `*` .gitignore (so sandboxes from older
 * snapshots ignore it too) and is never deployed (DEPLOY_EXCLUDE_DIRS). One over MAX_FIX_SCREENSHOT_BYTES is
 * downscaled with ffmpeg in the sandbox, or left out if it still doesn't fit. A screenshot that can't be downloaded in
 * FIX_SCREENSHOT_FETCH_MS is skipped. Returns the paths written, relative to PRODUCT_DIR, in order.
 */
export async function writeFixScreenshots(sandboxName: string, fix: number, screenshots: Screenshot[]): Promise<string[]> {
  const round = Math.max(0, Math.floor(fix));
  const dir = `${PRODUCT_DIR}/${FIX_SCREENSHOTS_DIR}`;
  const files: Array<{ path: string; content: string | Buffer }> = [{ path: `${dir}/.gitignore`, content: "*\n" }];
  const written: string[] = [];
  const oversized: string[] = [];
  for (const shot of screenshots.slice(0, MAX_FIX_SCREENSHOTS)) {
    const content = await fetchBytes(shot.url, { signal: AbortSignal.timeout(FIX_SCREENSHOT_FETCH_MS) }).catch((err: unknown) => {
      console.warn(`fix screenshot ${shot.url}: ${String(err)}`);
      return null;
    });
    if (!content?.length) continue;
    const rel = `${FIX_SCREENSHOTS_DIR}/round-${round}-${written.length + 1}.png`;
    // Too big to attach as it is: shrinkImagesScript downscales this copy into place.
    const big = content.length > MAX_FIX_SCREENSHOT_BYTES;
    files.push({ path: `${PRODUCT_DIR}/${rel}${big ? ".big" : ""}`, content });
    if (big) oversized.push(`${PRODUCT_DIR}/${rel}`);
    written.push(rel);
  }
  const sandbox = await openSandbox(sandboxName);
  // A retry, or an earlier refinement's fix round with the same number, may have left more files under this name.
  await sh(sandbox, `mkdir -p ${q(dir)} && rm -f ${q(dir)}/round-${round}-*`);
  await writeBatched(sandbox, files);
  if (!oversized.length) return written;

  const shrunk = await sh(sandbox, shrinkImagesScript(oversized, MAX_FIX_SCREENSHOT_BYTES), { allowFail: true, timeoutMs: 50_000 }).catch(
    (err: unknown) => {
      console.warn(`fix screenshots: downscaling failed: ${String(err)}`);
      return null;
    },
  );
  const fit = new Set((shrunk?.stdout ?? "").split("\n").map((l) => l.trim()));
  const dropped = oversized.filter((f) => !fit.has(f));
  if (dropped.length) console.warn(`fix screenshots over ${MAX_FIX_SCREENSHOT_BYTES} bytes left out: ${dropped.join(", ")}`);
  return written.filter((rel) => !dropped.includes(`${PRODUCT_DIR}/${rel}`));
}

// ---------------------------------------------------------------------------------------------------------------
// Muse Code

export interface StartMuseInput {
  sandboxName: string;
  /** A UUID. The first run sets it; later runs pass the same id to resume the session (docs/SPIKES.md). */
  sessionId: string;
  /** Path inside PRODUCT_DIR, such as brief.md or fix.md. */
  promptFile: string;
  /** Image paths inside PRODUCT_DIR (inspo/...), attached with --image. Missing files are skipped. */
  images: string[];
  model: BuildModel;
  maxModelSteps?: number;
  /** 0 for the first build, then 1, 2, 3 for fix rounds or refinements. Names the log file. */
  round: number;
}

/** Starts `muse exec --json` detached, writing JSONL to a log file. Returns immediately. */
export async function startMuse(input: StartMuseInput): Promise<{ cmdId: string; logPath: string }> {
  if (!isSessionId(input.sessionId)) throw new Error(`sessionId must be a UUID, got ${input.sessionId}`);
  const promptFile = productPath(input.promptFile).slice(PRODUCT_DIR.length + 1);
  const images = input.images.map((img) => productPath(img).slice(PRODUCT_DIR.length + 1));
  const tag = `muse-r${input.round}`;
  const logPath = `${LOG_DIR}/${tag}.jsonl`;

  const sandbox = await openSandbox(input.sandboxName);
  await ensureTime(sandbox, LONG_WORK_MS);
  const running = await runningCommand(sandbox, tag);
  if (running) return { cmdId: running, logPath };

  const argv = ["muse", ...museExecArgs({ promptFile, sessionId: input.sessionId, model: input.model, maxModelSteps: input.maxModelSteps })];
  const prelude = [
    // Keep an earlier run's log under another name (a refinement can reuse round numbers) for the transcript highlights.
    `[ -s ${q(logPath)} ] && mv ${q(logPath)} ${q(`${LOG_DIR}/${tag}`)}.$(date +%s).jsonl`,
    // A persistent product sandbox keeps the Muse Code it was made with, which may not have these yet.
    optionalFlagsPrelude(),
    ...images.map((img) => `[ -f ${q(img)} ] && cmd+=(--image ${q(img)})`),
    "true",
  ].join("\n");
  const script = await writeRunner(sandbox, {
    name: tag,
    cwd: PRODUCT_DIR,
    env: museEnv(sandboxPlaceholder(input.sandboxName)),
    argv,
    prelude,
    stdoutPath: logPath,
    stderrPath: `${LOG_DIR}/${tag}.err`,
  });
  const cmd = await sandbox.runCommand({ cmd: "bash", args: [script], detached: true });
  await recordCommand(sandbox, tag, cmd.cmdId, logPath);
  return { cmdId: cmd.cmdId, logPath };
}

export interface MusePoll {
  done: boolean;
  exitCode: number | null;
  /** Byte offset to pass to the next poll. */
  offset: number;
  /** New condensed log lines since the last poll (see the table in docs/SPIKES.md). */
  lines: MuseLogLine[];
  /**
   * From run.usage, priced with lib/meta/pricing.ts. Muse Code emits it once, just before the run ends, so it is
   * non-empty in exactly one poll: record it when it appears. Empty until then.
   */
  usage: ModelUsage[];
  /** The final message from run.terminal.completed. */
  finalText: string | null;
  /** Helper agents announced so far in this run. Pass it to the next poll as `announced`. */
  announced?: string[];
  /**
   * run.usage's children_included (Condensed.childrenIncluded) from this poll or, when this poll didn't read
   * run.usage, the `childrenIncluded` passed in. Null until run.usage is seen. Pass it to the next poll.
   */
  childrenIncluded?: boolean | null;
  /**
   * Read once, in the poll that reports done, from Muse Code's session log: what the reminder agents and subagents
   * used, which run.usage leaves out unless childrenIncluded is true, and the main agent's own calls, for a run that
   * ended before it wrote run.usage. Missing when the log couldn't be read.
   */
  session?: Pick<SessionUsage, "main" | "children">;
}

/** One run's usage from Muse Code's session log, in one sandbox command. Null when it can't be read. */
async function readSessionUsage(sandbox: Sandbox, logPath: string): Promise<SessionUsage | null> {
  try {
    const res = await sh(sandbox, `[ -s ${q(logPath)} ] || exit 0; node -e ${q(SESSION_USAGE_SCRIPT)} ${q(logPath)}`, {
      allowFail: true,
      timeoutMs: 40_000,
    });
    if (res.exitCode !== 0) throw new Error(`exit ${res.exitCode}: ${res.stderr.slice(-300)}`);
    const usage = parseSessionUsage(res.stdout);
    if (usage.unknown.calls) {
      const { calls, owners } = usage.unknown;
      console.warn(`Muse Code run ${usage.runId}: ${calls} model calls by ${owners.join(", ")} not charged (owner type never measured)`);
    }
    return usage.found ? usage : null;
  } catch (err) {
    console.warn(`Muse Code session usage for ${logPath}: ${String(err)}`);
    return null;
  }
}

/** Reads new JSONL from the log since `offset` and reports whether the command finished. */
export async function pollMuse(input: {
  sandboxName: string;
  cmdId: string;
  logPath: string;
  offset: number;
  /** The last poll's `announced`, so helper agents get one line per run. */
  announced?: string[];
  /** The last poll's `childrenIncluded`, since run.usage may arrive before the poll that reports done. */
  childrenIncluded?: boolean | null;
}): Promise<MusePoll> {
  const sandbox = await openSandbox(input.sandboxName);
  // Check the command first, then read: a run that ends between the two is reported done on the next poll.
  const state = await commandState(sandbox, input.cmdId, input.logPath);
  if (!state.finished) await ensureTime(sandbox, POLL_WORK_MS);

  const chunk = await readBytes(sandbox, input.logPath, input.offset, POLL_CAP_BYTES);
  const atEof = chunk.length < POLL_CAP_BYTES;
  let { lines, consumed } = completeLines(chunk);
  const extra: MuseLogLine[] = [];
  if (consumed === 0 && !atEof) {
    // One line longer than the cap. Skip it rather than stall; the next chunk starts mid-line and that part is dropped.
    consumed = chunk.length;
    lines = [];
    extra.push({ kind: "status", text: "Skipped a log entry over 1 MB" });
  }
  if (state.finished && atEof && consumed < chunk.length) {
    lines.push(chunk.subarray(consumed).toString("utf8"));
    consumed = chunk.length;
  }
  const condensed = condenseMuseLines(lines, input.announced);
  const childrenIncluded = condensed.childrenIncluded ?? input.childrenIncluded ?? null;
  const done = state.finished && atEof;
  const session = done ? await readSessionUsage(sandbox, input.logPath) : null;
  // When run.usage already counts the child agents, its own line says so.
  if (session?.children.calls && childrenIncluded !== true) extra.push(childUsageLine(session.children));

  if (done && state.exitCode !== 0) {
    const err = await tailText(sandbox, input.logPath.replace(/\.jsonl$/, ".err"), 4000);
    const useful = err
      .split("\n")
      .filter((l) => l.trim() && !/bubblewrap|bwrap/i.test(l))
      .join("\n")
      .slice(-1500);
    extra.push({
      kind: "error",
      ok: false,
      text: `Muse Code exited with ${state.exitCode === null ? "no exit code (the sandbox restarted)" : `code ${state.exitCode}`}${useful ? `: ${useful}` : ""}`,
    });
  }
  return {
    done,
    exitCode: done ? state.exitCode : null,
    offset: input.offset + consumed,
    lines: [...condensed.lines, ...extra],
    usage: condensed.usage,
    finalText: condensed.finalText,
    announced: condensed.announced,
    childrenIncluded,
    ...(session ? { session: { main: session.main, children: session.children } } : {}),
  };
}

/** Stops a running command, for timeouts. Sends SIGTERM to its process group, then SIGKILL if it lingers. */
export async function killCommand(sandboxName: string, cmdId: string): Promise<void> {
  const sandbox = await Sandbox.get({ name: sandboxName });
  if (sessionStatus(sandbox) !== "running") return; // The VM is stopped, so nothing is running.
  let cmd;
  try {
    cmd = await sandbox.getCommand(cmdId);
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }
  if ((await commandState(sandbox, cmdId, "")).finished) return;
  // The runner traps SIGTERM and takes its whole process group down (TERM, then KILL after 5 s).
  await cmd.kill("SIGTERM");
  const deadline = AbortSignal.timeout(9000);
  try {
    await cmd.wait({ signal: deadline });
    return;
  } catch (err) {
    if (!deadline.aborted) throw err;
  }
  await cmd.kill("SIGKILL");
}

// ---------------------------------------------------------------------------------------------------------------
// Preview, verify and demo

async function localStatus(sandbox: Sandbox, port: number): Promise<string> {
  const { stdout } = await sh(sandbox, `curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:${port}/ || true`);
  return stdout.trim() || "000";
}

/**
 * Starts `next dev` on 0.0.0.0:3000 if it isn't running, waits until GET / answers below 500 (redirects count), and
 * returns sandbox.domain(3000). Whether the page works is left to verify. Bounded to about two minutes.
 */
export async function startPreview(sandboxName: string): Promise<{ url: string }> {
  const sandbox = await openSandbox(sandboxName);
  await ensureTime(sandbox, POLL_WORK_MS);
  const status = await localStatus(sandbox, 3000);
  if (previewAnswered(status)) return { url: sandbox.domain(3000) };
  // Nothing answers yet. Start next dev, unless an earlier attempt's is still starting up.
  if (status === "000" && !(await runningCommand(sandbox, "dev"))) {
    const logPath = `${LOG_DIR}/dev.log`;
    const script = await writeRunner(sandbox, { name: "dev", cwd: PRODUCT_DIR, argv: ["npm", "run", "dev"], stdoutPath: logPath });
    const cmd = await sandbox.runCommand({ cmd: "bash", args: [script], detached: true });
    await recordCommand(sandbox, "dev", cmd.cmdId, logPath);
  }
  const wait = await sh(sandbox, previewWaitScript(3000), { allowFail: true, timeoutMs: (PREVIEW_WAIT_S + 30) * 1000 });
  if (wait.exitCode !== 0) {
    const last = wait.stdout.trim().split("\n").pop() || "000";
    const log = await tailText(sandbox, `${LOG_DIR}/dev.log`, 3000);
    const what = last === "000" ? `did not answer within ${PREVIEW_WAIT_S} s` : `answered ${last}`;
    throw new Error(`The preview on port 3000 ${what}. Dev server log:\n${log}`);
  }
  return { url: sandbox.domain(3000) };
}

export type { SandboxTask };

/**
 * Starts verify (scripts/verify.mjs) or the demo recording detached. Both first restore the platform-owned files from
 * the pristine copy, and the demo first stops any server left on ports 3100-3199. Combined output goes to
 * <task>.log, stdout alone to <task>.out.
 */
export async function startTask(sandboxName: string, task: SandboxTask): Promise<{ cmdId: string }> {
  const sandbox = await openSandbox(sandboxName);
  await ensureTime(sandbox, LONG_WORK_MS);
  const running = await runningCommand(sandbox, task);
  if (running) return { cmdId: running };

  const logPath = `${LOG_DIR}/${task}.log`;
  const outPath = `${LOG_DIR}/${task}.out`;
  const script = await writeRunner(sandbox, {
    name: task,
    cwd: PRODUCT_DIR,
    argv: ["bash", "-c", taskScript(task, outPath)],
    stdoutPath: logPath,
  });
  const cmd = await sandbox.runCommand({ cmd: "bash", args: [script], detached: true });
  await recordCommand(sandbox, task, cmd.cmdId, logPath);
  return { cmdId: cmd.cmdId };
}

export interface TaskPoll {
  done: boolean;
  exitCode: number | null;
  /** The last few KB of combined output. */
  outputTail: string;
}

export async function pollTask(sandboxName: string, cmdId: string): Promise<TaskPoll> {
  const sandbox = await openSandbox(sandboxName);
  const mapped = await sandbox.readFileToBuffer({ path: `${RUN_DIR}/by-id/${cmdId}` }).catch(() => null);
  const logPath = mapped?.toString("utf8").trim() || `${LOG_DIR}/unknown.log`;
  const state = await commandState(sandbox, cmdId, logPath);
  if (!state.finished) await ensureTime(sandbox, POLL_WORK_MS);
  const outputTail = await tailText(sandbox, logPath, TASK_TAIL_BYTES);
  return { done: state.finished, exitCode: state.exitCode, outputTail };
}

async function listFiles(sandbox: Sandbox, dir: string, pattern: string): Promise<string[]> {
  const { stdout } = await sh(sandbox, `cd ${q(dir)} 2>/dev/null && ls -1 ${pattern} 2>/dev/null | sort || true`);
  return stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

/**
 * After verify finishes: parses the JSON summary line verify.mjs prints last, and uploads test-results/judge/*.png
 * to Blob (screens/<buildId>/...). Passing `exitCode` lets it report a failure even if the summary line is missing.
 */
export async function collectVerifyResult(input: {
  sandboxName: string;
  buildId: string;
  round: number;
  exitCode: number | null;
  outputTail: string;
  /** Tests only: skip Blob uploads and return sandbox:// paths instead of URLs. */
  skipUpload?: boolean;
}): Promise<{ summary: VerifySummary; screenshots: Screenshot[] }> {
  const sandbox = await openSandbox(input.sandboxName);
  const stdout = await tailText(sandbox, `${LOG_DIR}/verify.out`, 64 * 1024);
  const tail = input.outputTail || (await tailText(sandbox, `${LOG_DIR}/verify.log`, 8000));
  const summary = verifyOutcome(parseVerifySummary(stdout), input.exitCode, tail);

  const judgeDir = `${PRODUCT_DIR}/test-results/judge`;
  const names = (await listFiles(sandbox, judgeDir, "*.png")).slice(0, MAX_SCREENSHOTS);
  const screenshots: Screenshot[] = [];
  for (const name of names) {
    const file = `${judgeDir}/${name}`;
    const caption = captionFromFileName(name);
    if (input.skipUpload) {
      screenshots.push({ url: sandboxUrl(input.sandboxName, file), caption });
      continue;
    }
    const buf = await sandbox.readFileToBuffer({ path: file });
    if (!buf) continue;
    screenshots.push({ url: await putFile("screens", `${input.buildId}/r${input.round}/${name}`, buf, "image/png"), caption });
  }
  return { summary, screenshots };
}

/**
 * Writes Demo Studio's spec (DEMO_SPEC_PATH) for the next demo run: what its cards say and the URL its window shows.
 * The recording it edits and the folder it renders into are always the same, so they are filled in here.
 */
export async function writeDemoSpec(
  sandboxName: string,
  spec: Pick<DemoStudioSpec, "title" | "tagline" | "models" | "url">,
): Promise<DemoStudioSpec> {
  const full: DemoStudioSpec = {
    title: noEmDashes(spec.title).trim() || "Untitled",
    tagline: noEmDashes(spec.tagline).trim(),
    models: [...new Set(spec.models.map((m) => m.trim()).filter(Boolean))],
    url: spec.url,
    timeline: `${PRODUCT_DIR}/${DEMO_RECORDING_DIR}/timeline.json`,
    out: DEMO_OUT_DIR,
  };
  const sandbox = await openSandbox(sandboxName);
  await sandbox.writeFiles([{ path: DEMO_SPEC_PATH, content: `${JSON.stringify(full, null, 2)}\n` }]);
  return full;
}

export interface DemoVideo {
  /** demos/<buildId>/demo.mp4, or null when there is no video. */
  videoUrl: string | null;
  /** demos/<buildId>/poster.jpg. Null when there is no video, or no poster could be made for it. */
  posterUrl: string | null;
}

const NO_DEMO: DemoVideo = { videoUrl: null, posterUrl: null };

/** True when the sandbox's pristine copy has Demo Studio, so its demo task ran the recorder (tasks.ts demoScript). */
async function hasDemoStudio(sandbox: Sandbox): Promise<boolean> {
  return (await sh(sandbox, `[ -f ${q(`${PRISTINE_DIR}/${DEMO_STUDIO_MARKER}`)} ]`, { allowFail: true })).exitCode === 0;
}

/** The recorder's timeline, which every studio run that got as far as the product writes, passing or not. */
const TIMELINE = `${PRODUCT_DIR}/${DEMO_RECORDING_DIR}/timeline.json`;

/** Why Demo Studio's render in DEMO_OUT_DIR can't be published, or null when it can. */
async function studioProblem(sandbox: Sandbox): Promise<string | null> {
  const buf = await sandbox.readFileToBuffer({ path: `${DEMO_OUT_DIR}/studio.json` }).catch(() => null);
  const summary = parseStudioSummary(buf ? buf.toString("utf8") : null);
  if (!summary.ok) return summary.error ?? "studio.json doesn't say ok";
  if (summary.mode === "basic" && summary.error) console.warn(`Demo Studio made its basic cut after the full render failed: ${summary.error.slice(0, 500)}`);
  const probe = await sh(
    sandbox,
    `ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height -show_entries format=duration -of json ${q(`${DEMO_OUT_DIR}/demo.mp4`)}`,
    { allowFail: true },
  );
  const problem = probe.exitCode === 0 ? demoVideoProblem(probe.stdout) : "ffprobe couldn't read it";
  return problem ? `demo.mp4 can't be published: ${problem}` : null;
}

/** Uploads an MP4 and its poster (when there is one) to demos/<buildId>/. A poster that won't upload is left out. */
async function uploadDemo(
  sandbox: Sandbox,
  input: { sandboxName: string; buildId: string; skipUpload?: boolean },
  mp4: string,
  poster: string,
): Promise<DemoVideo> {
  const hasPoster = (await sh(sandbox, `[ -s ${q(poster)} ]`, { allowFail: true })).exitCode === 0;
  if (input.skipUpload) {
    return { videoUrl: sandboxUrl(input.sandboxName, mp4), posterUrl: hasPoster ? sandboxUrl(input.sandboxName, poster) : null };
  }
  const video = await sandbox.readFileToBuffer({ path: mp4 });
  if (!video) throw new Error("Demo MP4 vanished before upload");
  const videoUrl = await putFile("demos", `${input.buildId}/demo.mp4`, video, "video/mp4");
  let posterUrl: string | null = null;
  try {
    const image = hasPoster ? await sandbox.readFileToBuffer({ path: poster }) : null;
    if (image?.length) posterUrl = await putFile("demos", `${input.buildId}/poster.jpg`, image, "image/jpeg");
  } catch (err) {
    console.warn(`demo poster for build ${input.buildId}: ${String(err)}`);
  }
  return { videoUrl, posterUrl };
}

/** Saves one frame of an MP4 as a JPEG, unless the poster is already there. Never throws. */
async function ensurePoster(sandbox: Sandbox, mp4: string, poster: string, atSeconds: number): Promise<void> {
  await sh(
    sandbox,
    `[ -s ${q(poster)} ] || ffmpeg -nostdin -y -hide_banner -loglevel error -ss ${atSeconds} -i ${q(mp4)} -frames:v 1 -q:v 3 ${q(poster)}`,
    { allowFail: true, timeoutMs: 30_000 },
  ).catch((err: unknown) => console.warn(`demo poster: ${String(err)}`));
}

/**
 * After the demo task finishes: uploads Demo Studio's demo.mp4 and poster.jpg to Blob (demos/<buildId>/...) and
 * returns their URLs. A render that is missing, says it failed, or isn't a 1920x1080 H.264 video longer than 3 s gets
 * one try at the basic cut (`demo-studio.mjs --basic`, bounded by BASIC_RENDER_S), and this throws if that doesn't come
 * out either. After an upload the recording's frames are deleted from the sandbox. Sandboxes from older snapshots, with
 * no Demo Studio in their pristine copy, and studio runs the recorder never saw make the old MP4 from Playwright's video
 * instead. Nulls when the demo run didn't pass: a failed or stale run is never published as the product's demo.
 */
export async function finishDemo(input: {
  sandboxName: string;
  buildId: string;
  /** The old recorder's title card. Demo Studio reads its text from the spec (writeDemoSpec). */
  title: string;
  subtitle: string;
  /** Tests only: skip the Blob upload and return a sandbox:// path instead of a URL. */
  skipUpload?: boolean;
}): Promise<DemoVideo> {
  const sandbox = await openSandbox(input.sandboxName);
  const reportBuf = await sandbox.readFileToBuffer({ path: `${PRODUCT_DIR}/test-results/report.json` }).catch(() => null);
  const report = reportBuf ? reportBuf.toString("utf8") : "";
  if (!(await hasDemoStudio(sandbox))) return finishLegacyDemo(sandbox, input, report);
  // With no timeline the recorder never ran, and a passing run was recorded again with Playwright's video (tasks.ts
  // demoScript), whose report finishLegacyDemo reads. A run that failed early has no demo result there either.
  if ((await sh(sandbox, `[ -s ${q(TIMELINE)} ]`, { allowFail: true })).exitCode !== 0) return finishLegacyDemo(sandbox, input, report);
  // The demo task deletes report.json first, so a run with no demo result never got far enough to record.
  if (!demoRunPassed(report, STUDIO_PROJECT)) return NO_DEMO;

  const mp4 = `${DEMO_OUT_DIR}/demo.mp4`;
  const poster = `${DEMO_OUT_DIR}/poster.jpg`;
  const problem = await studioProblem(sandbox);
  if (problem) {
    console.warn(`Demo Studio on ${input.sandboxName}: ${problem}. Making the basic cut.`);
    const basicLog = `${LOG_DIR}/demo-basic.log`;
    await sh(
      sandbox,
      [
        `rm -f ${q(`${DEMO_OUT_DIR}/studio.json`)} ${q(mp4)} ${q(poster)}`,
        `timeout -k 10 ${BASIC_RENDER_S} ${studioCommand(DEMO_SPEC_PATH, true)} > ${q(basicLog)} 2>&1`,
      ].join("\n"),
      { cwd: PRODUCT_DIR, allowFail: true, timeoutMs: (BASIC_RENDER_S + 30) * 1000 },
    ).catch((err: unknown) => console.warn(`Demo Studio basic cut on ${input.sandboxName}: ${String(err)}`));
    const still = await studioProblem(sandbox);
    if (still) {
      const log = (await tailText(sandbox, basicLog, 1500)).trim();
      throw new Error(`Demo Studio couldn't make the video (${problem}), and its basic cut failed too: ${still}.${log ? `\n${log}` : ""}`);
    }
  }
  // A render that left out its poster gets a frame from the intro card.
  await ensurePoster(sandbox, mp4, poster, 1.5);
  const video = await uploadDemo(sandbox, input, mp4, poster);
  // Hundreds of MB of frames would otherwise ride along in every snapshot of the sandbox. The timeline stays.
  if (!input.skipUpload) {
    await sh(sandbox, `rm -rf ${q(`${PRODUCT_DIR}/${DEMO_RECORDING_DIR}/frames`)}`, { allowFail: true }).catch((err: unknown) =>
      console.warn(`demo frames on ${input.sandboxName}: ${String(err)}`),
    );
  }
  return video;
}

/**
 * The old recorder, for sandboxes from snapshots made before Demo Studio: turns test-results/**\/video.webm into an MP4
 * with a title card and step captions (from report.json) using ffmpeg, with a poster from the title card.
 */
async function finishLegacyDemo(
  sandbox: Sandbox,
  input: { sandboxName: string; buildId: string; title: string; subtitle: string; skipUpload?: boolean },
  report: string,
): Promise<DemoVideo> {
  const run = report ? demoRunFromReport(report, VIDEO_PROJECT) : null;
  // No demo result means report.json is verify's smoke run, so any video lying around is from an older demo.
  if (run?.status !== "passed") return NO_DEMO;

  let video = run?.videoPath ?? null;
  if (video && !video.startsWith("/")) video = `${PRODUCT_DIR}/${video}`;
  if (video && (await sh(sandbox, `[ -s ${q(video)} ]`, { allowFail: true })).exitCode !== 0) video = null;
  if (!video) {
    const found = await sh(sandbox, `find test-results -name video.webm -size +0 -printf '%T@ %p\\n' 2>/dev/null | sort -n | tail -1 | cut -d' ' -f2-`, {
      cwd: PRODUCT_DIR,
    });
    const rel = found.stdout.trim();
    video = rel ? `${PRODUCT_DIR}/${rel.replace(/^\.\//, "")}` : null;
  }
  if (!video) return NO_DEMO;

  const probe = await sh(sandbox, `ffprobe -v error -show_entries format=duration -of csv=p=0 ${q(video)}`);
  const seconds = Number(probe.stdout.trim()) || 0;
  const captions = captionTimeline(run?.steps ?? [], seconds);

  const dir = DEMO_OUT_DIR;
  const files: Array<{ path: string; content: string }> = [];
  // One file per line of text (see TextBlock in artifacts.ts).
  const block = (name: string, text: string, width: number, maxLines: number) => ({
    lineFiles: wrapText(text, width, maxLines)
      .split("\n")
      .map((line, i) => {
        const file = `${dir}/${name}-${i}.txt`;
        files.push({ path: file, content: line });
        return file;
      }),
  });
  const footerFile = `${dir}/footer.txt`;
  files.push({ path: footerFile, content: "Built with Muse Muse. Not an official Meta product." });
  const graph = demoFilterGraph({
    title: block("title", input.title || "Untitled", 34, 2),
    subtitle: block("subtitle", input.subtitle, 64, 3),
    footerFile,
    captions: captions.map((c, i) => ({ ...block(`cap-${i}`, c.text, 64, 2), start: c.start, end: c.end })),
  });
  files.push({ path: `${dir}/graph.txt`, content: graph });
  await sh(sandbox, `rm -rf ${q(dir)} && mkdir -p ${q(dir)}`);
  await sandbox.writeFiles(files);

  const mp4 = `${dir}/demo.mp4`;
  const { width, height, fps, titleSeconds, background } = DEMO;
  await sh(
    sandbox,
    [
      "ffmpeg -y -hide_banner -loglevel error",
      `-f lavfi -i color=c=${background}:s=${width}x${height}:r=${fps}:d=${titleSeconds}`,
      `-i ${q(video)}`,
      `-/filter_complex ${q(`${dir}/graph.txt`)}`,
      "-map '[v]' -an -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p",
      `-r ${fps} -movflags +faststart ${q(mp4)}`,
    ].join(" "),
    { timeoutMs: 55_000 },
  );
  const check = await sh(
    sandbox,
    `ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height,pix_fmt -show_entries format=duration -of json ${q(mp4)}`,
  );
  const info = JSON.parse(check.stdout) as { streams?: Array<{ codec_name?: string; width?: number; height?: number }> };
  const stream = info.streams?.[0];
  if (stream?.codec_name !== "h264" || stream.width !== width || stream.height !== height) {
    throw new Error(`Demo MP4 came out wrong: ${check.stdout.slice(0, 400)}`);
  }

  const poster = `${dir}/poster.jpg`;
  await ensurePoster(sandbox, mp4, poster, DEMO.titleSeconds / 2);
  return uploadDemo(sandbox, input, mp4, poster);
}

// ---------------------------------------------------------------------------------------------------------------
// Reading results

/** Reads and parses musemuse.json. Null when it's missing or not JSON. */
export async function readManifest(sandboxName: string): Promise<Manifest | null> {
  const sandbox = await openSandbox(sandboxName);
  const manifest = await readJson<Manifest>(sandbox, `${PRODUCT_DIR}/musemuse.json`);
  return manifest && typeof manifest === "object" && !Array.isArray(manifest) ? manifest : null;
}

/** Reads BUILD_NOTES.md, trimmed. Null when missing. */
export async function readBuildNotes(sandboxName: string): Promise<string | null> {
  const sandbox = await openSandbox(sandboxName);
  const buf = await sandbox.readFileToBuffer({ path: `${PRODUCT_DIR}/BUILD_NOTES.md` }).catch(() => null);
  const text = buf?.toString("utf8").trim();
  return text ? text.slice(0, 40_000) : null;
}

/**
 * Prints the tool and edit events from every Muse Code log in this sandbox, oldest first, with their text cut to
 * the first line, so highlights don't have to pull megabytes of tool output out of the VM.
 */
const HIGHLIGHTS_FILTER = `
const fs = require("node:fs");
const dir = process.argv[2];
const files = fs.readdirSync(dir).filter((f) => /^muse-.*\\.jsonl$/.test(f))
  .map((f) => ({ f, t: fs.statSync(dir + "/" + f).mtimeMs })).sort((a, b) => a.t - b.t);
for (const { f } of files) {
  for (const line of fs.readFileSync(dir + "/" + f, "utf8").split("\\n")) {
    if (!line.includes('"tool.result"') && !line.includes('"task.lifecycle.tool_output_ref"')) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    const p = ev.payload || {};
    if (ev.payload_type === "tool.result") {
      const text = typeof p.text === "string" ? p.text.split("\\n").find((l) => l.trim()) || "" : "";
      console.log(JSON.stringify({ payload_type: ev.payload_type, payload: { correlation_facts: p.correlation_facts, edit_facts: p.edit_facts, text } }));
    } else if (ev.payload_type === "task.lifecycle.tool_output_ref") {
      const ref = (p.event && p.event.output_ref) || {};
      if (ref.kind === "tool_patch") console.log(JSON.stringify({ payload_type: ev.payload_type, payload: { event: { output_ref: { kind: ref.kind, patch_summary: ref.patch_summary } } } }));
    }
  }
}
`;

/**
 * Runs `muse export --session <id> --redacted`, uploads it to Blob (transcripts/<buildId>/...), and returns its URL
 * plus a short list of what happened (tool calls and edits) for the "how it was built" section.
 */
export async function exportTranscript(input: {
  sandboxName: string;
  sessionId: string;
  buildId: string;
  /** Tests only: skip the Blob upload and return a sandbox:// path instead of a URL. */
  skipUpload?: boolean;
}): Promise<{ url: string | null; highlights: string[] }> {
  if (!isSessionId(input.sessionId)) throw new Error(`sessionId must be a UUID, got ${input.sessionId}`);
  const sandbox = await openSandbox(input.sandboxName);
  const out = `${OUT_DIR}/transcript-${input.sessionId}.json`;
  const filter = `${RUN_DIR}/highlights.cjs`;
  await sandbox.writeFiles([{ path: filter, content: HIGHLIGHTS_FILTER }]);

  const [exported, filtered] = await Promise.all([
    sh(sandbox, `PATH="$HOME/.local/bin:$PATH" muse export --session ${q(input.sessionId)} --redacted --out ${q(out)}`, {
      cwd: PRODUCT_DIR,
      env: museEnv(sandboxPlaceholder(input.sandboxName)),
      allowFail: true,
      timeoutMs: 50_000,
    }),
    sh(sandbox, `node ${q(filter)} ${q(LOG_DIR)}`, { timeoutMs: 50_000 }),
  ]);
  const highlights = highlightsFrom(condenseMuseLines(filtered.stdout.split("\n")).lines);

  if (exported.exitCode !== 0) {
    console.warn(`muse export failed (exit ${exported.exitCode}): ${(exported.stderr || exported.stdout).slice(-500)}`);
    return { url: null, highlights };
  }
  if (input.skipUpload) return { url: sandboxUrl(input.sandboxName, out), highlights };
  const buf = await sandbox.readFileToBuffer({ path: out });
  if (!buf) return { url: null, highlights };
  return { url: await putFile("transcripts", `${input.buildId}/transcript.json`, buf, "application/json"), highlights };
}

/** Stops the sandbox. Persistent sandboxes snapshot on stop, so refinements resume where they left off. */
export async function hibernate(sandboxName: string): Promise<void> {
  let sandbox: Sandbox;
  try {
    sandbox = await Sandbox.get({ name: sandboxName });
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }
  const status = sessionStatus(sandbox);
  if (status !== "running" && status !== "pending") return;
  await sandbox.stop();
}
