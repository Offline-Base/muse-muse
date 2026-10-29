/**
 * Runs the device kit on AWS Device Farm phones (docs/DEVICES.md "On AWS Device Farm" and "How to run > Device Farm"):
 *
 *   npx tsx scripts/devices/devicefarm.ts devices                    the Android phones, with RAM, chip and backends
 *   npx tsx scripts/devices/devicefarm.ts plan                       the plan, its cost and the exact command to run it
 *   npx tsx scripts/devices/devicefarm.ts plan --dry-run             the same with no AWS call, and the package built
 *   npx tsx scripts/devices/devicefarm.ts run --smoke --yes          the smoke model on one phone, before anything else
 *   npx tsx scripts/devices/devicefarm.ts run --yes                  the picked files on up to 3 phones
 *   npx tsx scripts/devices/devicefarm.ts fetch <run ARN> [--wait]   a run's results into devices/results/devicefarm/
 *   npx tsx scripts/devices/devicefarm.ts stop <run ARN>...          stops runs
 *
 * Choosing: --smoke (the 92 MB smoke model with short limits), --probe (smoke runs on the phones whose RAM is only
 * reported), --device <name or ARN> (repeatable), --subjects <id,id>, --tuned <ns>/muse-glimmer-30b-<slug>-gguf-<job8>,
 * --backends cpu,gpu,npu, --copy auto|push|stream. Caps: --max-devices <n> (default 3, 1 for a smoke run, at most 5)
 * and --max-usd <n> (default 60, for the worst case). Also --from <list-devices JSON> (instead of ListDevices; a dry
 * run reads devices/devicefarm/fixtures/ unless given one), --detach (schedule and return) and --skip-smoke-check.
 *
 * AWS is reached only through `aws devicefarm <command> ... --profile base-test --region us-west-2 --output json`
 * (awsArgs), never with --debug, and the runner never logs in: an expired session stops it with the login command.
 * Nothing is scheduled without --yes, and a batch of large files waits for a Device Farm smoke run that passed. Once a
 * run is scheduled, an error, Ctrl-C or a run far past its job timeout stops every unfinished run, so nothing keeps
 * billing. Presigned URLs are never printed or written, the package is checked for secrets before it is built, and the
 * phone never gets a token: the models are public files the host downloads.
 *
 * The cache (MM_DEVICES_CACHE, or ~/.cache/muse-muse-devices, as for scripts/devices/local.ts) holds both Android builds,
 * checked by sha256 and trimmed by keepLlamaFile, the carrier's wheels, and per batch devicefarm/<stamp>/ with the
 * package, the spec, batch.json, and each job's artifacts and console (presigned URLs removed). Results go to
 * devices/results/devicefarm/<device>/<subject>/<stamp>/.
 */
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CARRIER_WHEELS,
  COPY_MODES,
  DF_ARTIFACT_CAP_BYTES,
  DF_CONCURRENCY,
  DF_DEFAULT_DEVICES,
  DF_DEFAULT_MAX_USD,
  DF_DEFAULT_SMOKE_DEVICES,
  DF_MAX_JOB_MINUTES,
  DF_PACKAGE_TYPE,
  DF_PROFILE,
  DF_PROJECT,
  DF_SPEC_TYPE,
  POLL_SECONDS,
  UPLOAD_CONTENT_TYPE,
  androidPhones,
  awsArgs,
  batchRecord,
  billingFor,
  capProblems,
  chooseProbes,
  choosePhones,
  chooseSmoke,
  comparePhones,
  hostNotes,
  kitDevice,
  kitDirsIn,
  measuredRam,
  namedPhones,
  needsProbe,
  notTestedReason,
  packageEntries,
  phoneFor,
  phoneLine,
  phoneOfJob,
  pickArtifacts,
  planBatch,
  planFiles,
  planText,
  readAccount,
  readArns,
  readArtifacts,
  readBatchRecord,
  readJobs,
  readKeyValues,
  readProject,
  readProjects,
  readRun,
  readUpload,
  recordedRun,
  runDone,
  runKeyFromName,
  scheduleRunInput,
  scrubPresigned,
  secretHits,
  secretValues,
  smokePassed,
  testSpecYaml,
  uploadNames,
  watchRun,
  zipBuild,
  zipRead,
  type Batch,
  type BatchRecord,
  type Caps,
  type CarrierWheel,
  type CopyMode,
  type DfAccount,
  type DfArtifact,
  type DfDevice,
  type DfJob,
  type DfRun,
  type PackageRoot,
  type Phone,
  type RecordedRun,
  type RunWatch,
} from "@/lib/devices/devicefarm";
import { parseKitOutput, writeResult } from "@/lib/devices/result";
import {
  LLAMA_TAG,
  PHONE_RAM_TIERS_GIB,
  fetchTunedSubjects,
  llamaAsset,
  repoFileUrl,
  subjectById,
  utcStamp,
} from "@/lib/devices/subjects";
import { BACKENDS, type Backend, type LlamaBuild, type Result, type Subject } from "@/lib/devices/types";
import { cacheDir, downloadVerified, extractKept, fileMatches } from "@/scripts/devices/local";
import { readResults } from "@/scripts/devices/report";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DF_DIR = path.join(REPO_ROOT, "devices", "devicefarm");
export const FIXTURE_DEVICES = path.join(DF_DIR, "fixtures", "list-devices-android-phones.json");
export const SPEC_FILE = path.join(DF_DIR, "testspec.yml");

/** How often an upload's processing is read, and for how long. */
const UPLOAD_POLL_SECONDS = 5;
const UPLOAD_WAIT_MINUTES = 15;

// ---------------------------------------------------------------------------------------------------------------
// Arguments

