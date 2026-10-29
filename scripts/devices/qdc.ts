/**
 * Runs the device kit on Qualcomm Device Cloud phones (docs/DEVICES.md "On Qualcomm Device Cloud" and "How to run > QDC"):
 *
 *   npx tsx scripts/devices/qdc.ts check                          is a QDC key saved (no QDC call)
 *   npx tsx scripts/devices/qdc.ts targets                        QDC's Android phones, their chipsets and probes
 *   npx tsx scripts/devices/qdc.ts plan                           the batch devices/qdc/targets.json gives (calls nothing)
 *   npx tsx scripts/devices/qdc.ts run --yes                      build the zips, submit, wait, download, write results
 *   npx tsx scripts/devices/qdc.ts probe --chipset SM8750 --yes   the smoke job that records a chipset's RAM
 *   npx tsx scripts/devices/qdc.ts fetch <job id>                 a job's logs again, and its results
 *
 * More flags: --chipsets SM8850,SM8750 (the default is all three), --subjects <id>,<id> (instead of the picks),
 * --tuned <ns>/muse-glimmer-30b-<slug>-gguf-<job8> (a tuned repo's files instead of the stand-ins), --max-jobs <n>
 * (3, at most 10), --again (also pairs that already have a result), --backends cpu,gpu,npu, --keep-zips.
 *
 * Every QDC call is devices/qdc/submit.py's, in a uv venv in the cache (Python 3.12, the SDK wheel from Qualcomm's zip,
 * both checked against QDC_SDK, and submit-requirements.txt installed with --require-hashes). The key never passes
 * through this script: submit.py reads it from QDC_API_KEY or ~/.config/qdc/api.env. Without --yes nothing is built
 * or submitted: the plan, the estimate and the exact command are printed.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  QDC_BUILD_DIRS,
  QDC_BUILDS,
  QDC_CARRIER_FILES,
  QDC_CHIPSET_NAMES,
  QDC_CHIPSETS,
  QDC_MAX_JOBS_DEFAULT,
  QDC_MAX_JOBS_LIMIT,
  carrierNotes,
  filesHolding,
  isPhoneTarget,
  packFile,
  parseKeyValues,
  parseProbes,
  planQdcJobs,
  probeFromDevice,
  probesText,
  qdcLlamaZipPath,
  qdcManifest,
  qdcPlanFiles,
  qdcPlanText,
  qdcZipMissing,
  readJobRecord,
  readTargets,
  stampOfRunKey,
  unzipBytes,
  withProbe,
  zipBytes,
  type PackedFile,
  type QdcBuild,
  type QdcJob,
  type QdcJobRecord,
  type QdcPlan,
  type QdcProbe,
  type ZipFile,
} from "@/lib/devices/qdc";
import { parseKitOutput, readResult, writeResult } from "@/lib/devices/result";
import {
  LLAMA_TAG,
  QDC_SDK,
  SMOKE,
  STAND_INS,
  deviceSlug,
  fetchTunedSubjects,
  llamaAsset,
  marketedRamGiB,
  repoFileUrl,
  subjectById,
  utcStamp,
} from "@/lib/devices/subjects";
import { BACKENDS, type Backend, type Result, type Subject } from "@/lib/devices/types";
import { cacheDir, downloadVerified, extractKept, fileMatches } from "./local";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SUBMIT = path.join("devices", "qdc", "submit.py");
const TARGETS = path.join("devices", "qdc", "targets.json");

export type QdcCommand = "check" | "targets" | "plan" | "run" | "probe" | "fetch";

export interface QdcArgs {
  command: QdcCommand | null;
  yes: boolean;
  chipsets: string[];
  /** probe: the one chipset. */
  chipset: string | null;
  subjects: string[] | null;
  tuned: string | null;
  maxJobs: number;
  again: boolean;
  backends: Backend[];
  /** fetch: QDC's job id. */
  jobId: string | null;
  keepZips: boolean;
  help: boolean;
}

export const USAGE = `Usage: npx tsx scripts/devices/qdc.ts <check|targets|plan|run|probe|fetch> [flags]
  plan | run --yes          [--chipsets SM8850,SM8750,SM8650] [--subjects <id>,<id>] [--tuned <repo>] [--max-jobs 3]
                            [--again] [--backends cpu,gpu,npu] [--keep-zips]
  probe --chipset <name> [--yes]
  fetch <job id> [--tuned <repo>]`;

