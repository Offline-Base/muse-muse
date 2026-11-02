import path from "node:path";
import {
  BRIDGE_DIR,
  BRIDGE_SCRIPT,
  bridgeConfigPath,
  bridgePaths,
  MUSE_SDK_VERSION,
  type BridgeConfig,
  type MuseCommandEnvelope,
  type MuseEngine,
} from "@/lib/sandbox/bridge-protocol";
import { APIError, Sandbox } from "@vercel/sandbox";
import { noEmDashes } from "@/lib/brief/normalize";
import { buildTestModel, env } from "@/lib/env";
import { SPARK_STANDIN } from "@/lib/meta/spark";
import { buildMcpToken } from "@/lib/mcp/build-token";
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
import { BRIDGE_SOURCE } from "@/lib/sandbox/bridge-source";
import { bridgeTokenUsage, condenseBridgeLines, emptyBridgeState, type BridgeCondenseState } from "@/lib/sandbox/msp-log";
import {
  childUsageLine,
  completeLines,
  condenseMuseLines,
  highlightsFrom,
  parseSessionUsage,
  SESSION_USAGE_SCRIPT,
  type SessionUsage,
} from "@/lib/sandbox/muse-log";
import {
  backgroundModelSetting,
  type BuildModel,
  DEFAULT_MAX_MODEL_STEPS,
  DEFAULT_REASONING_EFFORT,
  isSessionId,
  museEnv,
  museExecArgs,
  OPTIONAL_EXEC_FLAGS,
  optionalConfigPrelude,
  optionalFlagsPrelude,
  REFINE_ROUND_STRIDE,
  SANDBOX_ENV,
  SERVE_SETTINGS,
} from "@/lib/sandbox/muse";
import {
  BUILD_MCP_PATH,
  BUILD_MCP_TOKEN_ENV,
  CHECKED_MUSE_VERSION,
  MUSE_FULL_MARKER,
  museConfigFiles,
  museSettings,
  remindersOffSetting,
  NOTES_DIR,
  NOTES_SESSION_FILE,
  WORKFLOW_SKILL_OFF,
  WORKFLOW_SKILL_PRELUDE,
} from "@/lib/sandbox/muse-config";
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
  CAPS_DIR,
  CAPS_VERIFY_MARKER,
  capOverlayMarker,
  TARGET_OVERLAYS,
  TARGET_PLATFORM_MARKER,
  TARGETS_DIR,
} from "@/lib/sandbox/paths";
import { capsMissingOverlays } from "@/lib/caps/ready";
import { localHardwareOverlay, usesLocalHardwareOverlay } from "@/lib/sandbox/local-gadget";
import { builderNetworkPolicy, placeholderKey, publicHost, SNAPSHOT_POLICY } from "@/lib/sandbox/policy";
import { q, readBytes, sh, tailText, writeRunner } from "@/lib/sandbox/shell";
import { applyLookScript, LOOK_CSS, MUSE_APP_OVERLAY, OVERLAYS_DIR, withLookColors } from "@/lib/sandbox/look";
import {
  applyTrustScript,
  TRUST_FILES,
  TRUST_OVERLAY,
  TRUST_RECORD_DIR,
  trustFileText,
  trustRecordScript,
  withTrustEnv,
  type TrustOverlay,
} from "@/lib/trust/overlay";
import {
  type BuilderInfo,
  installCaps,
  installTargets,
  makeDirs,
  readCapFiles,
  readTargetFiles,
  readTemplateFiles,
  setupBuilder,
  templateHash,
} from "@/lib/sandbox/setup";
import {
  activeCapsScript,
  activeTargetsScript,
  applyCapsScript,
  applyTargetScript,
  capsGatewayScript,
  capsGatewayText,
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
 * Product sandboxes are persistent and named `product-<slug>-<first 8 hex digits of the product id>` (products from
 * before Oct 28 keep their stored `product-<slug>`). The product source lives in PRODUCT_DIR.
 */
export { PRODUCT_DIR };

const MIN = 60_000;
/** Session length for product sandboxes. Pro allows up to 24 hours; long work extends it with extendTimeout. */
const SANDBOX_TIMEOUT_MS = 60 * MIN;

/**
 * The settings a round adds. A test build has its reminders off, and a key given twice refuses the run, so the off
 * setting replaces museSettings' own runtime_capabilities when both apply.
 */
function roundSettings(full: boolean, model: BuildModel): string[] {
  const settings = full ? museSettings(env.museAgentCapacity) : [];
  // By model too: a change to a product built on Contributor stays on it after the flag goes off (refineBuildModel).
  if (!buildTestModel() && model !== SPARK_STANDIN) return settings;
  return [...settings.filter((s) => !s.startsWith("runtime_capabilities=")), remindersOffSetting()];
}
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
/** Names of forkForProve's throwaway copies start with this. */
const PROVE_PREFIX = "prove-";
/**
 * How long a session bridge stays open with nothing running: after the owner stops a turn (time to send a note), or
 * while a goal waits for its next turn.
 */
const BRIDGE_IDLE_EXIT_MS = 2 * MIN;
/**
 * How long startMuse waits for a new bridge to have Muse Code take the prompt (usually 2 to 5 s). The bridge gives its
 * whole start 20 s (START_MS in bridge.mjs) and closing its host up to 20 s, so by then it has taken the prompt or
 * ended. One that has done neither is taken to be starting. With the SDK install, a start stays under about 75 s.
 */
const BRIDGE_START_PROBE_S = 45;
/** How long installing the bridge's SDK may take, the first time in a sandbox (one small package, no dependencies). */
const SDK_INSTALL_MS = 30_000;
/**
 * Where Muse Code keeps its copy of Meta's model catalog. A `muse serve` that finds it there skips the settings catalog
 * row (backgroundModelSetting), so a round's reminder agents go back to muse-spark-1.3 from the sandbox's second round
 * on. Without the file it fetches the catalog, applies the row and writes the file again (Oct 31,
 * docs/spikes/serve-2026-10-31). Exec applies the row either way.
 */
const MODEL_CATALOG_CACHE = '"$HOME/.local/share/muse/model-catalog"';
/** The largest command the mailbox takes. */
const MAX_COMMAND_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------------------------------------------
// Helpers

/**
 * A new product's sandbox name. Slugs are unique only within one database, and every environment that builds (the
 * live site and any local platform) shares the Vercel project's sandboxes, so the product id goes in the name too.
 */
export function sandboxNameFor(slug: string, productId: string): string {
  const clean = slug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 44)
    .replace(/-+$/, "");
  const id = productId.toLowerCase().replace(/[^0-9a-f]/g, "").slice(0, 8);
  if (!clean) throw new Error(`Invalid product slug: ${slug}`);
  if (id.length < 8) throw new Error(`Invalid product id: ${productId}`);
  return `product-${clean}-${id}`;
}

/**
 * Makes sure a product sandbox belongs to this product before anything touches it: a sandbox tagged with another
 * product's id is refused, and an untagged one (made before the tag existed) is claimed.
 */