export type DfCommand = "devices" | "plan" | "run" | "fetch" | "stop";
const COMMANDS: readonly DfCommand[] = ["devices", "plan", "run", "fetch", "stop"];
const RUN_ARN = /^arn:aws:devicefarm:us-west-2:\d{12}:run:[A-Za-z0-9/_-]+$/;

export interface DfArgs {
  command: DfCommand | null;
  yes: boolean;
  dryRun: boolean;
  smoke: boolean;
  /** Smoke runs on the phones whose RAM is only reported (implies smoke). */
  probe: boolean;
  /** --device names or ARNs, in order. */
  devices: string[];
  subjects: string[] | null;
  tuned: string | null;
  backends: Backend[] | null;
  /** Null: DF_DEFAULT_DEVICES, or DF_DEFAULT_SMOKE_DEVICES for a smoke run on chosen phones. */
  maxDevices: number | null;
  maxUsd: number;
  copy: CopyMode;
  from: string | null;
  detach: boolean;
  skipSmokeCheck: boolean;
  wait: boolean;
  /** Run ARNs for fetch and stop. */
  arns: string[];
  help: boolean;
}

export const USAGE = `Usage: npx tsx scripts/devices/devicefarm.ts <command> [flags]
  devices                      the Android phones Device Farm has, with RAM, chip and backends
  plan                         the plan, its estimate and the exact command that runs it
  run --yes                    schedule the plan, wait for it and write the results
  fetch <run ARN> [--wait]     read a run's results into devices/results/devicefarm/
  stop <run ARN>...            stop runs
Flags: --smoke, --probe, --device <name or ARN> (repeatable), --subjects <id,id>, --tuned <repo>,
  --backends cpu,gpu,npu, --copy auto|push|stream, --max-devices <n>, --max-usd <n>, --from <list-devices JSON>,
  --dry-run, --detach, --skip-smoke-check`;

export function parseDfArgs(argv: readonly string[]): DfArgs {
  const args: DfArgs = {
    command: null,
    yes: false,
    dryRun: false,
    smoke: false,
    probe: false,
    devices: [],
    subjects: null,
    tuned: null,
    backends: null,
    maxDevices: null,
    maxUsd: DF_DEFAULT_MAX_USD,
    copy: "auto",
    from: null,
    detach: false,
    skipSmokeCheck: false,
    wait: false,
    arns: [],
    help: false,
  };
  const value = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value.\n${USAGE}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--yes":
        args.yes = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--smoke":
        args.smoke = true;
        break;
      case "--probe":
        args.probe = true;
        args.smoke = true;
        break;
      case "--device":
        args.devices.push(value(i++, arg));
        break;
      case "--subjects": {
        const list = value(i++, arg).split(",").map((s) => s.trim()).filter(Boolean);
        if (list.length === 0) throw new Error("--subjects takes subject ids, comma-separated.");
        args.subjects = list;
        break;
      }
      case "--tuned":
        args.tuned = value(i++, arg);
        break;
      case "--backends": {
        const list = value(i++, arg).split(",").filter(Boolean);
        if (!list.length || list.some((b) => !BACKENDS.includes(b as Backend)) || new Set(list).size !== list.length) {
          throw new Error("--backends takes cpu, gpu and npu, comma-separated, each once.");
        }
        args.backends = list as Backend[];
        break;
      }
      case "--copy": {
        const mode = value(i++, arg);
        if (!COPY_MODES.includes(mode as CopyMode)) throw new Error("--copy takes auto, push or stream.");
        args.copy = mode as CopyMode;
        break;
      }
      case "--max-devices": {
        const n = Number(value(i++, arg));
        if (!Number.isInteger(n) || n < 1 || n > DF_CONCURRENCY) {
          throw new Error(`--max-devices takes a whole number from 1 to ${DF_CONCURRENCY}, the phones Device Farm runs at once.`);
        }
        args.maxDevices = n;
        break;
      }
      case "--max-usd": {
        const n = Number(value(i++, arg));
        if (!Number.isFinite(n) || n <= 0) throw new Error("--max-usd takes a number of dollars above 0.");
        args.maxUsd = n;
        break;
      }
      case "--from":
        args.from = value(i++, arg);
        break;
      case "--detach":
        args.detach = true;
        break;
      case "--skip-smoke-check":
        args.skipSmokeCheck = true;
        break;
      case "--wait":
        args.wait = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`Unknown flag ${arg}.\n${USAGE}`);
        if (args.command === null) {
          if (!COMMANDS.includes(arg as DfCommand)) throw new Error(`Unknown command ${arg}.\n${USAGE}`);
          args.command = arg as DfCommand;
        } else if (args.command === "fetch" || args.command === "stop") {
          if (!RUN_ARN.test(arg)) throw new Error(`Not a Device Farm run ARN in us-west-2: ${arg}`);
          args.arns.push(arg);
        } else {
          throw new Error(`Unexpected argument ${arg}.\n${USAGE}`);
        }
    }
  }
  if ((args.command === "fetch" || args.command === "stop") && args.arns.length === 0 && !args.help) {
    throw new Error(`${args.command} needs a run ARN.`);
  }
  if (args.subjects && args.smoke) throw new Error("--smoke runs the smoke model: drop --subjects.");
  if (args.subjects && args.tuned) throw new Error("--subjects and --tuned both name the files: give one.");
  return args;
}