export function parseQdcArgs(argv: readonly string[]): QdcArgs {
  const args: QdcArgs = {
    command: null,
    yes: false,
    chipsets: [...QDC_CHIPSETS],
    chipset: null,
    subjects: null,
    tuned: null,
    maxJobs: QDC_MAX_JOBS_DEFAULT,
    again: false,
    backends: [...BACKENDS],
    jobId: null,
    keepZips: false,
    help: false,
  };
  const value = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value.\n${USAGE}`);
    return v;
  };
  const chipsetList = (text: string) => {
    const list = text.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
    for (const c of list) if (!/^[A-Z0-9_]{2,20}$/.test(c)) throw new Error(`Not a chipset name: ${c}`);
    if (list.length === 0) throw new Error("--chipsets names no chipset.");
    return list;
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--yes":
        args.yes = true;
        break;
      case "--chipsets":
        args.chipsets = chipsetList(value(i++, flag));
        break;
      case "--chipset":
        [args.chipset] = chipsetList(value(i++, flag));
        break;
      case "--subjects":
        args.subjects = value(i++, flag).split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--tuned":
        args.tuned = value(i++, flag);
        break;
      case "--max-jobs": {
        const n = Number(value(i++, flag));
        if (!Number.isInteger(n) || n < 1 || n > QDC_MAX_JOBS_LIMIT) throw new Error(`--max-jobs must be 1 to ${QDC_MAX_JOBS_LIMIT}.`);
        args.maxJobs = n;
        break;
      }
      case "--again":
        args.again = true;
        break;
      case "--backends": {
        const list = value(i++, flag).split(",").map((b) => b.trim());
        for (const b of list) if (!(BACKENDS as readonly string[]).includes(b)) throw new Error(`Not a backend: ${b}`);
        args.backends = list as Backend[];
        break;
      }
      case "--keep-zips":
        args.keepZips = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        if (flag.startsWith("--")) throw new Error(`Unknown flag ${flag}.\n${USAGE}`);
        positional.push(flag);
    }
  }
  const [command, ...rest] = positional;
  if (command !== undefined) {
    if (!["check", "targets", "plan", "run", "probe", "fetch"].includes(command)) throw new Error(`Unknown command ${command}.\n${USAGE}`);
    args.command = command as QdcCommand;
  }
  if (args.command === "fetch") {
    if (rest.length !== 1 || !/^[0-9]{1,20}$/.test(rest[0])) throw new Error(`fetch takes one QDC job id (a number).\n${USAGE}`);
    args.jobId = rest[0];
  } else if (rest.length > 0) {
    throw new Error(`Unexpected ${rest.join(" ")}.\n${USAGE}`);
  }
  if (args.command === "probe" && !args.chipset) throw new Error(`probe needs --chipset <name>.\n${USAGE}`);
  if (args.subjects && args.subjects.length === 0) throw new Error("--subjects names no subject.");
  return args;
}

// ---------------------------------------------------------------------------------------------------------------
// Running things (tests replace these)

/** An environment as a plain record (Next.js's types make NODE_ENV required on NodeJS.ProcessEnv). */
export type Env = Record<string, string | undefined>;

export interface ExecResult {
  code: number;
  stdout: string;
}

/** Runs a program with exactly `env`: stdin closed, stderr to the terminal, stdout captured or shown. */
export type Exec = (cmd: string, args: readonly string[], options: { env: Env; capture: boolean; cwd?: string }) => Promise<ExecResult>;

export const exec: Exec = (cmd, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: options.env as NodeJS.ProcessEnv,
      cwd: options.cwd,
      stdio: ["ignore", options.capture ? "pipe" : "inherit", "inherit"],
    });
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (c: Buffer) => chunks.push(c));
    // Ctrl-C reaches the child too: submit.py then aborts its jobs, and this waits for it to say so.
    const onInterrupt = () => console.error("[qdc] Waiting for the child to finish what it started.");
    process.on("SIGINT", onInterrupt);
    child.on("error", (err) => {
      process.off("SIGINT", onInterrupt);
      reject(err);
    });
    child.on("close", (code, signal) => {
      process.off("SIGINT", onInterrupt);
      resolve({ code: code ?? (signal ? 128 + (os.constants.signals[signal] ?? 1) : 1), stdout: Buffer.concat(chunks).toString("utf8") });
    });
  });

export interface QdcDeps {
  exec?: Exec;
  fetchImpl?: typeof fetch;
  repoRoot?: string;
  /** The cache (MM_DEVICES_CACHE or ~/.cache/muse-muse-devices); QDC's things go in <cache>/qdc. */
  cache?: string;
  now?: () => Date;
  say?: (line: string) => void;
  /** The trimmed Android builds by build (their llama-b11669/ folders); downloads the pinned archives by default. */
  stageBuilds?: (cache: string) => Promise<Record<QdcBuild, string>>;
  env?: Env;
}

/** The environment a child gets: what it needs to run and reach the network, never a token (QDC_API_KEY only for submit.py). */
export function childEnv(env: Env, withQdcKey: boolean): Env {
  const keep = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "UV_CACHE_DIR"];
  const out: Env = { PYTHONDONTWRITEBYTECODE: "1" };
  for (const name of keep) if (env[name] !== undefined) out[name] = env[name];
  if (withQdcKey && env.QDC_API_KEY) out.QDC_API_KEY = env.QDC_API_KEY;
  return out;
}

/** Values in the environment that must never be in a zip: tokens, keys, passwords, AWS credentials. */
export function secretValues(env: Env): string[] {
  return Object.entries(env)
    .filter(([name, value]) => value && value.length >= 8 && /(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIAL)/i.test(name))
    .map(([, value]) => value as string);
}

// ---------------------------------------------------------------------------------------------------------------
// The Python side: a venv with the pinned SDK

function findUv(env: Env): string {
  for (const dir of (env.PATH ?? "").split(":").filter(Boolean)) {
    if (existsSync(path.join(dir, "uv"))) return path.join(dir, "uv");
  }
  const local = path.join(os.homedir(), ".local", "bin", "uv");
  if (existsSync(local)) return local;
  throw new Error("uv isn't installed (https://docs.astral.sh/uv/); this runner makes its Python venv with it.");
}

function python312(): string {
  return existsSync("/opt/homebrew/bin/python3.12") ? "/opt/homebrew/bin/python3.12" : "3.12";
}

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

/**
 * The venv submit.py runs in, made once: Qualcomm's SDK zip downloaded and checked against QDC_SDK, its wheel taken
 * out and checked, then `uv venv` with Python 3.12, `uv pip install --require-hashes` of submit-requirements.txt and
 * the wheel with --no-deps. Returns the venv's python.
 */
export async function ensureVenv(cache: string, deps: Required<Pick<QdcDeps, "exec" | "fetchImpl" | "say" | "repoRoot" | "env">>): Promise<string> {
  const base = path.join(cache, "qdc");
  const venv = path.join(base, `venv-${QDC_SDK.version}`);
  const python = path.join(venv, "bin", "python");
  const requirements = path.join(deps.repoRoot, "devices", "qdc", "submit-requirements.txt");
  const stamp = sha256(`${QDC_SDK.wheelSha256}\n${readFileSync(requirements, "utf8")}`);
  const marker = path.join(venv, ".mm-ready");
  if (existsSync(python) && existsSync(marker) && readFileSync(marker, "utf8").trim() === stamp) return python;

  const sdkZip = path.join(base, "sdk", path.basename(new URL(QDC_SDK.zipUrl).pathname));
  if (!(await fileMatches(sdkZip, QDC_SDK.zipBytes, QDC_SDK.zipSha256))) {
    deps.say(`Downloading Qualcomm's QDC SDK ${QDC_SDK.version} (${QDC_SDK.zipBytes} bytes).`);
    await downloadVerified(QDC_SDK.zipUrl, sdkZip, QDC_SDK.zipBytes, QDC_SDK.zipSha256, deps.fetchImpl);
  }
  const wheelEntry = unzipBytes(readFileSync(sdkZip)).find((f) => path.posix.basename(f.name) === QDC_SDK.wheel);
  if (!wheelEntry) throw new Error(`${sdkZip} has no ${QDC_SDK.wheel}.`);
  if (wheelEntry.data.length !== QDC_SDK.wheelBytes || sha256(wheelEntry.data) !== QDC_SDK.wheelSha256) {
    throw new Error(`${QDC_SDK.wheel} in Qualcomm's zip doesn't match its pin.`);
  }
  const wheel = path.join(base, "sdk", QDC_SDK.wheel);
  writeFileSync(wheel, wheelEntry.data);

  const uv = findUv(deps.env);
  const env = childEnv(deps.env, false);
  rmSync(venv, { recursive: true, force: true });
  deps.say(`Making the submitter's venv in ${venv}.`);
  const steps: Array<readonly string[]> = [
    ["venv", "--python", python312(), venv],
    ["pip", "install", "--python", python, "--require-hashes", "--only-binary", ":all:", "-r", requirements],
    ["pip", "install", "--python", python, "--no-deps", wheel],
  ];
  for (const step of steps) {
    const { code } = await deps.exec(uv, step, { env, capture: false });
    if (code !== 0) throw new Error(`uv ${step.slice(0, 2).join(" ")} failed (${code}).`);
  }
  writeFileSync(marker, `${stamp}\n`);
  return python;
}