async function claimSandbox(sandbox: Sandbox, name: string, productId: string): Promise<void> {
  const tags = sandbox.tags ?? {};
  if (tags.product && tags.product !== productId) {
    throw new Error(`Sandbox ${name} belongs to another product (${tags.product}), so this build left it alone.`);
  }
  if (!tags.product) await sandbox.update({ tags: { ...tags, product: productId } });
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

function lockedPolicy(sandboxName: string, capHosts: readonly string[] = []) {
  return builderNetworkPolicy({
    modelApiKey: env.modelApiKey,
    placeholderKey: sandboxPlaceholder(sandboxName),
    platformHost: publicHost(env.platformUrl),
    blobUploads: true,
    directProducts: productsCallMetaDirectly(),
    // Hosts a brief's caps need (lib/caps/hosts.ts). None for every product today.
    ...(capHosts.length ? { capHosts } : {}),
    platformBypass: env.previewBypass,
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

/**
 * The product's .env.local. A product calling Meta directly skips the gateway, and with it the gateway's TEST_MODEL swap
 * of a build's Muse Wonder calls, so on those runs TEST_MODEL goes in the file too and the template's metaClient (and
 * respondJson) makes the swap itself. Through the gateway the file never names it.
 */
function envLocal(sandboxName: string, gatewayUrl: string, token: string): string {
  const direct = productsCallMetaDirectly();
  const [url, key] = direct ? ["https://api.meta.ai", sandboxPlaceholder(sandboxName)] : [gatewayUrl, token];
  const test = direct ? buildTestModel() : null;
  // A build's own test runs are on Contributor, so its screens show the notice a live product on it shows.
  const notice = buildTestModel() ? "MUSE_CONTRIBUTOR_NOTICE=1\n" : "";
  return `# Written by the Muse Muse platform for this build. Never commit this file.\nGATEWAY_URL=${url}\nPRODUCT_TOKEN=${key}\n${test ? `TEST_MODEL=${test}\n` : ""}${notice}`;
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

/**
 * Remembers which log a detached command writes, so polls and kills only need the command id. A Muse Code round also
 * records the engine it runs on, so a command sent to it later knows where to go (sendMuseCommand).
 */
async function recordCommand(sandbox: Sandbox, tag: string, cmdId: string, logPath: string, engine?: MuseEngine): Promise<void> {
  await sandbox.writeFiles([
    { path: `${RUN_DIR}/${tag}.cmd`, content: cmdId },
    { path: `${RUN_DIR}/by-id/${cmdId}`, content: logPath },
    ...(engine ? [{ path: `${RUN_DIR}/${tag}.engine`, content: engine }] : []),
  ]);
}

/** The engine a round runs on: what startMuse recorded, or exec for rounds from before it did. */
async function roundEngine(sandbox: Sandbox, round: number): Promise<MuseEngine> {
  const buf = await sandbox.readFileToBuffer({ path: `${RUN_DIR}/muse-r${round}.engine` }).catch(() => null);
  return buf?.toString("utf8").trim() === "serve" ? "serve" : "exec";
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
  productId: string;
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
  /** MUSE_APP_LOOK: put the muse-app look in before anything from the user (applyLook). Off leaves the template as it is. */
  museAppLook?: boolean;
  /** Files beyond the template, by path in the product, for a brief's targets (lib/native/template-files.ts). With the look, in its colors (withLookColors). */
  extraFiles?: Array<{ path: string; content: string }>;
  /** Where the product runs (briefTargets). Nothing, or web alone, leaves the sandbox exactly as the template made it. */
  targets?: readonly string[];
  // ---------- Wave 3, unit 2: caps (docs/CAPABILITIES.md, 2.5). All absent for a brief with no cap blocks ----------
  /** The caps and overlays: applied right after the template is in place, and written to musemuse.caps.json. */
  caps?: { caps: string[]; overlays: string[] };
  /** Lines appended to .env.local (capBuildEnv). */
  capEnv?: string;
  /** Hosts the caps' build may reach (capBuildHosts). */
  capHosts?: string[];
  /**
   * Wave 3, unit 3 (docs/CAPABILITIES.md, 2.4a): on the live site, when the snapshot lacks some of `caps`' overlays, the
   * build goes without those caps instead of failing. Called before anything is applied, with the caps to drop; it gives
   * back the prompt and the caps' parts for the caps that are left. Without it the build fails with a plain line.
   */
  dropCaps?(caps: string[]): Promise<Pick<ProvisionInput, "promptMarkdown" | "caps" | "capEnv" | "capHosts">>;
  // ---------- Wave 3, unit 1: the trust overlay (docs/CAPABILITIES.md, section 7). Absent with the trust flags off ----------
  /** musemuse.trust.json and musemuse.privacy.json for this product: applied after the caps, with MUSEMUSE_BUILD=1. */
  trust?: TrustOverlay;
}

/** Makes the folders these files go in and returns them as writes, with their paths inside the product. */
async function productWrites(sandbox: Sandbox, files: Array<{ path: string; content: string }>): Promise<Array<{ path: string; content: string }>> {
  const writes = files.map((f) => ({ path: productPath(f.path), content: f.content }));
  if (writes.length) await makeDirs(sandbox, [...new Set(writes.map((f) => path.posix.dirname(f.path)))]);
  return writes;
}

/** Where a sandbox from an older snapshot gets the overlays from. template/ isn't deployed with the platform. */
const LOCAL_TEMPLATE_DIR = () => process.env.MUSEMUSE_TEMPLATE_DIR ?? "template";

/**
 * Gets a brief's targets into the sandbox before anything from the user lands in it. A snapshot made with the overlays has
 * them already. In one from before them, a local run takes them from this checkout, along with the newer platform files
 * that run their checks, so a target can be tried without a new snapshot. The live site can't: its functions have no
 * template/, so a target whose flag is on needs that snapshot.
 */
async function applyTargets(sandbox: Sandbox, sandboxName: string, targets: readonly string[]): Promise<void> {
  const overlays = targets.filter((t) => TARGET_OVERLAYS.includes(t));
  const inSandbox = async (file: string) => (await sh(sandbox, `[ -f ${q(file)} ]`, { allowFail: true })).exitCode === 0;
  const missing = (await Promise.all(overlays.map(async (t) => ((await inSandbox(`${TARGETS_DIR}/${t}/deps.json`)) ? null : t)))).filter((t) => t !== null);
  const stale = overlays.length > 0 && !(await inSandbox(`${PRISTINE_DIR}/${TARGET_PLATFORM_MARKER}`));
  if (missing.length || stale) {
    const needs = missing.length ? `the ${missing.join(" and ")} overlay` : "the platform files for targets";
    if (process.env.VERCEL) throw new Error(`This builder snapshot doesn't have ${needs}. Make a new one with npm run snapshot before turning the flag on.`);
    const dir = LOCAL_TEMPLATE_DIR();
    if (missing.length) {
      const files = await readTargetFiles(dir);
      if (!files.length) throw new Error(`This builder snapshot doesn't have ${needs}, and there's no ${dir}/targets here to add it from.`);
      await installTargets(sandbox, files, () => {});
    }
    if (stale) await refreshPlatformFiles(sandboxName, await readTemplateFiles(dir));
  }
  await sh(sandbox, activeTargetsScript(targets), { sudo: true });
  await sh(sandbox, applyTargetScript(targets), { cwd: PRODUCT_DIR, timeoutMs: 5 * MIN });
}

/**
 * Applies a brief's cap overlays (docs/CAPABILITIES.md, 2.5): the read-only record first, then the files, deps and
 * commit. It runs right after the targets and before anything from the user lands in the product, so the "Caps: ..."
 * commit holds platform files only. A snapshot made with template/caps has them already. In one from before them, a local
 * run takes them from this checkout, along with the newer platform files whose verify runs the caps step. The live site
 * can't, since its functions have no template/, so a cap whose flag is on there needs a new snapshot.
 */
async function applyCaps(sandbox: Sandbox, sandboxName: string, caps: { caps: string[]; overlays: string[] }): Promise<void> {
  // ---------- Wave 3, unit 3: every overlay's own marker, not only core's (docs/CAPABILITIES.md, 2.4a) ----------
  const { missing, stale } = await capsNotInSandbox(sandbox, caps.overlays);
  if (missing.length || stale) {
    if (process.env.VERCEL) throw new Error(capsMissingMessage(capsMissingOverlays(caps, stale ? ["core"] : missing)));
    const dir = LOCAL_TEMPLATE_DIR();
    if (missing.length) {
      const files = await readCapFiles(dir);
      if (!files.length) throw new Error(`This builder snapshot doesn't have the ${missing.join(" and ")} overlay, and there's no ${dir}/caps here to add it from.`);
      await installCaps(sandbox, files, () => {});
    }
    if (stale) await refreshPlatformFiles(sandboxName, await readTemplateFiles(dir));
  }
  // ---------- end Wave 3, unit 3 ----------
  // GADGET_CONNECT on a local run: the sandbox can't reach this machine's gateway, so the simulated board goes in the overlay.
  if (usesLocalHardwareOverlay(caps.overlays)) await installCaps(sandbox, localHardwareOverlay(await readCapFiles(LOCAL_TEMPLATE_DIR())) as Parameters<typeof installCaps>[1], () => {});
  await sh(sandbox, activeCapsScript(caps), { sudo: true });
  await sh(sandbox, applyCapsScript(caps), { cwd: PRODUCT_DIR, timeoutMs: 5 * MIN });
}

/**
 * Wave 3, unit 3: the overlays of `overlays` whose marker (capOverlayMarker) isn't in CAPS_DIR, and whether the pristine
 * verify.mjs is from before the caps step (CAPS_VERIFY_MARKER), which no cap can be checked without.
 */
async function capsNotInSandbox(sandbox: Sandbox, overlays: readonly string[]): Promise<{ missing: string[]; stale: boolean }> {
  const ok = async (cmd: string) => (await sh(sandbox, cmd, { allowFail: true })).exitCode === 0;
  const present = await Promise.all(overlays.map((o) => ok(`[ -f ${q(capOverlayMarker(o))} ]`)));
  const missing = overlays.filter((_, i) => !present[i]);
  const stale = !(await ok(`grep -q ${q(CAPS_VERIFY_MARKER)} ${q(`${PRISTINE_DIR}/scripts/verify.mjs`)}`));
  return { missing, stale };
}

/** The round's one plain line when a cap's overlay isn't in the snapshot and the build can't go on without it. */
export function capsMissingMessage(caps: readonly string[]): string {
  const names = caps.length ? caps.join(", ") : "a platform service";
  return `This builder snapshot doesn't have ${names}. An admin has to make a new builder snapshot (npm run snapshot) and commit lib/sandbox/snapshots.json.`;
}

/**
 * Writes the caps check's record of the gateway (CAPS_GATEWAY_FILE): the gateway's address and this build's token, or,
 * on a local run, why the build machine can't reach it. verify's caps step reads this, never the product's .env.local.
 */
async function writeCapsGateway(sandbox: Sandbox, gatewayUrl: string, buildToken: string): Promise<void> {
  const record = productsCallMetaDirectly()
    ? { url: null, token: null, reason: "this is a local run, so the build machine can't reach the gateway. Test platform services with a public PLATFORM_URL" }
    : { url: gatewayUrl, token: buildToken };
  const from = `${RUN_DIR}/caps-gateway.json`;
  await sandbox.writeFiles([{ path: from, content: capsGatewayText(record) }]);
  await sh(sandbox, capsGatewayScript(from), { sudo: true });
}

/**
 * Puts the trust overlay into a new product (lib/trust/overlay.ts): its two records root-owned and read-only, then its
 * files and a commit, right after the caps and before the user's files. A snapshot made with template/caps has the
 * overlay. In one from before it, a local run copies template/caps in from this checkout, as applyCaps does; the live
 * site can't, so it needs a new snapshot.
 */
async function applyTrust(sandbox: Sandbox, trust: TrustOverlay): Promise<void> {
  const ok = async (cmd: string) => (await sh(sandbox, cmd, { allowFail: true })).exitCode === 0;
  if (!(await ok(`[ -f ${q(`${CAPS_DIR}/${TRUST_OVERLAY}/platform-files.json`)} ]`))) {
    if (process.env.VERCEL) throw new Error("This builder snapshot doesn't have the trust overlay. Make a new one with npm run snapshot before turning a trust flag on.");
    const dir = LOCAL_TEMPLATE_DIR();
    const files = await readCapFiles(dir);
    if (!files.length) throw new Error(`This builder snapshot doesn't have the trust overlay, and there's no ${dir}/caps here to add it from.`);
    await installCaps(sandbox, files, () => {});
  }
  const from = `${RUN_DIR}/trust`;
  await makeDirs(sandbox, [from]);
  await sandbox.writeFiles(TRUST_FILES.map((f) => ({ path: `${from}/${f}`, content: trustFileText(f === "musemuse.trust.json" ? trust.trust : trust.privacy) })));
  await sh(sandbox, trustRecordScript(from), { sudo: true });
  await sh(sandbox, applyTrustScript(), { cwd: PRODUCT_DIR, timeoutMs: 2 * MIN });
}

/** .env.local as envLocal writes it, then the caps' lines (capBuildEnv). The same text without caps. */
function withCapEnv(text: string, capEnv: string | undefined): string {
  return capEnv ? `${text.replace(/\n*$/, "\n")}${capEnv}` : text;
}

/**
 * Puts the muse-app look (lib/sandbox/look.ts) into a new product. A snapshot made with the overlay has it. In one from
 * before it, a local run adds it from this checkout's template/targets, so the look can be tried without a new snapshot;
 * the live site can't, since its functions have no template/. Fails rather than build without it, since the build
 * prompt names its skill.
 */
async function applyLook(sandbox: Sandbox): Promise<void> {
  const found = await sh(sandbox, `[ -f ${q(`${OVERLAYS_DIR}/${MUSE_APP_OVERLAY}/deps.json`)} ]`, { allowFail: true });
  if (found.exitCode !== 0) {
    if (process.env.VERCEL) {
      throw new Error("This builder snapshot doesn't have the muse-app overlay. Make a new one with npm run snapshot before turning MUSE_APP_LOOK on.");
    }
    const dir = LOCAL_TEMPLATE_DIR();
    const files = (await readTargetFiles(dir)).filter((f) => f.path.startsWith(`targets/${MUSE_APP_OVERLAY}/`));
    if (!files.length) throw new Error(`This builder snapshot doesn't have the muse-app overlay, and there's no ${dir}/targets/${MUSE_APP_OVERLAY} to add it from.`);
    await installTargets(sandbox, files, () => {});
  }
  await sh(sandbox, applyLookScript(), { cwd: PRODUCT_DIR, timeoutMs: 5 * MIN });
}

/**
 * On a local run, says when the snapshot was made from a different template than this checkout's. A product gets
 * template/ from the snapshot (only PLATFORM_FILES are refreshed), so a change there, such as lib/meta/client.ts's
 * TEST_MODEL swap or a skill, isn't in this build until npm run snapshot. A warning, not an error: an older snapshot
 * is often fine. Quiet when the marker has no hash or there's no template/ here.
 */
async function warnIfOlderTemplate(marker: Buffer, snapshotId: string): Promise<void> {
  let made: string | undefined;
  try {
    made = (JSON.parse(marker.toString("utf8")) as Partial<BuilderInfo>).templateHash;
  } catch {
    return;
  }
  if (!made) return;
  const dir = LOCAL_TEMPLATE_DIR();
  // The same files, in the same order, as the snapshot's hash (setupBuilder): the template, its targets, then its caps.
  const files = await Promise.all([readTemplateFiles(dir), readTargetFiles(dir), readCapFiles(dir)]).catch(() => null);
  if (!files) return;
  const here = templateHash(files.flat());
  if (here === made) return;
  console.warn(
    `musemuse: builder snapshot ${snapshotId} has template ${made}, and ${dir}/ here is ${here}. Changes to the template since then, such as lib/meta/client.ts's TEST_MODEL swap, aren't in this build. Run npm run snapshot for them.`,
  );
}

/**
 * Creates the product's sandbox from BUILDER_SNAPSHOT_ID (or installs everything when no snapshot is set), puts the
 * template in PRODUCT_DIR, writes inspo/, fixtures/, brief.md and .env.local, then locks egress to the build policy
 * (api.meta.ai with the brokered key, registry.npmjs.org, the platform host). With museAppLook, the muse-app look goes
 * in first (applyLook), then a brief's targets (applyTargets), both before the user's files.
 *
 * Idempotent: a retry reuses the existing sandbox and rewrites the same files.
 */
export async function provisionSandbox(input: ProvisionInput): Promise<{ sandboxName: string }> {
  const name = sandboxNameFor(input.slug, input.productId);
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
    tags: { app: "musemuse", role: "product", slug: input.slug.slice(0, 60), product: input.productId },
  };
  const sandbox = snapshotId
    ? await Sandbox.getOrCreate({ ...common, source: { type: "snapshot", snapshotId }, networkPolicy: lockedPolicy(name) })
    : await Sandbox.getOrCreate({ ...common, networkPolicy: SNAPSHOT_POLICY });
  await claimSandbox(sandbox, name, input.productId);

  const ready = await sandbox.readFileToBuffer({ path: BUILDER_MARKER }).catch(() => null);
  if (!ready) {
    if (snapshotId) throw new Error(`Sandbox ${name} has no builder toolchain. Check BUILDER_SNAPSHOT_ID (${snapshotId}).`);
    if (process.env.VERCEL) throw new Error("BUILDER_SNAPSHOT_ID is not set. Run npm run snapshot and set it; template/ isn't deployed with the platform.");
    // Slow path for scripts (about a minute): install everything from scratch with open egress.
    await sandbox.update({ networkPolicy: SNAPSHOT_POLICY });
    const dir = LOCAL_TEMPLATE_DIR();
    await setupBuilder(sandbox, await readTemplateFiles(dir), () => {}, await readTargetFiles(dir), await readCapFiles(dir));
  } else if (snapshotId && !process.env.VERCEL) {
    await warnIfOlderTemplate(ready, snapshotId);
  }

  // ---------- Wave 3, unit 3: the backstop (docs/CAPABILITIES.md, 2.4a). On the live site, a cap whose overlay this
  // snapshot lacks is dropped here, before anything is applied or written, so the prompt never names it ----------
  if (input.caps && process.env.VERCEL) {
    const { missing, stale } = await capsNotInSandbox(sandbox, input.caps.overlays);
    const drop = capsMissingOverlays(input.caps, stale ? ["core"] : missing);
    if (drop.length) {
      if (!input.dropCaps) throw new Error(capsMissingMessage(drop));
      input = { ...input, caps: undefined, capEnv: undefined, capHosts: undefined, ...(await input.dropCaps(drop)) };
    }
  }
  // ---------- end Wave 3, unit 3 ----------

  // Lock egress before anything from the user lands in the VM. Saved on the sandbox, so resumed sessions keep it.
  await sandbox.update({ networkPolicy: lockedPolicy(name, input.capHosts) });

  if (input.museAppLook) await applyLook(sandbox);
  const targets = input.targets ?? [];
  if (targets.some((t) => t !== "web")) await applyTargets(sandbox, name, targets);
  // ---------- Wave 3, unit 2: a brief's cap overlays, right after its targets and before the user's files, so their
  // commit holds platform files only (docs/CAPABILITIES.md, 2.5). Nothing for a brief with no cap blocks ----------
  if (input.caps) await applyCaps(sandbox, name, input.caps);
  // ---------- end Wave 3, unit 2 ----------
  // ---------- Wave 3, unit 1: the trust overlay, after the caps. Nothing with the trust flags off ----------
  if (input.trust) await applyTrust(sandbox, input.trust);
  // ---------- end Wave 3, unit 1 ----------

  await makeDirs(sandbox, [`${PRODUCT_DIR}/inspo`, `${PRODUCT_DIR}/fixtures`, LOG_DIR, RUN_DIR, `${RUN_DIR}/by-id`, OUT_DIR]);
  const downloaded = await download([
    ...input.references.map((r) => ({ dir: "inspo" as const, fileName: r.fileName, url: r.url })),
    ...input.fixtures.map((f) => ({ dir: "fixtures" as const, fileName: f.fileName, url: f.url })),
  ]);
  await writeBatched(sandbox, [
    ...downloaded,
    ...(await productWrites(sandbox, input.museAppLook ? withLookColors(input.extraFiles ?? []) : (input.extraFiles ?? []))),
    { path: `${PRODUCT_DIR}/brief.md`, content: input.promptMarkdown },
    { path: `${PRODUCT_DIR}/.env.local`, content: withCapEnv(envLocal(name, input.gatewayUrl, input.buildToken), withTrustEnv(input.capEnv, Boolean(input.trust))) },
  ]);
  if (input.caps) await writeCapsGateway(sandbox, input.gatewayUrl, input.buildToken);
  return { sandboxName: name };
}

/** Reopens an existing product sandbox for a refinement: resumes it, rewrites .env.local, and resets egress policy. */
export async function reopenSandbox(input: {
  sandboxName: string;
  productId: string;
  buildToken: string;
  gatewayUrl: string;
  newReferences: Reference[];
  /**
   * Written only where missing: a product from before its target's files, and never over what Muse Code changed. A
   * product with the muse-app look (its LOOK_CSS) gets them in the look's colors, whatever the flag says now.
   */
  extraFiles?: Array<{ path: string; content: string }>;
  // ---------- Wave 3, unit 2: caps (docs/CAPABILITIES.md, 2.5). All absent for a product with no cap blocks ----------
  /** Hosts the product's caps need, so a refinement keeps them (capBuildHosts). */
  capHosts?: string[];
  /** Lines appended to .env.local after envLocal's (capBuildEnv), as provisioning does, so a refinement keeps them. */
  capEnv?: string;
  /** True for a product with caps: the caps check's record of the gateway gets this change's token. */
  caps?: boolean;
}): Promise<void> {
  const sandbox = await openSandbox(input.sandboxName);
  await claimSandbox(sandbox, input.sandboxName, input.productId);
  await sandbox.update({ networkPolicy: lockedPolicy(input.sandboxName, input.capHosts) });
  await ensureTime(sandbox, LONG_WORK_MS);
  await makeDirs(sandbox, [`${PRODUCT_DIR}/inspo`, LOG_DIR, RUN_DIR, `${RUN_DIR}/by-id`, OUT_DIR]);
  const downloaded = await download(input.newReferences.map((r) => ({ dir: "inspo" as const, fileName: r.fileName, url: r.url })));
  const present = await Promise.all((input.extraFiles ?? []).map((f) => sandbox.readFileToBuffer({ path: productPath(f.path) }).catch(() => null)));
  const missing = (input.extraFiles ?? []).filter((_, i) => !present[i]);
  const look = missing.length > 0 && Boolean(await sandbox.readFileToBuffer({ path: productPath(LOOK_CSS) }).catch(() => null));
  // Wave 3, unit 1: a product built with the trust overlay keeps its age gate off for this change's tests, whatever the
  // flags say now. Its record is only there when it was built with one.
  const trusted = Boolean(await sandbox.readFileToBuffer({ path: `${TRUST_RECORD_DIR}/${TRUST_FILES[0]}` }).catch(() => null));
  await writeBatched(sandbox, [
    ...downloaded,
    ...(await productWrites(sandbox, look ? withLookColors(missing) : missing)),
    { path: `${PRODUCT_DIR}/.env.local`, content: withCapEnv(envLocal(input.sandboxName, input.gatewayUrl, input.buildToken), withTrustEnv(input.capEnv, trusted)) },
  ]);
  if (input.caps) await writeCapsGateway(sandbox, input.gatewayUrl, input.buildToken);
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
 * A throwaway copy of a product sandbox for the Prove it stage (docs/PRODUCT_OUTPUTS.md), forked from its last snapshot,
 * so the product's own sandbox stays free for a refinement and nothing done here reaches it. It can reach the platform
 * and the product's live host, and Muse Code's brokered routes at Meta. Its old build token was revoked when the build
 * ended, and it gets no other. Delete it with deleteProveCopy; if that never runs it times out by itself.
 */
export async function forkForProve(sandboxName: string, hosts: { liveHost: string; platformHost: string | null }): Promise<{ sandboxName: string }> {
  const name = `${PROVE_PREFIX}${Date.now().toString(36)}-${sandboxName}`.slice(0, 60).replace(/-+$/, "");
  await Sandbox.fork({
    sourceSandbox: sandboxName,
    name,
    persistent: false,
    timeout: SANDBOX_TIMEOUT_MS,
    networkPolicy: builderNetworkPolicy({
      modelApiKey: env.modelApiKey,
      placeholderKey: sandboxPlaceholder(name),
      platformHost: hosts.platformHost,
      extraHosts: [hosts.liveHost],
      // Only when platformHost is the preview's own host: a caller's other site (prove-run.ts --site) gets no secret.
      platformBypass: env.previewBypass,
    }),
    tags: { app: "musemuse", role: "prove", source: sandboxName.slice(0, 60) },
  });
  return { sandboxName: name };
}

/** Deletes a copy made by forkForProve, and refuses any other sandbox. One that is already gone is fine. */
export async function deleteProveCopy(sandboxName: string): Promise<void> {
  if (!sandboxName.startsWith(PROVE_PREFIX)) throw new Error(`${sandboxName} is not a Prove it copy, so it was not deleted`);
  try {
    await (await Sandbox.get({ name: sandboxName })).delete();
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

/** Writes files into a Prove it copy, making their folders. Paths are absolute. */
export async function writeProveFiles(sandboxName: string, files: Array<{ path: string; content: string | Buffer }>): Promise<void> {
  const sandbox = await openSandbox(sandboxName);
  await makeDirs(sandbox, [...new Set(files.map((f) => path.posix.dirname(f.path)))]);
  await writeBatched(sandbox, files);
}

/** Reads a text file from a sandbox, or null when it isn't there. */
export async function readSandboxText(sandboxName: string, file: string): Promise<string | null> {
  const sandbox = await openSandbox(sandboxName);
  const buf = await sandbox.readFileToBuffer({ path: file }).catch(() => null);
  return buf ? buf.toString("utf8") : null;
}

/** Starts one of the stage's long commands detached, under pollTask. A retry finds the one already running. */
export async function startProveCommand(sandboxName: string, input: { tag: "prove-checks" | "prove-record"; cwd: string; argv: string[] }): Promise<{ cmdId: string }> {
  const sandbox = await openSandbox(sandboxName);
  await ensureTime(sandbox, LONG_WORK_MS);
  await makeDirs(sandbox, [LOG_DIR, RUN_DIR, `${RUN_DIR}/by-id`]);
  const running = await runningCommand(sandbox, input.tag);
  if (running) return { cmdId: running };
  const logPath = `${LOG_DIR}/${input.tag}.log`;
  const script = await writeRunner(sandbox, { name: input.tag, cwd: input.cwd, argv: input.argv, stdoutPath: logPath });
  const cmd = await sandbox.runCommand({ cmd: "bash", args: [script], detached: true });
  await recordCommand(sandbox, input.tag, cmd.cmdId, logPath);
  return { cmdId: cmd.cmdId };
}

/** The skill test's flags beyond exec's own: its step cap needs no reminder agents on top, when this Muse Code has the flag. */
const SKILL_TEST_FLAGS = [...OPTIONAL_EXEC_FLAGS, "--disable-reminders"] as const;

export interface SkillTestStart {
  cmdId: string;
  logPath: string;
  /** The command it ran, for the video. */
  command: string;
}

/**
 * Starts a fresh Muse Code session in `cwd`, a folder with nothing in it but the skill, so what it does comes from the
 * skill file and not from the product's source. Low effort, capped at `maxModelSteps`, with no platform hooks or build
 * MCP server. Poll it with pollMuse. A retry finds the one already running.
 */
export async function startSkillTest(input: { sandboxName: string; cwd: string; model: BuildModel; maxModelSteps: number; sessionId: string }): Promise<SkillTestStart> {
  const sandbox = await openSandbox(input.sandboxName);
  await ensureTime(sandbox, LONG_WORK_MS);
  await makeDirs(sandbox, [LOG_DIR, RUN_DIR, `${RUN_DIR}/by-id`]);
  const tag = "prove-skill";
  const logPath = `${LOG_DIR}/${tag}.jsonl`;
  const args = museExecArgs({ promptFile: "prompt.md", sessionId: input.sessionId, model: input.model, reasoningEffort: "low", maxModelSteps: input.maxModelSteps });
  const command = `muse exec --model ${input.model} --reasoning-effort low --max-model-steps ${input.maxModelSteps} --prompt-file prompt.md`;
  const running = await runningCommand(sandbox, tag);
  if (running) return { cmdId: running, logPath, command };
  const script = await writeRunner(sandbox, {
    name: tag,
    cwd: input.cwd,
    env: museEnv(sandboxPlaceholder(input.sandboxName)),
    argv: ["muse", ...args],
    prelude: [optionalFlagsPrelude(SKILL_TEST_FLAGS), optionalConfigPrelude([...(input.model === SPARK_STANDIN ? [remindersOffSetting()] : []), backgroundModelSetting(input.model)], CHECKED_MUSE_VERSION), "true"].join("\n"),
    stdoutPath: logPath,
    stderrPath: `${LOG_DIR}/${tag}.err`,
  });
  const cmd = await sandbox.runCommand({ cmd: "bash", args: [script], detached: true });
  await recordCommand(sandbox, tag, cmd.cmdId, logPath, "exec");
  return { cmdId: cmd.cmdId, logPath, command };
}

/** What a running Muse Code round has spent so far by its session log, in USD. 0 when the log can't be read yet. */
export async function museRunSpendUsd(sandboxName: string, logPath: string): Promise<number> {
  const sandbox = await openSandbox(sandboxName);
  const usage = await readSessionUsage(sandbox, logPath);
  if (!usage) return 0;
  return [...usage.main.usage, ...usage.children.usage].reduce((sum, u) => sum + (u.costUsd || 0), 0);
}

/**
 * Uploads one output's video from a Prove it copy to demos/<buildId>/prove-<output>.mp4 with its poster, after checking
 * it is the kind of video Demo Studio makes. Null when there is nothing fit to publish, with the reason logged.
 */
export async function uploadProveVideo(input: { sandboxName: string; buildId: string; output: string; dir: string; skipUpload?: boolean }): Promise<DemoVideo | null> {
  const sandbox = await openSandbox(input.sandboxName);
  const mp4 = `${input.dir}/demo.mp4`;
  const poster = `${input.dir}/poster.jpg`;
  const probe = await sh(
    sandbox,
    `[ ! -e ${q(`${input.dir}/failed`)} ] && ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height -show_entries format=duration -of json ${q(mp4)}`,
    { allowFail: true },
  );
  const problem = probe.exitCode === 0 ? demoVideoProblem(probe.stdout) : "it wasn't made";
  if (problem) {
    console.warn(`Prove it video ${input.output} on ${input.sandboxName}: ${problem}`);
    return null;
  }
  await ensurePoster(sandbox, mp4, poster, 1.5);
  const hasPoster = (await sh(sandbox, `[ -s ${q(poster)} ]`, { allowFail: true })).exitCode === 0;
  if (input.skipUpload) return { videoUrl: sandboxUrl(input.sandboxName, mp4), posterUrl: hasPoster ? sandboxUrl(input.sandboxName, poster) : null };
  const video = await sandbox.readFileToBuffer({ path: mp4 });
  if (!video) return null;
  const videoUrl = await putFile("demos", `${input.buildId}/prove-${input.output}.mp4`, video, "video/mp4");
  let posterUrl: string | null = null;
  try {
    const image = hasPoster ? await sandbox.readFileToBuffer({ path: poster }) : null;
    if (image?.length) posterUrl = await putFile("demos", `${input.buildId}/prove-${input.output}.jpg`, image, "image/jpeg");
  } catch (err) {
    console.warn(`Prove it poster ${input.output}: ${String(err)}`);
  }
  return { videoUrl, posterUrl };
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
  /** The engine to try: env.museEngine when unset. A round whose session bridge can't start runs on exec. */
  engine?: MuseEngine;
  /** The goal's objective for the session bridge (MSP goal/set), from goalObjective. Exec rounds have no goal. */
  goal?: string | null;
  /** The build, for its build MCP token under MUSE_FULL. Without it the round runs without the build MCP server. */
  buildId?: string;
  /** A scaled round's cap (ENGINE_ROUND_SCALING): the session keeps the cap plus a poll's time. Unset keeps LONG_WORK_MS. */
  capMs?: number;
}

export interface MuseStart {
  cmdId: string;
  logPath: string;
  /** The engine the round runs on. Pass it to pollMuse and sendMuseCommand. */
  engine: MuseEngine;
  /** Set when the round didn't get the engine it asked for, for the build room. */
  notice?: string;
  /** True when the run has the build MCP server (MUSE_FULL, a reachable platform and the build's token). */
  buildMcp?: boolean;
}

/** What both engines' starts need, worked out once. */
interface MuseRunSpec extends StartMuseInput {
  /** Relative to PRODUCT_DIR, checked to stay inside it. */
  promptFile: string;
  images: string[];
  tag: string;
  full: boolean;
  /** The build MCP token, when the run gets the build MCP server. */
  token: string | null;
}

/** True when a sandbox can reach the platform, as lockedPolicy allows it: a public platform host, and not a dry run's copy. */
function platformReachable(sandboxName: string): boolean {
  return !sandboxName.startsWith(DRY_RUN_PREFIX) && publicHost(env.platformUrl) !== null;
}

/** The build MCP token for a run, or null when it can't use the build MCP server. */
function buildMcpTokenFor(input: StartMuseInput): string | null {
  if (!input.buildId || !platformReachable(input.sandboxName)) return null;
  try {
    return buildMcpToken(input.buildId, env.gatewayTokenPepper);
  } catch (err) {
    console.warn(`build MCP token for ${input.buildId}: ${String(err)}`);
    return null;
  }
}

/** Env for a Muse Code runner: the brokered placeholder key, and the build MCP token when there is one. */
function runnerEnv(run: MuseRunSpec): Record<string, string> {
  return { ...museEnv(sandboxPlaceholder(run.sandboxName)), ...(run.token ? { [BUILD_MCP_TOKEN_ENV]: run.token } : {}) };
}

/**
 * Writes the platform's Muse Code config (lib/sandbox/muse-config.ts) before a start under MUSE_FULL, removing what is
 * at each path first: the hook scripts, .muse/hooks.json, and .mcp.json when the run has a build MCP token (else
 * .mcp.json is just removed). Also records the session id, so owner notes on exec rounds reach the main agent, and
 * keeps .muse/ (with its subagents' worktrees) and .mcp.json out of the product's commits through the checkout's own
 * info/exclude, which changes nothing tracked. MUSE_FULL_MARKER goes first, so a later start without MUSE_FULL takes
 * all of it away again (clearMuseConfig). The start of a build or a change also empties the exec notes a past run never
 * read, which were for other work, while a fix round keeps them: a note sent just after a run's last tool call still
 * reaches the same build's next run.
 */
async function writeMuseConfig(sandbox: Sandbox, run: MuseRunSpec): Promise<void> {
  const files = museConfigFiles({ mcpUrl: run.token ? `${env.platformUrl}${BUILD_MCP_PATH}` : null });
  const git = `${PRODUCT_DIR}/.git`;
  const exclude = `${git}/info/exclude`;
  await sh(
    sandbox,
    [
      `rm -rf -- ${files.remove.map(q).join(" ")} && mkdir -p -- ${files.dirs.map(q).join(" ")}`,
      `if [ -d ${q(git)} ]; then mkdir -p ${q(`${git}/info`)}; for p in .muse/ .mcp.json; do grep -qxF -- "$p" ${q(exclude)} 2>/dev/null || printf '%s\\n' "$p" >> ${q(exclude)}; done; fi`,
      ...(run.round % REFINE_ROUND_STRIDE === 0 ? [`rm -f -- ${q(NOTES_DIR)}/*.json`] : []),
    ].join("\n"),
  );
  await sandbox.writeFiles([
    { path: MUSE_FULL_MARKER, content: `${new Date().toISOString()}\n` },
    ...files.write,
    { path: NOTES_SESSION_FILE, content: `${run.sessionId}\n` },
  ]);
}

/**
 * Takes the platform's Muse Code config away again before a start without MUSE_FULL, in a sandbox an earlier start
 * gave it to (MUSE_FULL_MARKER): exec trusts the workspace, so its hooks and .mcp.json would still load, and the
 * workflow-authoring skill would stay on. A sandbox that never had MUSE_FULL runs nothing here. Best effort: when it
 * fails, the round runs with what is there and the next start tries again.
 */
async function clearMuseConfig(sandbox: Sandbox, sandboxName: string): Promise<void> {
  const marker = await sandbox.readFileToBuffer({ path: MUSE_FULL_MARKER }).catch(() => null);
  if (!marker) return;
  const script = [
    `rm -rf -- ${museConfigFiles({ mcpUrl: null }).remove.map(q).join(" ")} || exit 1`,
    `PATH="$HOME/.local/bin:$PATH" ${WORKFLOW_SKILL_OFF}`,
    `rm -f -- ${q(MUSE_FULL_MARKER)}`,
  ].join("\n");
  const res = await sh(sandbox, script, { env: { ...SANDBOX_ENV }, allowFail: true }).catch((err: unknown) => ({
    exitCode: -1,
    stdout: "",
    stderr: String(err),
  }));
  if (res.exitCode !== 0) console.warn(`Muse Code config cleanup on ${sandboxName}: exit ${res.exitCode}: ${res.stderr.slice(-500)}`);
}

/**
 * Starts one Muse Code round detached and returns at once: on the session bridge over `muse serve` (MUSE_ENGINE=serve,
 * docs/MUSE_CODE_FULL.md) or as `muse exec --json`. Under MUSE_FULL both get the platform's settings, hooks and build
 * MCP server. A bridge that can't install its SDK, or ends before Muse Code takes the prompt, leaves the round to exec,
 * with a notice saying so.
 */
export async function startMuse(input: StartMuseInput): Promise<MuseStart> {
  if (!isSessionId(input.sessionId)) throw new Error(`sessionId must be a UUID, got ${input.sessionId}`);
  const promptFile = productPath(input.promptFile).slice(PRODUCT_DIR.length + 1);
  const images = input.images.map((img) => productPath(img).slice(PRODUCT_DIR.length + 1));
  const tag = `muse-r${input.round}`;

  const sandbox = await openSandbox(input.sandboxName);
  await ensureTime(sandbox, input.capMs ? Math.max(LONG_WORK_MS, input.capMs + POLL_WORK_MS) : LONG_WORK_MS);
  const running = await runningCommand(sandbox, tag);
  if (running) {
    const engine = await roundEngine(sandbox, input.round);
    return { cmdId: running, logPath: engine === "serve" ? bridgePaths(input.round).log : `${LOG_DIR}/${tag}.jsonl`, engine };
  }

  const full = env.museFull;
  const run: MuseRunSpec = { ...input, promptFile, images, tag, full, token: full ? buildMcpTokenFor(input) : null };
  if (full) await writeMuseConfig(sandbox, run);
  else await clearMuseConfig(sandbox, input.sandboxName);
  const buildMcp = Boolean(run.token);
  let notice: string | undefined;
  if ((input.engine ?? env.museEngine) === "serve") {
    const bridge = await startBridge(sandbox, run);
    if ("cmdId" in bridge) return { ...bridge, engine: "serve", buildMcp };
    notice = bridge.notice;
    console.warn(`Muse Code on ${input.sandboxName}, round ${input.round}: ${notice}`);
  }
  return { ...(await startExec(sandbox, run)), engine: "exec", buildMcp, ...(notice ? { notice } : {}) };
}

/** Starts `muse exec --json` detached, writing JSONL to the round's log. */
async function startExec(sandbox: Sandbox, run: MuseRunSpec): Promise<{ cmdId: string; logPath: string }> {
  const logPath = `${LOG_DIR}/${run.tag}.jsonl`;
  const argv = ["muse", ...museExecArgs({ promptFile: run.promptFile, sessionId: run.sessionId, model: run.model, maxModelSteps: run.maxModelSteps })];
  const prelude = [
    // Keep an earlier run's log under another name (a refinement can reuse round numbers) for the transcript highlights.
    `[ -s ${q(logPath)} ] && mv ${q(logPath)} ${q(`${LOG_DIR}/${run.tag}`)}.$(date +%s).jsonl`,
    // A persistent product sandbox keeps the Muse Code it was made with, which may not have these yet.
    optionalFlagsPrelude(),
    optionalConfigPrelude([...roundSettings(run.full, run.model), backgroundModelSetting(run.model)], CHECKED_MUSE_VERSION),
    ...(run.full ? [WORKFLOW_SKILL_PRELUDE] : []),
    ...run.images.map((img) => `[ -f ${q(img)} ] && cmd+=(--image ${q(img)})`),
    "true",
  ].join("\n");
  const script = await writeRunner(sandbox, {
    name: run.tag,
    cwd: PRODUCT_DIR,
    env: runnerEnv(run),
    argv,
    prelude,
    stdoutPath: logPath,
    stderrPath: `${LOG_DIR}/${run.tag}.err`,
  });
  const cmd = await sandbox.runCommand({ cmd: "bash", args: [script], detached: true });
  await recordCommand(sandbox, run.tag, cmd.cmdId, logPath, "exec");
  return { cmdId: cmd.cmdId, logPath };
}

/**
 * Bash run before a bridge starts: sets the round's earlier bridge log aside and empties its mailbox (refinements can
 * reuse round numbers), clears Muse Code's copy of the model catalog, then installs @muse-code/sdk at MUSE_SDK_VERSION
 * under BRIDGE_DIR unless it is already there. npm reaches the registry through the build firewall.
 */
export function bridgePrepareScript(round: number): string {
  const paths = bridgePaths(round);
  const sdk = `@muse-code/sdk@${MUSE_SDK_VERSION}`;
  const installed = `process.exit(require("./node_modules/@muse-code/sdk/package.json").version === ${JSON.stringify(MUSE_SDK_VERSION)} ? 0 : 1)`;
  return [
    "set -e",
    `mkdir -p ${q(BRIDGE_DIR)} ${q(LOG_DIR)}`,
    `if [ -s ${q(paths.log)} ]; then mv ${q(paths.log)} "${LOG_DIR}/muse-r${Math.max(0, Math.floor(round))}.msp.$(date +%s).jsonl"; fi`,
    `rm -f ${q(`${paths.err}.exit`)}`,
    `rm -rf ${q(paths.mailbox)}`,
    `mkdir -p ${q(paths.mailbox)}`,
    `rm -rf ${MODEL_CATALOG_CACHE}`,
    `cd ${q(BRIDGE_DIR)}`,
    `if node -e ${q(installed)} 2>/dev/null; then exit 0; fi`,
    `[ -f package.json ] || printf '%s\\n' '{"name":"musemuse-bridge","private":true}' > package.json`,
    `npm install --no-audit --no-fund --loglevel=error --no-save ${q(sdk)}`,
  ].join("\n");
}

/**
 * Waits for a bridge that just started to have Muse Code take the prompt (its `turn` record), reading its log in the
 * sandbox. Resolves true once it has, or when it is still going after BRIDGE_START_PROBE_S; otherwise why it couldn't
 * start: it ended before then, with its exit record (whatever the code: nothing ran) or without one.
 */
async function bridgeStarted(sandbox: Sandbox, round: number): Promise<true | string> {
  const paths = bridgePaths(round);
  const exitFile = `${paths.err}.exit`;
  const script = [
    `for i in $(seq 1 ${BRIDGE_START_PROBE_S * 2}); do`,
    // The runner's exit file, then the exit record, then the turn record: the bridge writes them in the other order,
    // so whichever came first is already there when a later one is read.
    `  ended=; [ -f ${q(exitFile)} ] && ended=1`,
    `  line=$(grep '"kind":"bridge","event":"exit"' ${q(paths.log)} 2>/dev/null | tail -n 1)`,
    `  if grep -q '"kind":"bridge","event":"turn"' ${q(paths.log)} 2>/dev/null; then echo turn; exit 0; fi`,
    `  if [ -n "$line" ]; then printf 'exit %s\\n' "$line"; exit 0; fi`,
    `  if [ -n "$ended" ]; then printf 'ended %s\\n' "$(cat ${q(exitFile)})"; exit 0; fi`,
    "  sleep 0.5",
    "done",
    "echo waiting",
  ].join("\n");
  const res = await sh(sandbox, script, { allowFail: true, timeoutMs: (BRIDGE_START_PROBE_S + 20) * 1000 }).catch((err: unknown) => {
    console.warn(`bridge start check: ${String(err)}`);
    return null;
  });
  const out = res?.stdout.trim() ?? "";
  if (out.startsWith("exit ")) {
    let reason: unknown;
    try {
      reason = (JSON.parse(out.slice("exit ".length)) as { reason?: unknown }).reason;
    } catch {
      reason = null;
    }
    return typeof reason === "string" && reason ? noEmDashes(reason).slice(0, 300) : "it ended before Muse Code took the prompt";
  }
  if (out.startsWith("ended ")) {
    const err = (await tailText(sandbox, paths.err, 1500).catch(() => "")).trim().split("\n").pop() ?? "";
    return `it stopped with code ${out.slice("ended ".length).trim() || "unknown"}${err ? `: ${noEmDashes(err).slice(0, 300)}` : ""}`;
  }
  // Taken, still starting, or the check itself didn't answer: the polls take it from here.
  return true;
}

/** Starts the session bridge detached (lib/sandbox/bridge/bridge.mjs), or says why this round can't run on it. */
async function startBridge(sandbox: Sandbox, run: MuseRunSpec): Promise<{ cmdId: string; logPath: string } | { notice: string }> {
  const paths = bridgePaths(run.round);
  const prepared = await sh(sandbox, bridgePrepareScript(run.round), { allowFail: true, timeoutMs: SDK_INSTALL_MS }).catch((err: unknown) => ({
    exitCode: -1,
    stdout: "",
    stderr: String(err),
  }));
  if (prepared.exitCode !== 0) {
    console.warn(`session bridge setup on ${run.sandboxName}: exit ${prepared.exitCode}: ${prepared.stderr.slice(-800)}`);
    return { notice: "The session bridge couldn't install its SDK, so this round runs on muse exec." };
  }
  const config: BridgeConfig = {
    workspace: PRODUCT_DIR,
    sessionId: run.sessionId,
    model: run.model,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    promptFile: `${PRODUCT_DIR}/${run.promptFile}`,
    images: run.images.map((img) => `${PRODUCT_DIR}/${img}`),
    goal: run.goal?.trim() || null,
    // Every round turns web search off, as exec's --disable-web-tools does; MUSE_FULL adds its own settings.
    settings: [...SERVE_SETTINGS, ...roundSettings(run.full, run.model), backgroundModelSetting(run.model)],
    disableRequestUserInput: true,
    logPath: paths.log,
    mailboxDir: paths.mailbox,
    maxModelSteps: run.maxModelSteps ?? DEFAULT_MAX_MODEL_STEPS,
    idleExitMs: BRIDGE_IDLE_EXIT_MS,
  };
  const configPath = bridgeConfigPath(run.round);
  await sandbox.writeFiles([
    { path: BRIDGE_SCRIPT, content: BRIDGE_SOURCE },
    { path: configPath, content: `${JSON.stringify(config, null, 2)}\n` },
  ]);
  const script = await writeRunner(sandbox, {
    name: run.tag,
    cwd: PRODUCT_DIR,
    env: runnerEnv(run),
    argv: ["node", BRIDGE_SCRIPT, configPath],
    prelude: run.full ? `${WORKFLOW_SKILL_PRELUDE}\ntrue` : undefined,
    // The bridge writes its own log. Its stdout and stderr are only for a crash.
    stdoutPath: paths.err,
  });
  const cmd = await sandbox.runCommand({ cmd: "bash", args: [script], detached: true });
  await recordCommand(sandbox, run.tag, cmd.cmdId, paths.log, "serve");
  const started = await bridgeStarted(sandbox, run.round);
  if (started === true) return { cmdId: cmd.cmdId, logPath: paths.log };
  return { notice: `The session bridge didn't start (${started}), so this round runs on muse exec.` };
}

/** `<at>-<id>.json`: the bridge reads its mailbox in name order, so the time leads, in ISO form. */
export function mailboxFileName(envelope: MuseCommandEnvelope): string {
  if (typeof envelope.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(envelope.id)) throw new Error("A command id is 1 to 80 letters, digits, - or _.");
  const at = new Date(envelope.at);
  if (Number.isNaN(at.getTime())) throw new Error(`A command's time must be an ISO time, got ${String(envelope.at)}`);
  return `${at.toISOString()}-${envelope.id}.json`;
}

/** Writes `body` to dir/name in one sandbox command, through a dot-file the readers skip, so no reader sees half of it. */
async function dropFile(sandbox: Sandbox, dir: string, name: string, body: string): Promise<void> {
  const tmp = `${dir}/.${name}.tmp`;
  const b64 = Buffer.from(body, "utf8").toString("base64");
  await sh(sandbox, `mkdir -p ${q(dir)} && printf '%s' ${q(b64)} | base64 -d > ${q(tmp)} && mv -f ${q(tmp)} ${q(`${dir}/${name}`)}`);
}

/**
 * sendMuseCommand's refusal of a command for a round that has finished (or never started): nothing reads its mailbox
 * any more, so the command isn't written. The control route answers it as it does a build with no round.
 */
export class MuseRoundEndedError extends Error {
  constructor() {
    super("This round of Muse Code has finished, so the command wasn't sent.");
    this.name = "MuseRoundEndedError";
  }
}

/**
 * Sends a running round one of its owner's commands (docs/MUSE_CODE_FULL.md, "The owner steers"). `round` is the
 * number startMuse got. On the session bridge, the envelope goes into bridgePaths(round).mailbox as one JSON file,
 * which the bridge applies once, in name order, and logs as a `command` record. On exec, a steer or a queued note goes
 * to NOTES_DIR for the notes hook (MUSE_FULL only), an interrupt or end stops the run as killCommand does, and the
 * rest can't be done. The sandbox must be running, and so must the round: this never wakes a stopped sandbox, and a
 * command for a round that has finished is refused rather than left where nothing reads it.
 */
export async function sendMuseCommand(input: {
  sandboxName: string;
  round: number;
  envelope: MuseCommandEnvelope;
  /** The engine startMuse reported for the round. Read from the sandbox when unset. */
  engine?: MuseEngine;
}): Promise<void> {
  const name = mailboxFileName(input.envelope);
  const body = JSON.stringify(input.envelope);
  if (Buffer.byteLength(body) > MAX_COMMAND_BYTES) throw new Error("That command is too long to send.");
  const round = Math.max(0, Math.floor(input.round));
  const sandbox = await Sandbox.get({ name: input.sandboxName });
  if (sessionStatus(sandbox) !== "running") throw new Error("The build's sandbox isn't running, so the command wasn't sent.");
  const engine = input.engine ?? (await roundEngine(sandbox, round));
  const command = input.envelope.command;
  const note = command.type === "steer" || command.type === "queue" ? command.text : null;
  const stop = command.type === "interrupt" || command.type === "end";
  if (engine === "exec" && note === null && !stop) throw new Error(`This round runs on muse exec, which can't take a ${command.type} command.`);
  // Without MUSE_FULL there is no notes hook to deliver them.
  if (engine === "exec" && note !== null && !env.museFull) throw new Error("Notes reach a muse exec round only with MUSE_FULL on.");
  const cmdId = await runningCommand(sandbox, `muse-r${round}`);
  if (!cmdId) throw new MuseRoundEndedError();

  if (engine === "serve") return dropFile(sandbox, bridgePaths(round).mailbox, name, body);
  if (stop) return killCommand(input.sandboxName, cmdId);
  const { id, at, by } = input.envelope;
  return dropFile(sandbox, NOTES_DIR, name, JSON.stringify({ id, at, by, kind: command.type, text: note }));
}

export interface MusePoll {
  done: boolean;
  exitCode: number | null;
  /** Byte offset to pass to the next poll. */
  offset: number;
  /** New condensed log lines since the last poll (see the table in docs/SPIKES.md). */
  lines: MuseLogLine[];
  /**
   * From run.usage, priced with lib/meta/pricing.ts. Muse Code emits it once per run, just before the run ends, so it
   * is non-empty in the poll that reads it: record it when it appears. Empty until then. The session bridge is charged
   * from `session` instead, so it is empty there too, except in a done poll whose session log gave no main agent calls:
   * then it holds the calls the session host reported (bridgeTokenUsage).
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
   * Read once, in the poll that reports done, from Muse Code's session log: what the reminder agents, subagents and
   * workflow agents used, which run.usage leaves out unless childrenIncluded is true, and the main agent's calls in runs
   * that never wrote run.usage (`unreported`: a run stopped at its cap, and every session bridge run). Missing when the
   * log couldn't be read.
   */
  session?: Pick<SessionUsage, "main" | "unreported" | "children">;
  /** The session bridge's condenser state. Pass it to the next poll as `bridgeState`. Serve rounds only. */
  bridgeState?: BridgeCondenseState;
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

/**
 * The complete lines a log gained since `offset` (at most POLL_CAP_BYTES), and how many bytes they used. A finished
 * command's last line counts even without its newline.
 */
async function readNewLines(sandbox: Sandbox, logPath: string, offset: number, finished: boolean) {
  const chunk = await readBytes(sandbox, logPath, offset, POLL_CAP_BYTES);
  const atEof = chunk.length < POLL_CAP_BYTES;
  let { lines, consumed } = completeLines(chunk);
  const extra: MuseLogLine[] = [];
  if (consumed === 0 && !atEof) {
    // One line longer than the cap. Skip it rather than stall; the next chunk starts mid-line and that part is dropped.
    consumed = chunk.length;
    lines = [];
    extra.push({ kind: "status", text: "Skipped a log entry over 1 MB" });
  }
  if (finished && atEof && consumed < chunk.length) {
    lines.push(chunk.subarray(consumed).toString("utf8"));
    consumed = chunk.length;
  }
  return { lines, consumed, atEof, extra };
}

/**
 * Reads new log lines since `offset` and reports whether the round finished. A serve round's log is the session
 * bridge's (BridgeLogRecord lines, condensed by lib/sandbox/msp-log.ts), an exec round's is `muse exec --json`.
 */
export async function pollMuse(input: {
  sandboxName: string;
  cmdId: string;
  logPath: string;
  offset: number;
  /** The last poll's `announced`, so helper agents get one line per run. */
  announced?: string[];
  /** The last poll's `childrenIncluded`, since run.usage may arrive before the poll that reports done. */
  childrenIncluded?: boolean | null;
  /** The engine startMuse reported. Without it, a session bridge log is known by its name. */
  engine?: MuseEngine;
  /** The last poll's `bridgeState`, on the session bridge. */
  bridgeState?: BridgeCondenseState;
}): Promise<MusePoll> {
  const sandbox = await openSandbox(input.sandboxName);
  const engine = input.engine ?? (input.logPath.endsWith(".msp.jsonl") ? "serve" : "exec");
  if (engine === "serve") return pollBridge(sandbox, input);
  // Check the command first, then read: a run that ends between the two is reported done on the next poll.
  const state = await commandState(sandbox, input.cmdId, input.logPath);
  if (!state.finished) await ensureTime(sandbox, POLL_WORK_MS);

  const { lines, consumed, atEof, extra } = await readNewLines(sandbox, input.logPath, input.offset, state.finished);
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
    ...(session ? { session: { main: session.main, unreported: session.unreported, children: session.children } } : {}),
  };
}

/**
 * pollMuse for a session bridge round. The round is done once a poll reads the bridge's exit record, its last line,
 * or when the bridge ended without one. The agent can write to this log too, so an exit record only says to look: a
 * real bridge exits right after writing it, and one whose command is still running is stopped here, so the round's
 * cap, its Stop and its charges never end while it goes on. The exit code is the command's whenever it has one.
 *
 * Its calls are charged from the session log, read in the poll that reports done. When that log can't be read or has
 * none of the main agent's calls, `usage` holds the calls the session host reported instead, so a round is never free.
 */
async function pollBridge(
  sandbox: Sandbox,
  input: { sandboxName: string; cmdId: string; logPath: string; offset: number; announced?: string[]; bridgeState?: BridgeCondenseState },
): Promise<MusePoll> {
  // The runner's own output, and its exit code file, sit beside the bridge's log (bridgePaths(round).err).
  const errPath = input.logPath.replace(/\.jsonl$/, ".err");
  let state = await commandState(sandbox, input.cmdId, errPath);
  if (!state.finished) await ensureTime(sandbox, POLL_WORK_MS);

  const { lines, consumed, atEof, extra } = await readNewLines(sandbox, input.logPath, input.offset, state.finished);
  const condensed = condenseBridgeLines(lines, input.bridgeState ?? { ...emptyBridgeState(), announced: [...(input.announced ?? [])] });
  let falseExit = false;
  if (condensed.exit && !state.finished) {
    // Checked before the log was read, so a real bridge may have exited since.
    state = await commandState(sandbox, input.cmdId, errPath);
    if (!state.finished) {
      falseExit = true;
      await killCommand(input.sandboxName, input.cmdId);
      state = await commandState(sandbox, input.cmdId, errPath);
      extra.push({ kind: "error", ok: false, text: "The session bridge's log said the round had ended while it was still running, so it was stopped." });
    }
  }
  const done = condensed.exit !== null || (state.finished && atEof);
  const session = done ? await readSessionUsage(sandbox, input.logPath) : null;
  if (session?.children.calls) extra.push(childUsageLine(session.children));
  const reported = done && !session?.main.calls ? bridgeTokenUsage(condensed.state) : null;
  if (reported?.calls) {
    const why = session ? "has none of its main agent's calls" : "couldn't be read";
    console.warn(`Muse Code round ${input.logPath}: the session log ${why}, charging the ${reported.calls} calls the session host reported`);
    extra.push({ kind: "status", text: `Muse Code's session log ${why}, so this round is charged from the ${reported.calls} model call${reported.calls === 1 ? "" : "s"} its session host reported.` });
  }
  if (done && !condensed.exit) {
    const err = (await tailText(sandbox, errPath, 4000))
      .split("\n")
      .filter((l) => l.trim())
      .join("\n")
      .slice(-1500);
    const code = state.exitCode === null ? "no exit code (the sandbox restarted)" : `code ${state.exitCode}`;
    extra.push({ kind: "error", ok: false, text: `The session bridge stopped before it finished, with ${code}${err ? `: ${err}` : ""}` });
  }
  // A false exit record's code counts for nothing, even while its bridge is still going down.
  const recorded = falseExit ? null : (condensed.exit?.code ?? null);
  return {
    done,
    exitCode: done ? (state.exitCode ?? recorded) : null,
    offset: input.offset + consumed,
    lines: [...(falseExit ? condensed.lines.filter((l) => l.kind !== "done") : condensed.lines), ...extra],
    usage: reported?.usage ?? [],
    finalText: falseExit ? null : condensed.finalText,
    announced: condensed.state.announced,
    childrenIncluded: null,
    bridgeState: condensed.state,
    ...(session ? { session: { main: session.main, unreported: session.unreported, children: session.children } } : {}),
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
 * <task>.log, stdout alone to <task>.out. `env` is exported for the task, like MUSEMUSE_SCREEN_CHECK=warn.
 */
export async function startTask(sandboxName: string, task: SandboxTask, env?: Record<string, string>): Promise<{ cmdId: string }> {
  const sandbox = await openSandbox(sandboxName);
  await ensureTime(sandbox, LONG_WORK_MS);
  const running = await runningCommand(sandbox, task);
  if (running) return { cmdId: running };

  const logPath = `${LOG_DIR}/${task}.log`;
  const outPath = `${LOG_DIR}/${task}.out`;
  const script = await writeRunner(sandbox, {
    name: task,
    cwd: PRODUCT_DIR,
    env,
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
  /** FULL_BUILDS: more than MAX_SCREENSHOTS, since each requirement has its own. */
  maxScreenshots?: number;
}): Promise<{ summary: VerifySummary; screenshots: Screenshot[] }> {
  const sandbox = await openSandbox(input.sandboxName);
  const stdout = await tailText(sandbox, `${LOG_DIR}/verify.out`, 64 * 1024);
  const tail = input.outputTail || (await tailText(sandbox, `${LOG_DIR}/verify.log`, 8000));
  const summary = verifyOutcome(parseVerifySummary(stdout), input.exitCode, tail);

  const judgeDir = `${PRODUCT_DIR}/test-results/judge`;
  const all = await listFiles(sandbox, judgeDir, "*.png");
  // The first one and the last ones, so the judge's final screen is the one verify's final screen check read.
  const most = input.maxScreenshots ?? MAX_SCREENSHOTS;
  const names = all.length > most ? [all[0], ...all.slice(1 - most)] : all;
  // judgeShot's VR branch leaves "xr":true next to its pictures, and the judge should know what kind of picture it sees.
  const inVR = await sh(sandbox, `cd ${q(judgeDir)} 2>/dev/null && grep -l '"xr":true' *.checked 2>/dev/null || true`);
  const vrViews = new Set(inVR.stdout.split("\n").map((l) => l.trim().replace(/\.checked$/, ".png")));
  const screenshots: Screenshot[] = [];
  for (const name of names) {
    const file = `${judgeDir}/${name}`;
    const caption = vrViews.has(name) ? `${captionFromFileName(name)} (VR view)` : captionFromFileName(name);
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
  spec: Pick<DemoStudioSpec, "title" | "tagline" | "models" | "url" | "note">,
): Promise<DemoStudioSpec> {
  const full: DemoStudioSpec = {
    title: noEmDashes(spec.title).trim() || "Untitled",
    tagline: noEmDashes(spec.tagline).trim(),
    models: [...new Set(spec.models.map((m) => m.trim()).filter(Boolean))],
    url: spec.url,
    ...(spec.note ? { note: noEmDashes(spec.note).trim() } : {}),
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
  // A VR product recorded this way still has to say how. writeDemoSpec puts the note in the spec before the demo runs.
  const note = (await readJson<{ note?: unknown }>(sandbox, DEMO_SPEC_PATH))?.note;
  const noteFile = typeof note === "string" && note ? `${dir}/note.txt` : null;
  if (noteFile) files.push({ path: noteFile, content: String(note) });
  const graph = demoFilterGraph({
    title: block("title", input.title || "Untitled", 34, 2),
    subtitle: block("subtitle", input.subtitle, 64, 3),
    footerFile,
    noteFile,
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

/** True when the product's footer still shows the Contributor notice (template/components/Footer.tsx) for its env switch. */
export async function productShowsContributorNotice(sandboxName: string): Promise<boolean> {
  const sandbox = await openSandbox(sandboxName);
  const buf = await sandbox.readFileToBuffer({ path: `${PRODUCT_DIR}/components/Footer.tsx` }).catch(() => null);
  return Boolean(buf?.toString("utf8").includes("MUSE_CONTRIBUTOR_NOTICE"));
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
 * the first line, so highlights don't have to pull megabytes of tool output out of the VM. A session bridge log's
 * finished tool calls are printed in the same `muse exec --json` shape.
 */
export const HIGHLIGHTS_FILTER = `
const fs = require("node:fs");
const dir = process.argv[2];
const files = fs.readdirSync(dir).filter((f) => /^muse-.*\\.jsonl$/.test(f))
  .map((f) => ({ f, t: fs.statSync(dir + "/" + f).mtimeMs })).sort((a, b) => a.t - b.t);
for (const { f } of files) {
  for (const line of fs.readFileSync(dir + "/" + f, "utf8").split("\\n")) {
    if (line.startsWith('{"t":')) {
      if (!line.includes('"item/completed"') || !line.includes('"toolCall"')) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      const item = (r && r.kind === "note" && r.params && r.params.item) || {};
      if (item.kind !== "toolCall") continue;
      let args = {}; try { args = JSON.parse(item.args || "{}") || {}; } catch { args = {}; }
      const text = String(item.visibleOutput || item.fallbackText || "").split("\\n").find((l) => l.trim()) || "";
      const edit = item.patchSummary && typeof args.path === "string" ? { path: args.path } : undefined;
      const facts = { tool_name: item.tool || "tool", outcome: item.status === "completed" ? "success" : "failure" };
      console.log(JSON.stringify({ payload_type: "tool.result", payload: { correlation_facts: facts, edit_facts: edit, text } }));
      if (item.patchSummary) console.log(JSON.stringify({ payload_type: "task.lifecycle.tool_output_ref", payload: { event: { output_ref: { kind: "tool_patch", patch_summary: item.patchSummary } } } }));
      continue;
    }
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

/** CHAINED_BUILDS: writes the chain's state file and commits the session's work, so the next session starts from the repo. */
export async function saveChainState(sandboxName: string, stateFile: string, content: string, message: string): Promise<void> {
  const sandbox = await openSandbox(sandboxName);
  await sandbox.writeFiles([{ path: productPath(stateFile), content }]);
  await sh(sandbox, `git add -A && (git diff --cached --quiet || git commit -qm ${q(message)})`, { cwd: PRODUCT_DIR, timeoutMs: 2 * MIN });
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