/** A word for a POSIX shell: as it is when it is plain, else in single quotes. */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9._:/,@+=-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The exact command that schedules this plan: the same choices, with the chosen phones pinned by ARN. */
export function runCommand(args: DfArgs, batch: Batch, caps: Caps): string {
  const parts = ["npx", "tsx", "scripts/devices/devicefarm.ts", "run", "--yes"];
  if (args.smoke) parts.push("--smoke");
  for (const arn of new Set(batch.runs.map((r) => r.phone.device.arn))) parts.push("--device", arn);
  if (args.subjects) parts.push("--subjects", args.subjects.join(","));
  if (args.tuned) parts.push("--tuned", args.tuned);
  if (args.backends) parts.push("--backends", args.backends.join(","));
  if (args.copy !== "auto") parts.push("--copy", args.copy);
  parts.push("--max-devices", String(caps.maxDevices));
  if (args.maxUsd !== DF_DEFAULT_MAX_USD) parts.push("--max-usd", String(args.maxUsd));
  if (args.skipSmokeCheck) parts.push("--skip-smoke-check");
  if (args.detach) parts.push("--detach");
  return parts.map(shellQuote).join(" ");
}

// ---------------------------------------------------------------------------------------------------------------
// The aws CLI, behind one function the tests replace

export interface AwsResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `aws <args>` and resolves its exit code and output. */
export type AwsExec = (args: readonly string[]) => Promise<AwsResult>;

/** The real aws CLI: no shell, no pager, its output kept in memory (never printed: it holds presigned URLs). */
export const systemAws: AwsExec = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn("aws", [...args], { env: { ...process.env, AWS_PAGER: "" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code: number | null) => resolve({ code: code ?? 1, stdout, stderr }));
  });

/** The base-test session has run out. The owner logs in again; the runner never does it for them. */
export class AwsLoginNeeded extends Error {}

const LOGIN_NEEDED =
  /token has expired|sso session[^\n]*(expired|invalid)|error loading sso token|unauthorizedssotoken|the sso session associated with this profile|aws sso login/i;

export const LOGIN_MESSAGE = `The AWS session for the ${DF_PROFILE} profile has expired or is missing. Run \`aws sso login --profile ${DF_PROFILE}\`, then run this again.`;

/** Device Farm through the CLI: JSON in and out, errors scrubbed, and no secret from this shell on its command line. */
export class DfClient {
  /** Every command called, in order (tests read it). */
  readonly commands: string[] = [];

  constructor(
    private readonly exec: AwsExec,
    private readonly secrets: ReadonlyArray<{ name: string; value: string }> = [],
  ) {}