/** Runs submit.py with its arguments in the venv (or `check` with this Mac's Python 3.12, which needs no SDK). */
export async function runSubmit(python: string, argv: readonly string[], deps: Required<Pick<QdcDeps, "exec" | "repoRoot" | "env">>): Promise<ExecResult> {
  return deps.exec(python, ["-I", path.join(deps.repoRoot, SUBMIT), ...argv], { env: childEnv(deps.env, true), capture: true });
}

// ---------------------------------------------------------------------------------------------------------------
// The zips

/** A pinned Android build in the cache, downloaded, checked and trimmed when it isn't there yet. Returns llama-b11669/. */
export async function ensureAndroidBuild(cache: string, build: QdcBuild, fetchImpl: typeof fetch, say: (l: string) => void): Promise<string> {
  const asset = llamaAsset(build);
  const base = path.join(cache, "llama", LLAMA_TAG);
  const dir = path.join(base, asset.build);
  const top = path.join(dir, "llama-b11669");
  const marker = path.join(dir, ".sha256");
  const tool = asset.layout === "bin-lib" ? path.join(top, "bin", "llama-bench") : path.join(top, "llama-bench");
  if (existsSync(marker) && readFileSync(marker, "utf8").trim() === asset.sha256 && existsSync(tool)) return top;
  const archive = path.join(base, asset.name);
  if (!(await fileMatches(archive, asset.bytes, asset.sha256))) {
    say(`Downloading ${asset.name} (${(asset.bytes / 1e6).toFixed(0)} MB) from the llama.cpp ${LLAMA_TAG} release.`);
    await downloadVerified(asset.url, archive, asset.bytes, asset.sha256, fetchImpl);
  }
  const kept = extractKept(archive, dir);
  writeFileSync(marker, `${asset.sha256}\n`);
  say(`Extracted ${kept.length} files of ${asset.name}.`);
  return top;
}

function walk(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(dir, rel)).sort()) {
    if (name.startsWith(".")) continue;
    const r = rel ? `${rel}/${name}` : name;
    const info = statSync(path.join(dir, r));
    if (info.isDirectory()) out.push(...walk(dir, r));
    else if (info.isFile()) out.push(r);
  }
  return out;
}

const TOOL_NAMES = new Set(["llama-bench", "llama-completion", "run.sh"]);

/**
 * Every file a batch's zips share, in zip order: the carrier at the root, mm/kit/ (devices/kit as it is), and both
 * builds in mm/llama-android/ and mm/llama-snapdragon/, trimmed by keepLlamaFile. Tools are 0755, the rest 0644.
 */
export function sharedZipFiles(repoRoot: string, builds: Record<QdcBuild, string>): ZipFile[] {
  const files: ZipFile[] = [];
  const carrier = path.join(repoRoot, "devices", "qdc", "carrier");
  for (const name of QDC_CARRIER_FILES) files.push({ name, data: readFileSync(path.join(carrier, name)), mode: 0o644 });
  const kit = path.join(repoRoot, "devices", "kit");
  for (const rel of walk(kit)) {
    files.push({ name: `mm/kit/${rel}`, data: readFileSync(path.join(kit, rel)), mode: rel === "run.sh" ? 0o755 : 0o644 });
  }
  for (const build of QDC_BUILDS) {
    for (const rel of walk(builds[build])) {
      const name = qdcLlamaZipPath(build, rel);
      if (!name) continue;
      files.push({ name, data: readFileSync(path.join(builds[build], rel)), mode: TOOL_NAMES.has(path.posix.basename(rel)) ? 0o755 : 0o644 });
    }
  }
  return files;
}