  async call(command: string, args: readonly string[] = []): Promise<unknown> {
    const argv = awsArgs(command, args);
    const line = argv.join(" ");
    for (const s of this.secrets) {
      if (line.includes(s.value)) throw new Error(`Refusing to put the value of ${s.name} on an aws command line.`);
    }
    this.commands.push(command);
    const res = await this.exec(argv);
    if (res.code !== 0) {
      if (LOGIN_NEEDED.test(res.stderr)) throw new AwsLoginNeeded(LOGIN_MESSAGE);
      const why = scrubPresigned(res.stderr).replace(/\s+/g, " ").trim().slice(0, 600);
      throw new Error(`aws devicefarm ${command} failed (exit ${res.code})${why ? `: ${why}` : "."}`);
    }
    if (!res.stdout.trim()) return {};
    try {
      return JSON.parse(res.stdout) as unknown;
    } catch {
      throw new Error(`aws devicefarm ${command} didn't answer with JSON.`);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// What a run needs from this Mac

export interface DfDeps {
  aws: AwsExec;
  /** For the presigned uploads and downloads, the public Hub, GitHub and PyPI. */
  fetchImpl: typeof fetch;
  /** Where devices/results/devicefarm/ is read and written. The package's own files always come from this repo. */
  repoRoot: string;
  cache: string;
  /** This shell's environment, only to check that none of its secrets reaches the package or the aws command line. */
  env: Readonly<Record<string, string | undefined>>;
  say: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  /** The carrier's wheels (CARRIER_WHEELS; tests give their own). */
  wheels: readonly CarrierWheel[];
  /** Calls the handler on Ctrl-C or SIGTERM while runs are scheduled; returns a function that removes it. */
  onInterrupt: (handler: () => Promise<void>) => () => void;
}

export function defaultDeps(): DfDeps {
  return {
    aws: systemAws,
    fetchImpl: fetch,
    repoRoot: REPO_ROOT,
    cache: cacheDir(),
    env: process.env,
    say: (line) => console.log(line),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => new Date(),
    wheels: CARRIER_WHEELS,
    onInterrupt: (handler) => {
      const h = () => {
        void handler().finally(() => process.exit(130));
      };
      process.once("SIGINT", h);
      process.once("SIGTERM", h);
      return () => {
        process.off("SIGINT", h);
        process.off("SIGTERM", h);
      };
    },
  };
}

const message = (err: unknown) => scrubPresigned(err instanceof Error ? err.message : String(err));
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

// ---------------------------------------------------------------------------------------------------------------
// Phones

/** Every result.json already under devices/results/devicefarm/ (for measured RAM and the smoke check). */
export function earlierResults(deps: Pick<DfDeps, "repoRoot" | "say">): Result[] {
  try {
    return readResults(path.join(deps.repoRoot, "devices", "results", "devicefarm"));
  } catch (err) {
    deps.say(`Note: couldn't read the earlier Device Farm results (${message(err)}); planning without them.`);
    return [];
  }
}

/** ListDevices' Android phones: from --from, from the fixture for a dry run, or from Device Farm. */
async function listPhones(args: DfArgs, client: DfClient): Promise<DfDevice[]> {
  if (args.from) return androidPhones(JSON.parse(readFileSync(args.from, "utf8")));
  if (args.dryRun) return androidPhones(JSON.parse(readFileSync(FIXTURE_DEVICES, "utf8")));
  const filters = [
    { attribute: "PLATFORM", operator: "EQUALS", values: ["ANDROID"] },
    { attribute: "FORM_FACTOR", operator: "EQUALS", values: ["PHONE"] },
  ];
  return androidPhones(await client.call("list-devices", ["--filters", JSON.stringify(filters)]));
}

async function loadPhones(args: DfArgs, client: DfClient, results: readonly Result[]): Promise<Phone[]> {
  const measured = measuredRam(results);
  return (await listPhones(args, client)).map((d) => phoneFor(d, measured));
}

// ---------------------------------------------------------------------------------------------------------------
// The plan

export interface Planned {
  batch: Batch;
  account: DfAccount | null;
  caps: Caps;
  notes: string[];
  /** Chat templates by subject id, for tuned files that need one. */
  templates: Map<string, string>;
}

export async function makePlan(args: DfArgs, deps: DfDeps, client: DfClient, results: readonly Result[]): Promise<Planned> {
  const phones = await loadPhones(args, client, results);
  const smokeOnOne = args.smoke && !args.probe && args.devices.length === 0;
  const maxDevices = args.maxDevices ?? (smokeOnOne ? DF_DEFAULT_SMOKE_DEVICES : DF_DEFAULT_DEVICES);
  const chosen = args.devices.length
    ? namedPhones(phones, args.devices)
    : args.probe
      ? chooseProbes(phones, { maxDevices })
      : args.smoke
        ? chooseSmoke(phones, { maxDevices })
        : choosePhones(phones, { maxDevices });
  const notes: string[] = [];
  let subjects: Subject[] | undefined;
  let pool: Subject[] | undefined;
  if (args.subjects) {
    subjects = args.subjects.map((id) => {
      const s = subjectById(id);
      if (!s) throw new Error(`Unknown subject ${id}. Known: the ids in lib/devices/subjects.ts.`);
      return s;
    });
  }
  if (args.tuned) {
    pool = await fetchTunedSubjects(args.tuned, deps.fetchImpl);
    if (pool.length === 0) throw new Error(`${args.tuned} has no tuned GGUF files yet.`);
    notes.push(`Tuned files of ${args.tuned} at ${pool[0].revision.slice(0, 12)}: ${pool.map((s) => s.id).join(", ")}.`);
  }
  const batch = planBatch(chosen, {
    stamp: utcStamp(deps.now()),
    smoke: args.smoke,
    subjects,
    pool,
    backends: args.backends ?? undefined,
    copy: args.copy,
  });
  const templates = new Map<string, string>();
  for (const run of batch.runs) {
    for (const { subject } of run.subjects) {
      if (!subject.templatePath || templates.has(subject.id)) continue;
      const res = await deps.fetchImpl(repoFileUrl(subject, subject.templatePath));
      if (!res.ok) throw new Error(`The Hub answered ${res.status} for ${subject.repo}'s ${subject.templatePath}.`);
      templates.set(subject.id, await res.text());
    }
  }
  const account = args.dryRun ? null : readAccount(await client.call("get-account-settings"));
  if (!args.smoke && !smokePassed(results)) {
    notes.push(
      "No Device Farm smoke run has passed yet. `run --smoke --yes` comes first (about 5 minutes on one phone); a run of " +
        "large files waits for one unless --skip-smoke-check.",
    );
  }
  return { batch, account, caps: { maxDevices, maxUsd: args.maxUsd }, notes, templates };
}

// ---------------------------------------------------------------------------------------------------------------
// The test package

/** Files under dir, relative to it, sorted, without hidden files or links. */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith(".")) continue;
      const p = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      const info = lstatSync(p);
      if (info.isDirectory()) walk(p, r);
      else if (info.isFile()) out.push(r);
    }
  };
  walk(dir, "");
  return out;
}

/**
 * One of the two Android builds in the cache (<cache>/llama/b11669/<build>/llama-b11669/), downloaded from the pinned
 * release, checked by its sha256 and trimmed by keepLlamaFile when it isn't there yet. Returns its llama-b11669 folder.
 */
export async function ensureAndroidBuild(
  build: Extract<LlamaBuild, "android-arm64" | "android-arm64-snapdragon">,
  deps: Pick<DfDeps, "cache" | "fetchImpl" | "say">,
): Promise<string> {
  const asset = llamaAsset(build);
  const base = path.join(deps.cache, "llama", LLAMA_TAG);
  const dir = path.join(base, build);
  const root = path.join(dir, "llama-b11669");
  const marker = path.join(dir, ".sha256");
  const bench = path.join(root, asset.layout === "bin-lib" ? "bin/llama-bench" : "llama-bench");
  if (existsSync(marker) && readFileSync(marker, "utf8").trim() === asset.sha256 && existsSync(bench)) return root;
  const archive = path.join(base, asset.name);
  if (!(await fileMatches(archive, asset.bytes, asset.sha256))) {
    deps.say(`Downloading ${asset.name} (${mb(asset.bytes)}) from the llama.cpp ${LLAMA_TAG} release.`);
    await downloadVerified(asset.url, archive, asset.bytes, asset.sha256, deps.fetchImpl);
  }
  const kept = extractKept(archive, dir);
  writeFileSync(marker, `${asset.sha256}\n`);
  deps.say(`Extracted ${kept.length} files of ${asset.name} into ${dir}.`);
  return root;
}

/** The carrier's wheels in the cache, each downloaded from PyPI and checked by size and sha256 when it isn't there. */
export async function ensureWheels(deps: Pick<DfDeps, "cache" | "fetchImpl" | "say" | "wheels">): Promise<string> {
  const dir = path.join(deps.cache, "devicefarm", "wheels");
  for (const w of deps.wheels) {
    const file = path.join(dir, w.file);
    if (await fileMatches(file, w.bytes, w.sha256)) continue;
    deps.say(`Downloading ${w.file} from PyPI.`);
    await downloadVerified(w.url, file, w.bytes, w.sha256, deps.fetchImpl);
  }
  return dir;
}