/** One job's zip: the shared files (packed once per batch) and the job's own mm/plan/. Checks it is complete and clean. */
export function jobZip(job: QdcJob, shared: readonly ZipFile[], packed: readonly PackedFile[], template: string | undefined, secrets: readonly string[]): Buffer {
  const plan: ZipFile[] = Object.entries(qdcPlanFiles(job, template)).map(([name, text]) => ({
    name: `mm/plan/${name}`,
    data: Buffer.from(text, "utf8"),
    mode: 0o644,
  }));
  const names = [...shared, ...plan].map((f) => f.name);
  const missing = qdcZipMissing(names, [job.subject.id]);
  if (missing.length > 0) throw new Error(`The zip for ${job.name} would lack ${missing.join(", ")}.`);
  const holding = filesHolding([...shared, ...plan], secrets);
  if (holding.length > 0) throw new Error(`Refusing to build ${job.name}: ${holding.join(", ")} hold a secret from this shell's environment.`);
  return zipBytes([...packed, ...plan.map(packFile)]);
}

// ---------------------------------------------------------------------------------------------------------------
// Plans and results

function readProbes(file: string): QdcProbe[] {
  return existsSync(file) ? parseProbes(readFileSync(file, "utf8")) : [];
}

/** Every result.json under devices/results/qdc/. */
export function qdcResults(repoRoot: string): Result[] {
  const root = path.join(repoRoot, "devices", "results", "qdc");
  if (!existsSync(root)) return [];
  return walk(root)
    .filter((rel) => rel.endsWith("/result.json"))
    .map((rel) => readResult(path.join(root, rel)));
}

/** The chipset a QDC result ran on: its cloudId is "<chipset>/<target id>". */
export function chipsetOf(result: Pick<Result, "device">): string | null {
  const m = /^([A-Za-z0-9_]+)\//.exec(result.device.cloudId ?? "");
  return m ? m[1] : null;
}

async function subjectPool(args: QdcArgs, fetchImpl: typeof fetch): Promise<{ pool: readonly Subject[]; named: Subject[] | undefined }> {
  const pool = args.tuned ? await fetchTunedSubjects(args.tuned, fetchImpl) : STAND_INS;
  if (args.tuned && pool.length === 0) throw new Error(`${args.tuned} has no tuned GGUF files yet.`);
  const named = args.subjects?.map((id) => {
    const s = id === "smoke" ? SMOKE : pool.find((p) => p.id === id) ?? subjectById(id);
    if (!s) throw new Error(`Unknown subject ${id}: one of ${[...pool, SMOKE].map((p) => p.id).join(", ")}.`);
    return s;
  });
  return { pool, named };
}

export async function planFor(args: QdcArgs, deps: Required<Pick<QdcDeps, "repoRoot" | "fetchImpl" | "now">>): Promise<QdcPlan> {
  const stamp = utcStamp(deps.now());
  const probes = readProbes(path.join(deps.repoRoot, TARGETS));
  if (args.command === "probe") {
    return planQdcJobs({ stamp, chipsets: [args.chipset as string], probes: [], maxJobs: 1, backends: args.backends });
  }
  const { pool, named } = await subjectPool(args, deps.fetchImpl);
  const done = new Set<string>();
  if (!args.again) {
    for (const r of qdcResults(deps.repoRoot)) {
      const chipset = chipsetOf(r);
      if (chipset) done.add(`${chipset} ${r.subject.id}`);
    }
  }
  return planQdcJobs({ stamp, chipsets: args.chipsets, probes, pool, named, maxJobs: args.maxJobs, done, backends: args.backends });
}

/** The command that runs a plan, for the plan's last line. */
export function runCommand(args: QdcArgs): string {
  const parts = ["npx tsx scripts/devices/qdc.ts", args.command === "probe" ? `probe --chipset ${args.chipset}` : "run"];
  if (args.command !== "probe") {
    if (args.chipsets.join(",") !== QDC_CHIPSETS.join(",")) parts.push(`--chipsets ${args.chipsets.join(",")}`);
    if (args.subjects) parts.push(`--subjects ${args.subjects.join(",")}`);
    if (args.tuned) parts.push(`--tuned ${args.tuned}`);
    if (args.maxJobs !== QDC_MAX_JOBS_DEFAULT) parts.push(`--max-jobs ${args.maxJobs}`);
    if (args.again) parts.push("--again");
  }
  if (args.backends.join(",") !== BACKENDS.join(",")) parts.push(`--backends ${args.backends.join(",")}`);
  parts.push("--yes");
  return parts.join(" ");
}

/** What collecting a job's result needs to know about it. */
export type CollectJob = Pick<QdcJob, "key" | "name" | "chipset" | "subject" | "why">;

export interface Collected {
  job: CollectJob;
  record: QdcJobRecord | null;
  result: Result | null;
  dir: string | null;
  /** Why there is no result. */
  why: string | null;
}

/**
 * For each job: its job.json, and its kit folder (out/<subject id>/ in the job's folder, which `outDirOf` gives) parsed
 * into a Result written under devices/results/qdc/.
 */
export function collectResults(
  repoRoot: string,
  jobs: readonly CollectJob[],
  outDirOf: (job: CollectJob) => string,
  probes: readonly QdcProbe[],
): Collected[] {
  return jobs.map((job): Collected => {
    const outDir = outDirOf(job);
    const recordFile = path.join(outDir, "job.json");
    const record = existsSync(recordFile) ? readJobRecord(JSON.parse(readFileSync(recordFile, "utf8"))) : null;
    const kitDir = path.join(outDir, "out", job.subject.id);
    if (!existsSync(path.join(kitDir, "run.txt"))) {
      const why = record?.error ?? record?.aborted ?? (record ? `the job ended ${record.state ?? "without a state"} with no kit output` : "submit.py wrote nothing for it");
      return { job, record, result: null, dir: null, why };
    }
    const hostFile = path.join(kitDir, "host.txt");
    const host = existsSync(hostFile) ? parseKeyValues(readFileSync(hostFile, "utf8")) : null;
    const device = parseKeyValues(existsSync(path.join(kitDir, "device.txt")) ? readFileSync(path.join(kitDir, "device.txt"), "utf8") : "");
    const ramKb = Number(device.ram_kb);
    const marketed = ramKb > 0 ? marketedRamGiB(ramKb * 1024) : probes.find((p) => p.chipset === job.chipset)?.marketedRamGiB ?? 0;
    const marketing = record?.marketingName ?? QDC_CHIPSET_NAMES[job.chipset] ?? "QDC phone";
    const result = parseKitOutput(kitDir, {
      cloud: "qdc",
      runId: record?.jobId != null ? String(record.jobId) : job.key,
      stamp: stampOfRunKey(job.key) ?? job.key,
      subject: job.subject,
      device: {
        slug: deviceSlug({ manufacturer: "qdc", model: job.chipset.toLowerCase(), marketedRamGiB: marketed }),
        name: `${marketing} (${job.chipset}) on QDC`,
        cloudId: `${job.chipset}/${record?.targetId ?? "unknown"}`,
      },
      notes: carrierNotes(host, record),
    });
    const dir = writeResult(repoRoot, result, kitDir);
    return { job, record, result, dir, why: null };
  });
}

export function verdictLine(c: Collected, repoRoot: string): string {
  const head = `${c.job.chipset} ${c.job.subject.id}`;
  if (!c.result || !c.dir) return `${head}: no result (${c.why}).`;
  const v = c.result.verdict;
  const speed = v.backend ? `, ${v.backend} ${v.genTps?.toFixed(1) ?? "?"} t/s, ${v.answersRight} of ${v.answersTotal} right` : "";
  return `${head}: ${v.rating}${speed} (${path.relative(repoRoot, c.dir)}).`;
}