export interface BuiltPackage {
  dir: string;
  zip: string;
  spec: string;
  files: number;
  bytes: number;
}

/**
 * The batch's test package and spec in <cache>/devicefarm/<stamp>/: the carrier, host.sh, the kit, both trimmed builds,
 * the wheelhouse and every run's plan folder (packageEntries), and devices/devicefarm/testspec.yml. Every text file is
 * checked for secret patterns and every file for the values of this shell's secret variables; a hit stops the build.
 */
export async function buildPackage(batch: Batch, templates: ReadonlyMap<string, string>, deps: DfDeps): Promise<BuiltPackage> {
  const spec = readFileSync(SPEC_FILE, "utf8");
  if (spec !== testSpecYaml()) throw new Error("devices/devicefarm/testspec.yml isn't what testSpecYaml() writes.");
  const android = await ensureAndroidBuild("android-arm64", deps);
  const snapdragon = await ensureAndroidBuild("android-arm64-snapdragon", deps);
  const wheelhouse = await ensureWheels(deps);
  const roots: Record<PackageRoot, string> = {
    carrier: path.join(DF_DIR, "carrier"),
    host: DF_DIR,
    kit: path.join(REPO_ROOT, "devices", "kit"),
    android,
    snapdragon,
    wheelhouse,
  };
  const entries = packageEntries({
    kitFiles: listFiles(roots.kit),
    androidFiles: listFiles(android),
    snapdragonFiles: listFiles(snapdragon),
    wheels: deps.wheels,
    plans: batch.runs.flatMap((r) => planFiles(r, batch.copy, templates)),
  });
  const secrets = secretValues(deps.env);
  const check = (name: string, data: Buffer, text: boolean) => {
    const hits = text
      ? secretHits(data.toString("utf8"), secrets)
      : secrets.filter((s) => data.includes(s.value)).map((s) => `the value of ${s.name}`);
    if (hits.length) throw new Error(`${name} holds ${hits.join(" and ")}: not building the package.`);
  };
  check("testspec.yml", Buffer.from(spec, "utf8"), true);
  const files = entries.map((e) => {
    const from = e.from;
    const data = e.text !== undefined ? Buffer.from(e.text, "utf8") : from ? readFileSync(path.join(roots[from.root], from.path)) : null;
    if (!data) throw new Error(`${e.path} has no source.`);
    const text = e.text !== undefined || from?.root === "carrier" || from?.root === "host" || from?.root === "kit";
    check(e.path, data, text);
    return { path: e.path, mode: e.mode, data };
  });
  const dir = path.join(deps.cache, "devicefarm", batch.stamp);
  mkdirSync(dir, { recursive: true });
  const names = uploadNames(batch.stamp);
  const zip = zipBuild(files);
  writeFileSync(path.join(dir, names.package), zip);
  writeFileSync(path.join(dir, names.spec), spec);
  return { dir, zip: path.join(dir, names.package), spec: path.join(dir, names.spec), files: files.length, bytes: zip.length };
}

// ---------------------------------------------------------------------------------------------------------------
// The project and the uploads

async function ensureProject(client: DfClient, deps: DfDeps): Promise<string> {
  const found = readProjects(await client.call("list-projects")).find((p) => p.name === DF_PROJECT);
  if (found) return found.arn;
  deps.say(`Creating the Device Farm project ${DF_PROJECT}.`);
  const created = await client.call("create-project", [
    "--name",
    DF_PROJECT,
    "--default-job-timeout-minutes",
    String(DF_MAX_JOB_MINUTES),
  ]);
  return readProject(created).arn;
}