/** Probes from the batch's results: every probe job, and any job on a chipset targets.json lacks. */
export function probesFrom(collected: readonly Collected[], probes: readonly QdcProbe[], at: Date): QdcProbe[] {
  let out = [...probes];
  for (const c of collected) {
    if (!c.dir || (c.job.why !== "probe" && out.some((p) => p.chipset === c.job.chipset))) continue;
    const devicePath = path.join(c.dir, "device.txt");
    if (!existsSync(devicePath)) continue;
    try {
      out = withProbe(out, probeFromDevice(c.job.chipset, parseKeyValues(readFileSync(devicePath, "utf8")), at));
    } catch {
      // No ram_kb: the probe stays unrecorded and the next plan probes again.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The commands

export async function runQdc(args: QdcArgs, deps: QdcDeps = {}): Promise<number> {
  const d = {
    exec: deps.exec ?? exec,
    fetchImpl: deps.fetchImpl ?? fetch,
    repoRoot: deps.repoRoot ?? REPO_ROOT,
    now: deps.now ?? (() => new Date()),
    say: deps.say ?? ((line: string) => console.log(line)),
    env: deps.env ?? process.env,
  };
  const cache = deps.cache ?? cacheDir(d.env as NodeJS.ProcessEnv);
  const targetsFile = path.join(d.repoRoot, TARGETS);
  if (args.help || !args.command) {
    d.say(USAGE);
    return args.help ? 0 : 2;
  }

  if (args.command === "check") {
    const { code, stdout } = await runSubmit(python312Path(), ["check"], d);
    if (code === 0) d.say(`A QDC key is saved (${(JSON.parse(stdout) as { source: string }).source}).`);
    else d.say("No usable QDC key: see docs/DEVICES.md, What the owner does once.");
    return code;
  }

  if (args.command === "targets") {
    const python = await ensureVenv(cache, d);
    const { code, stdout } = await runSubmit(python, ["targets"], d);
    if (code !== 0) return code;
    const probes = readProbes(targetsFile);
    const phones = readTargets(stdout).filter(isPhoneTarget);
    d.say(`${phones.length} Android phone target${phones.length === 1 ? "" : "s"} on QDC:`);
    for (const t of phones.sort((a, b) => a.chipset.localeCompare(b.chipset))) {
      const probe = probes.find((p) => p.chipset === t.chipset);
      d.say(
        `  ${t.chipset.padEnd(8)} ${t.marketingName} (${t.platformName}), Android ${t.osVersion}, ${t.state}, target ${t.targetId}` +
          `${probe ? `; probed: ${probe.marketedRamGiB} GB` : "; not probed"}`,
      );
    }
    return 0;
  }

  if (args.command === "fetch") return fetchJob(args, cache, d);

  const plan = await planFor(args, d);
  d.say(qdcPlanText(plan, { maxJobs: args.command === "probe" ? 1 : args.maxJobs }).trimEnd());
  if (plan.jobs.length === 0) {
    d.say("Nothing to run.");
    return 0;
  }
  if (args.command === "plan" || !args.yes) {
    d.say(`Nothing was built or submitted. To run it:\n  ${runCommand(args)}`);
    return 0;
  }

  const check = await runSubmit(python312Path(), ["check"], d);
  if (check.code !== 0) {
    d.say("No usable QDC key, so nothing was submitted: see docs/DEVICES.md, What the owner does once.");
    return check.code;
  }
  const python = await ensureVenv(cache, d);
  const runDir = path.join(cache, "qdc", "runs", plan.stamp);
  mkdirSync(runDir, { recursive: true });
  const builds = deps.stageBuilds
    ? await deps.stageBuilds(cache)
    : {
        "android-arm64": await ensureAndroidBuild(cache, "android-arm64", d.fetchImpl, d.say),
        "android-arm64-snapdragon": await ensureAndroidBuild(cache, "android-arm64-snapdragon", d.fetchImpl, d.say),
      };
  const shared = sharedZipFiles(d.repoRoot, builds);
  d.say(`Packing the kit and both builds (${(shared.reduce((n, f) => n + f.data.length, 0) / 1e6).toFixed(0)} MB) once for ${plan.jobs.length} zip(s).`);
  const packed = shared.map(packFile);
  const secrets = secretValues(d.env);
  const zips = new Map<string, string>();
  for (const job of plan.jobs) {
    let template: string | undefined;
    if (job.subject.templatePath) {
      const res = await d.fetchImpl(repoFileUrl(job.subject, job.subject.templatePath));
      if (!res.ok) throw new Error(`The Hub answered ${res.status} for ${job.subject.id}'s ${job.subject.templatePath}.`);
      template = await res.text();
    }
    const zip = path.join(runDir, `${job.key}.zip`);
    writeFileSync(zip, jobZip(job, shared, packed, template, secrets));
    zips.set(job.key, zip);
    d.say(`${job.name}: ${path.basename(zip)}, ${(statSync(zip).size / 1e6).toFixed(0)} MB.`);
  }
  const manifest = qdcManifest(plan.jobs, (job) => ({ zip: zips.get(job.key) as string, outDir: path.join(runDir, job.key) }));
  const manifestFile = path.join(runDir, "manifest.json");
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

  const submitted = await runSubmit(python, ["run", "--manifest", manifestFile], d);
  if (!args.keepZips) for (const zip of zips.values()) rmSync(zip, { force: true });
  const probes = readProbes(targetsFile);
  const collected = collectResults(d.repoRoot, plan.jobs, (job) => path.join(runDir, job.key), probes);
  for (const c of collected) d.say(verdictLine(c, d.repoRoot));
  const updated = probesFrom(collected, probes, d.now());
  if (probesText(updated) !== probesText(probes)) {
    writeFileSync(targetsFile, probesText(updated));
    d.say(`Recorded ${updated.length - probes.length > 0 ? "new " : ""}probes in ${TARGETS}: ${updated.map((p) => `${p.chipset} ${p.marketedRamGiB} GB`).join(", ")}.`);
  }
  d.say(`submit.py's files for this batch: ${runDir}`);
  if (submitted.code === 130) return 130;
  return submitted.code === 0 && collected.every((c) => c.result) ? 0 : 1;
}

function python312Path(): string {
  return existsSync("/opt/homebrew/bin/python3.12") ? "/opt/homebrew/bin/python3.12" : "python3.12";
}

async function fetchJob(
  args: QdcArgs,
  cache: string,
  d: Required<Pick<QdcDeps, "exec" | "fetchImpl" | "repoRoot" | "now" | "say" | "env">>,
): Promise<number> {
  const python = await ensureVenv(cache, d);
  const outDir = path.join(cache, "qdc", "fetch", args.jobId as string);
  const fetched = await runSubmit(python, ["fetch", "--job", args.jobId as string, "--out", outDir], d);
  const recordFile = path.join(outDir, "job.json");
  if (!existsSync(recordFile)) return fetched.code || 1;
  const record = readJobRecord(JSON.parse(readFileSync(recordFile, "utf8")));
  const pool = args.tuned ? await fetchTunedSubjects(args.tuned, d.fetchImpl) : [];
  const chipset = record.chipset ?? "UNKNOWN";
  const key = record.key && stampOfRunKey(record.key) ? record.key : `${utcStamp(d.now())}-${chipset}-0`;
  const jobs: CollectJob[] = [];
  for (const id of record.subjects) {
    const subject = pool.find((s) => s.id === id) ?? subjectById(id);
    if (!subject) {
      d.say(`${id}: not a subject this runner knows (a tuned file needs --tuned <repo>); its files stay in ${outDir}.`);
      continue;
    }
    jobs.push({ key, name: record.name ?? `mm ${chipset}`, chipset, subject, why: subject.kind === "smoke" ? "probe" : "named" });
  }
  const targetsFile = path.join(d.repoRoot, TARGETS);
  const probes = readProbes(targetsFile);
  const collected = collectResults(d.repoRoot, jobs, () => outDir, probes);
  for (const c of collected) d.say(verdictLine(c, d.repoRoot));
  const updated = probesFrom(collected, probes, d.now());
  if (probesText(updated) !== probesText(probes)) {
    writeFileSync(targetsFile, probesText(updated));
    d.say(`Recorded probes in ${TARGETS}: ${updated.map((p) => `${p.chipset} ${p.marketedRamGiB} GB`).join(", ")}.`);
  }
  return fetched.code === 0 && collected.length > 0 && collected.every((c) => c.result) ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
  let args: QdcArgs;
  try {
    args = parseQdcArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  return runQdc(args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