/** CreateUpload, an HTTP PUT of the file to the presigned URL it gives, then GetUpload until it SUCCEEDED. */
export async function uploadFile(
  client: DfClient,
  deps: DfDeps,
  projectArn: string,
  name: string,
  type: string,
  file: string,
): Promise<string> {
  const created = readUpload(
    await client.call("create-upload", [
      "--project-arn",
      projectArn,
      "--name",
      name,
      "--type",
      type,
      "--content-type",
      UPLOAD_CONTENT_TYPE,
    ]),
  );
  if (!created.url.startsWith("https://")) throw new Error(`CreateUpload gave ${name} no upload URL.`);
  let res: Response;
  try {
    res = await deps.fetchImpl(created.url, {
      method: "PUT",
      body: new Uint8Array(readFileSync(file)),
      headers: { "content-type": UPLOAD_CONTENT_TYPE },
    });
  } catch (err) {
    throw new Error(`Sending ${name} to Device Farm failed: ${message(err)}`);
  }
  await res.body?.cancel().catch(() => undefined);
  if (!res.ok) throw new Error(`Sending ${name} to Device Farm answered HTTP ${res.status}.`);
  const deadline = deps.now().getTime() + UPLOAD_WAIT_MINUTES * 60_000;
  for (;;) {
    const u = readUpload(await client.call("get-upload", ["--arn", created.arn]));
    if (u.status === "SUCCEEDED") return created.arn;
    if (u.status === "FAILED") {
      throw new Error(`Device Farm refused ${name}: ${u.message || "no message"}${u.metadata ? ` ${u.metadata}` : ""}`);
    }
    if (deps.now().getTime() > deadline) throw new Error(`${name} was still ${u.status} after ${UPLOAD_WAIT_MINUTES} minutes.`);
    await deps.sleep(UPLOAD_POLL_SECONDS * 1000);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The batch record

export function recordFile(cache: string, stamp: string): string {
  return path.join(cache, "devicefarm", stamp, "batch.json");
}

function saveRecord(cache: string, record: BatchRecord): void {
  const file = recordFile(cache, record.stamp);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
}

export function loadRecord(cache: string, stamp: string): BatchRecord | null {
  const file = recordFile(cache, stamp);
  if (!/^\d{8}T\d{6}Z$/.test(stamp) || !existsSync(file)) return null;
  return readBatchRecord(JSON.parse(readFileSync(file, "utf8")));
}

// ---------------------------------------------------------------------------------------------------------------
// Runs: scheduling, stopping, waiting

async function stopRuns(client: DfClient, deps: DfDeps, arns: readonly string[], why: string): Promise<void> {
  for (const arn of arns) {
    try {
      const run = readRun(await client.call("stop-run", ["--arn", arn]));
      deps.say(`Stopped ${run.name || arn} (${why}): ${run.status}.`);
    } catch (err) {
      const first = err instanceof AwsLoginNeeded ? `aws sso login --profile ${DF_PROFILE}, then ` : "";
      deps.say(`Couldn't stop ${arn}: ${message(err)} Stop it with: ${first}npx tsx scripts/devices/devicefarm.ts stop ${arn}`);
    }
  }
}

/**
 * Polls every run of the record until each is COMPLETED, printing status changes, and stops one that waits too long
 * for its phone or runs far past its job timeout (watchRun). Adds each finished run's ARN to `finished`.
 */
async function waitForRuns(
  client: DfClient,
  deps: DfDeps,
  runs: ReadonlyArray<Pick<RecordedRun, "arn" | "jobTimeoutMinutes">>,
  finished: Set<string>,
): Promise<Map<string, DfRun>> {
  const start = deps.now().getTime();
  const watches = new Map<string, RunWatch>();
  for (const r of runs) {
    if (r.arn) watches.set(r.arn, { scheduledAt: start, startedAt: null, jobTimeoutMinutes: r.jobTimeoutMinutes });
  }
  const done = new Map<string, DfRun>();
  const seen = new Map<string, string>();
  const stopped = new Set<string>();
  while (done.size < watches.size) {
    for (const [arn, watch] of watches) {
      if (done.has(arn)) continue;
      const run = readRun(await client.call("get-run", ["--arn", arn]));
      const shown = `${run.status} ${run.result}`;
      if (seen.get(arn) !== shown) {
        seen.set(arn, shown);
        deps.say(`${run.name || arn}: ${run.status}${run.result && run.result !== "PENDING" ? `, ${run.result}` : ""}`);
      }
      if (runDone(run)) {
        done.set(arn, run);
        finished.add(arn);
        continue;
      }
      const next = watchRun(watch, run.status, deps.now().getTime());
      watches.set(arn, next.watch);
      if (next.stop && !stopped.has(arn)) {
        stopped.add(arn);
        await stopRuns(client, deps, [arn], next.stop);
      }
    }
    if (done.size < watches.size) await deps.sleep(POLL_SECONDS * 1000);
  }
  return done;
}

// ---------------------------------------------------------------------------------------------------------------
// Results

async function download(deps: DfDeps, artifact: DfArtifact): Promise<Buffer> {
  const what = artifact.name || artifact.type;
  let res: Response;
  try {
    res = await deps.fetchImpl(artifact.url);
  } catch (err) {
    throw new Error(`Downloading ${what} failed: ${message(err)}`);
  }
  if (!res.ok) throw new Error(`Downloading ${what} answered HTTP ${res.status}.`);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > 2 * DF_ARTIFACT_CAP_BYTES) throw new Error(`${what} is larger than Device Farm's artifacts can be.`);
  return data;
}

/** A job's customer artifact and console: from ListArtifacts on the job, else on the tests below it. */
async function jobArtifacts(client: DfClient, job: DfJob) {
  const list = async (arn: string, type: "FILE" | "LOG") =>
    readArtifacts(await client.call("list-artifacts", ["--arn", arn, "--type", type]));
  let found = pickArtifacts(await list(job.arn, "FILE"), await list(job.arn, "LOG"));
  if (found.customer && found.console) return found;
  for (const suite of readArns(await client.call("list-suites", ["--arn", job.arn]), "suites")) {
    for (const test of readArns(await client.call("list-tests", ["--arn", suite]), "tests")) {
      const below = pickArtifacts(await list(test, "FILE"), await list(test, "LOG"));
      found = { customer: found.customer ?? below.customer, console: found.console ?? below.console };
      if (found.customer && found.console) return found;
    }
  }
  return found;
}

export interface Collected {
  results: Array<{ result: Result; dir: string }>;
  /** Plain sentences about subjects or jobs that left nothing to parse. */
  untested: string[];
}

/**
 * Reads a finished run's jobs: downloads each job's console (presigned URLs removed) and customer artifact into the
 * cache, finds every mm/<id>/ kit folder, parses it with lib/devices/result.ts and writes the result under
 * devices/results/devicefarm/. The record (when there is one) says which phone and files the run had.
 */
export async function collectRun(client: DfClient, deps: DfDeps, record: BatchRecord | null, run: DfRun): Promise<Collected> {
  const recorded = record ? recordedRun(record, run) : null;
  const key = recorded?.key ?? runKeyFromName(run.name) ?? "run";
  const stamp = record?.stamp ?? (/^\d{8}T\d{6}Z/.exec(key)?.[0] ?? utcStamp(deps.now()));
  const out: Collected = { results: [], untested: [] };
  for (const job of readJobs(await client.call("list-jobs", ["--arn", run.arn]))) {
    const phone = recorded?.phone ?? phoneOfJob(job);
    const jobDir = path.join(deps.cache, "devicefarm", stamp, key, job.arn.split("/").pop() || "job");
    mkdirSync(jobDir, { recursive: true });
    const { customer, console: spec } = await jobArtifacts(client, job);
    if (spec) writeFileSync(path.join(jobDir, "console.txt"), scrubPresigned((await download(deps, spec)).toString("utf8")));
    const paths: string[] = [];
    if (customer) {
      for (const entry of zipRead(await download(deps, customer))) {
        const file = path.join(jobDir, "artifact", entry.path);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, entry.data);
        paths.push(entry.path);
      }
    } else {
      out.untested.push(
        `${phone.name}: the job left no customer artifact (${job.result || job.status}${job.message ? `: ${job.message}` : ""}).`,
      );
    }
    const dirs = kitDirsIn(paths);
    const ids = recorded ? recorded.subjects.map((s) => s.id) : [...dirs.keys()];
    for (const id of ids) {
      const subject = recorded?.subjects.find((s) => s.id === id) ?? subjectById(id);
      if (!subject) {
        out.untested.push(`${phone.name}, ${id}: not a known subject, and the batch record isn't in the cache.`);
        continue;
      }
      const rel = dirs.get(id);
      const kitDir = rel ? path.join(jobDir, "artifact", rel) : null;
      const hostFile = kitDir ? path.join(kitDir, `host-${id}.txt`) : null;
      const host = hostFile && existsSync(hostFile) ? readKeyValues(readFileSync(hostFile, "utf8")) : null;
      if (!kitDir || !existsSync(path.join(kitDir, "run.txt"))) {
        if (customer) out.untested.push(`${phone.name}, ${id}: not tested: ${notTestedReason(host)}.`);
        continue;
      }
      const result = parseKitOutput(kitDir, {
        cloud: "devicefarm",
        runId: run.arn,
        stamp,
        subject,
        device: kitDevice(phone),
        notes: host ? hostNotes(host) : [],
      });
      out.results.push({ result, dir: writeResult(deps.repoRoot, result, kitDir) });
    }
  }
  return out;
}

const tps = (v: number) => v.toFixed(v >= 10 ? 1 : 2);

export function resultLines(result: Result, dir: string, repoRoot: string): string[] {
  const v = result.verdict;
  const speed = v.genTps === null ? "" : `, ${tps(v.genTps)} tokens a second on ${v.backend}`;
  return [
    `${result.device.name}, ${result.device.marketedRamGiB} GB, ${result.subject.id}: ${v.rating}${speed}` +
      (v.answersTotal ? `, ${v.answersRight} of ${v.answersTotal} answers right.` : "."),
    ...v.reasons.map((r) => `  ${r}`),
    ...result.notes.map((n) => `  Note: ${n}`),
    `  Written to ${path.relative(repoRoot, dir) || dir}.`,
  ];
}

function sayCollected(deps: DfDeps, run: DfRun, collected: Collected): void {
  const minutes = run.deviceMinutes === null ? "" : `, ${run.deviceMinutes} device minutes`;
  deps.say(`${run.name || run.arn}: ${run.result || run.status}${minutes}.`);
  for (const { result, dir } of collected.results) for (const line of resultLines(result, dir, deps.repoRoot)) deps.say(line);
  for (const line of collected.untested) deps.say(`  ${line}`);
}

// ---------------------------------------------------------------------------------------------------------------
// The commands

async function cmdDevices(args: DfArgs, deps: DfDeps, client: DfClient): Promise<number> {
  const phones = await loadPhones(args, client, earlierResults(deps));
  const tiers = [...PHONE_RAM_TIERS_GIB].sort((a, b) => b - a);
  const shown = new Set<Phone>();
  for (const tier of tiers) {
    const inTier = phones.filter((p) => p.ramGiB === tier).sort(comparePhones);
    if (inTier.length === 0) continue;
    deps.say(`${tier} GB (${inTier.length}):`);
    for (const p of inTier) {
      deps.say(`  ${phoneLine(p)}\n    ${p.device.arn}`);
      shown.add(p);
    }
  }
  const unknown = phones.filter((p) => !shown.has(p) && (p.ramGiB === null || p.ramGiB > tiers[0])).sort(comparePhones);
  if (unknown.length) {
    deps.say("RAM not in the table:");
    for (const p of unknown) {
      deps.say(`  ${phoneLine(p)}\n    ${p.device.arn}`);
      shown.add(p);
    }
  }
  const smaller = phones.length - shown.size;
  if (smaller) deps.say(`${smaller} more phones have under ${Math.min(...tiers)} GB and run nothing.`);
  const probes = phones.filter(needsProbe);
  if (probes.length) {
    const names = [...new Set(probes.map((p) => p.device.name))].join(", ");
    deps.say(`RAM only reported, so measured by a smoke run first (run --smoke --probe --yes): ${names}.`);
  }
  return 0;
}

async function cmdPlanOrRun(args: DfArgs, deps: DfDeps, client: DfClient): Promise<number> {
  const results = earlierResults(deps);
  const plan = await makePlan(args, deps, client, results);
  const problems = capProblems(plan.batch, plan.caps, plan.account);
  deps.say(planText(plan.batch, plan.account, plan.caps, plan.notes));

  if (args.dryRun) {
    const built = await buildPackage(plan.batch, plan.templates, deps);
    deps.say(`Built ${built.zip} (${built.files} files, ${mb(built.bytes)}) and ${built.spec}. No AWS call was made.`);
    if (problems.length) {
      deps.say("A real run would refuse this plan:");
      for (const p of problems) deps.say(`  ${p}`);
      return 1;
    }
    deps.say(`To run it: ${runCommand(args, plan.batch, plan.caps)}`);
    return 0;
  }
  if (problems.length) {
    deps.say("Refusing to schedule this plan:");
    for (const p of problems) deps.say(`  ${p}`);
    return 1;
  }
  if (args.command === "plan" || !args.yes) {
    deps.say(`Nothing was scheduled. To run it: ${runCommand(args, plan.batch, plan.caps)}`);
    return 0;
  }
  if (!plan.batch.smoke && !args.skipSmokeCheck && !smokePassed(results)) {
    deps.say(
      "Refusing to schedule large files before a Device Farm smoke run has passed. Run the smoke model first: " +
        "npx tsx scripts/devices/devicefarm.ts run --smoke --yes (or pass --skip-smoke-check).",
    );
    return 1;
  }

  const built = await buildPackage(plan.batch, plan.templates, deps);
  deps.say(`Built the package (${built.files} files, ${mb(built.bytes)}).`);
  const record = batchRecord(plan.batch);
  record.projectArn = await ensureProject(client, deps);
  const names = uploadNames(plan.batch.stamp);
  deps.say(`Uploading ${names.package} and ${names.spec}.`);
  record.packageArn = await uploadFile(client, deps, record.projectArn, names.package, DF_PACKAGE_TYPE, built.zip);
  record.specArn = await uploadFile(client, deps, record.projectArn, names.spec, DF_SPEC_TYPE, built.spec);
  saveRecord(deps.cache, record);

  // From the first ScheduleRun on, every way out stops the runs that haven't finished, so nothing keeps billing.
  const finished = new Set<string>();
  const unfinished = () => record.runs.map((r) => r.arn).filter((a): a is string => a !== null && !finished.has(a));
  const removeInterrupt = deps.onInterrupt(async () => {
    deps.say("Interrupted: stopping the unfinished runs so nothing keeps billing.");
    await stopRuns(client, deps, unfinished(), "interrupted");
  });
  try {
    const targets = {
      projectArn: record.projectArn,
      packageArn: record.packageArn,
      specArn: record.specArn,
      billing: billingFor(plan.account),
    };
    for (const [i, run] of plan.batch.runs.entries()) {
      const scheduled = readRun(await client.call("schedule-run", ["--cli-input-json", JSON.stringify(scheduleRunInput(run, targets))]));
      record.runs[i].arn = scheduled.arn;
      saveRecord(deps.cache, record);
      deps.say(`Scheduled ${scheduled.name || run.key}: ${scheduled.arn}`);
    }
    if (args.detach) {
      deps.say("Not waiting (--detach). The runs bill until they finish. Later:");
      for (const r of record.runs) deps.say(`  npx tsx scripts/devices/devicefarm.ts fetch ${r.arn} --wait`);
      deps.say(`To stop them: npx tsx scripts/devices/devicefarm.ts stop ${record.runs.map((r) => r.arn).join(" ")}`);
      return 0;
    }
    const done = await waitForRuns(client, deps, record.runs, finished);
    let written = 0;
    for (const r of record.runs) {
      const run = r.arn ? done.get(r.arn) : undefined;
      if (!run) continue;
      const collected = await collectRun(client, deps, record, run);
      written += collected.results.length;
      sayCollected(deps, run, collected);
    }
    deps.say(`Wrote ${written} result${written === 1 ? "" : "s"}. The report: npx tsx scripts/devices/report.ts`);
    return written > 0 ? 0 : 1;
  } catch (err) {
    const left = unfinished();
    if (left.length) {
      deps.say(`Stopping ${left.length} unfinished run${left.length === 1 ? "" : "s"} after an error, so nothing keeps billing.`);
      await stopRuns(client, deps, left, "the runner hit an error");
    }
    throw err;
  } finally {
    removeInterrupt();
  }
}

/** Exits 1 when a finished run left no result to write; a run still going without --wait only says so. */
async function cmdFetch(args: DfArgs, deps: DfDeps, client: DfClient): Promise<number> {
  let empty = 0;
  for (const arn of args.arns) {
    let run = readRun(await client.call("get-run", ["--arn", arn]));
    const key = runKeyFromName(run.name);
    const record = key ? loadRecord(deps.cache, key.slice(0, 16)) : null;
    if (!runDone(run)) {
      if (!args.wait) {
        deps.say(`${run.name || arn} is ${run.status}. Fetch it again once it is COMPLETED, or add --wait.`);
        continue;
      }
      const recorded = record ? recordedRun(record, run) : null;
      const waited = await waitForRuns(client, deps, [{ arn, jobTimeoutMinutes: recorded?.jobTimeoutMinutes ?? DF_MAX_JOB_MINUTES }], new Set());
      run = waited.get(arn) ?? run;
    }
    if (!record) deps.say(`No batch record for ${run.name || arn} in the cache: reading the phone from its job.`);
    const collected = await collectRun(client, deps, record, run);
    if (collected.results.length === 0) empty++;
    sayCollected(deps, run, collected);
  }
  return empty > 0 ? 1 : 0;
}

async function cmdStop(args: DfArgs, deps: DfDeps, client: DfClient): Promise<number> {
  await stopRuns(client, deps, args.arns, "asked");
  return 0;
}

export async function main(argv: readonly string[], deps: DfDeps = defaultDeps()): Promise<number> {
  const args = parseDfArgs(argv);
  if (args.help || args.command === null) {
    deps.say(USAGE);
    return args.help ? 0 : 2;
  }
  const client = new DfClient(deps.aws, secretValues(deps.env));
  switch (args.command) {
    case "devices":
      return cmdDevices(args, deps, client);
    case "plan":
    case "run":
      return cmdPlanOrRun(args, deps, client);
    case "fetch":
      return cmdFetch(args, deps, client);
    case "stop":
      return cmdStop(args, deps, client);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`devicefarm.ts: ${message(err)}`);
      process.exit(1);
    },
  );
}
