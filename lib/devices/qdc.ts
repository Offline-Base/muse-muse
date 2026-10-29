/**
 * Qualcomm Device Cloud runs (docs/DEVICES.md "On Qualcomm Device Cloud"): which jobs a batch runs on which chipsets,
 * the job zip QDC extracts under /qdc/appium/ on a host with adb to the phone, and the plan files the carrier and the
 * kit read on the phone. All pure: scripts/devices/qdc.ts does the downloads, writes the zips and parses the results,
 * and devices/qdc/submit.py makes every QDC call, so the API key never passes through TypeScript.
 */
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import { BACKENDS, KIT_DEFAULTS, KIT_SMOKE, type Backend, type KitSettings, type Subject } from "@/lib/devices/types";
import {
  FIXED_PROMPTS,
  GIB,
  isSafeKitValue,
  keepLlamaFile,
  kitEnvFor,
  kitEnvLines,
  marketedRamGiB,
  pickSubjects,
  RAM_SHARE,
  runNeedBytes,
  SMOKE,
  STAND_INS,
  subjectFileName,
  type KitPlace,
  type PickWhy,
} from "@/lib/devices/subjects";

// ---------------------------------------------------------------------------------------------------------------
// The phones

/** The chipsets llama.cpp's own QDC jobs run on [R], in the order a batch takes them. */
export const QDC_CHIPSETS: readonly string[] = ["SM8850", "SM8750", "SM8650"];

/** Their marketing names, for plans and reports. QDC's own chipset_marketing_name wins when a run has it. */
export const QDC_CHIPSET_NAMES: Readonly<Record<string, string>> = {
  SM8850: "Snapdragon 8 Elite Gen 5",
  SM8750: "Snapdragon 8 Elite",
  SM8650: "Snapdragon 8 Gen 3",
};

/** A QDC target as devices/qdc/submit.py prints it: the SDK's TargetType0 fields, camel-cased, enums as their values. */
export interface QdcTarget {
  targetId: string;
  chipset: string;
  marketingName: string;
  platformName: string;
  /** "Mobile", "Compute", "IOT", "Automotive". */
  category: string;
  /** "Android", "Linux", "Windows", "Ubuntu", "QNX". */
  os: string;
  osVersion: string;
  /** "AvailableNow", "DevicesBusy", "Unavailable". */
  state: string;
}

/** True for a target the device tests can use: a phone (Mobile) running Android. */
export function isPhoneTarget(target: Pick<QdcTarget, "category" | "os">): boolean {
  return target.category.toLowerCase() === "mobile" && target.os.toLowerCase() === "android";
}

/**
 * What a probe job (the smoke subject) read on a chipset's phone, kept in devices/qdc/targets.json, since QDC's target
 * list has no RAM. Only facts about the phone: no job ids, user names, serials or other account data.
 */
export interface QdcProbe {
  chipset: string;
  /** MemTotal, the kit's device.txt `ram_kb`. */
  ramKb: number;
  marketedRamGiB: number;
  /** ro.product.model. */
  model: string;
  /** ro.build.version.release and ro.build.version.sdk. */
  android: string;
  sdk: number | null;
  /** ro.soc.model. */
  socModel: string;
  /** When the probe ran, ISO. */
  probedAt: string;
}

/** devices/qdc/targets.json's entries. Throws on a file that isn't a list of probes. */
export function parseProbes(text: string): QdcProbe[] {
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error("targets.json must be a list of probes.");
  return data.map((raw, i) => {
    const p = raw as Partial<QdcProbe>;
    const ok =
      typeof p.chipset === "string" &&
      /^[A-Za-z0-9_-]+$/.test(p.chipset) &&
      typeof p.ramKb === "number" &&
      p.ramKb > 0 &&
      typeof p.marketedRamGiB === "number" &&
      typeof p.model === "string" &&
      typeof p.android === "string" &&
      (p.sdk === null || typeof p.sdk === "number") &&
      typeof p.socModel === "string" &&
      typeof p.probedAt === "string";
    if (!ok) throw new Error(`targets.json entry ${i + 1} isn't a probe (chipset, ramKb, marketedRamGiB, model, android, sdk, socModel, probedAt).`);
    return {
      chipset: p.chipset as string,
      ramKb: p.ramKb as number,
      marketedRamGiB: p.marketedRamGiB as number,
      model: p.model as string,
      android: p.android as string,
      sdk: p.sdk as number | null,
      socModel: p.socModel as string,
      probedAt: p.probedAt as string,
    };
  });
}

/** targets.json's text: QDC_CHIPSETS order first, then by name, two-space JSON with a final newline. */
export function probesText(probes: readonly QdcProbe[]): string {
  const rank = (c: string) => {
    const i = QDC_CHIPSETS.indexOf(c);
    return i < 0 ? QDC_CHIPSETS.length : i;
  };
  const sorted = probes.slice().sort((a, b) => rank(a.chipset) - rank(b.chipset) || a.chipset.localeCompare(b.chipset));
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/** The probe a smoke run's device.txt gives (key=value lines, parsed). Throws without a usable ram_kb. */
export function probeFromDevice(chipset: string, device: Readonly<Record<string, string>>, at: Date): QdcProbe {
  const ramKb = Number(device.ram_kb);
  if (!Number.isInteger(ramKb) || ramKb <= 0) throw new Error(`The probe on ${chipset} has no ram_kb in its device.txt.`);
  const sdk = Number(device.sdk);
  return {
    chipset,
    ramKb,
    marketedRamGiB: marketedRamGiB(ramKb * 1024),
    model: device.model ?? "",
    android: device.android ?? "",
    sdk: Number.isInteger(sdk) && sdk > 0 ? sdk : null,
    socModel: device.soc_model ?? "",
    probedAt: at.toISOString().replace(/\.\d+Z$/, "Z"),
  };
}

/** The list with `probe` in place of any earlier probe of its chipset. */
export function withProbe(probes: readonly QdcProbe[], probe: QdcProbe): QdcProbe[] {
  return [...probes.filter((p) => p.chipset !== probe.chipset), probe];
}

/** Key=value lines (the kit's run.txt, device.txt and model.txt, the carrier's host.txt) as a record; the last wins. */
export function parseKeyValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([a-z0-9_]+)=(.*)$/.exec(line.replace(/\r$/, ""));
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Jobs

/** A job's timeout is the kit's own limits plus this, for QDC's setup, the pip install, the push and the collection. */
export const QDC_SETUP_MINUTES = 15;
export const QDC_MAX_TIMEOUT_MINUTES = 150;
/** QDC wants job names under 32 characters [V, the SDK's submit_job docstring]. */
export const QDC_JOB_NAME_MAX = 31;
export const QDC_MAX_JOBS_DEFAULT = 3;
export const QDC_MAX_JOBS_LIMIT = 10;
/** How often submit.py asks for a job's state, and then for its log upload. */
export const QDC_POLL_SECONDS = 30;
/** How long submit.py lets a job wait for a phone before it aborts it. Waiting doesn't count against QDC minutes [V, FAQ]. */
export const QDC_QUEUE_MINUTES = 360;
/** How long submit.py waits for QDC to finish uploading a job's logs. */
export const QDC_LOG_WAIT_MINUTES = 30;
/** Seconds the carrier gives the kit beyond its own limits before it stops it. */
export const QDC_CARRIER_MARGIN_SECONDS = 300;

/**
 * A job's timeout in minutes: QDC_SETUP_MINUTES plus the kit's download, check and total limits, at most
 * QDC_MAX_TIMEOUT_MINUTES. 125 with KIT_DEFAULTS, 42 with KIT_SMOKE.
 */
export function qdcJobTimeoutMinutes(settings: KitSettings): number {
  const kit = Math.ceil((settings.limitFetch + settings.limitCheck + settings.limitTotal) / 60);
  return Math.min(QDC_MAX_TIMEOUT_MINUTES, QDC_SETUP_MINUTES + kit);
}

/**
 * "mm <chipset> <stamp>", with " <k>" for the k-th job of a chipset when a batch has more than one. Always under 32
 * characters; throws otherwise.
 */
export function qdcJobName(chipset: string, stamp: string, k?: number): string {
  const name = `mm ${chipset} ${stamp}${k === undefined ? "" : ` ${k}`}`;
  if (name.length > QDC_JOB_NAME_MAX) throw new Error(`The job name "${name}" is longer than ${QDC_JOB_NAME_MAX} characters.`);
  return name;
}

/** The run key, "<stamp>-<chipset>-<n>": the job's external_job_id and the plan's MM_RUN. */
export function qdcRunKey(stamp: string, chipset: string, n: number): string {
  const key = `${stamp}-${chipset}-${n}`;
  if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error(`Not a safe run key: ${key}`);
  return key;
}

/**
 * The numbers behind a job's expected minutes [I]: QDC's setup on its host (the pip install, the Appium server, the
 * 300 MB push), the phone's own download from the Hub, the sha256 check, and a fixed time per backend (a bench and
 * three answers; much less for the smoke model). The worst case is always the job's timeout.
 */
export const QDC_ESTIMATE = {
  setupMinutes: 5,
  fetchMBps: 20,
  checkMBps: 250,
  backendMinutes: 8,
  smokeBackendMinutes: 1,
} as const;

/** The expected minutes of one job, rounded up, never more than its timeout. */
export function qdcExpectedMinutes(subject: Subject, backends: readonly Backend[], timeoutMinutes: number): number {
  const mb = subject.bytes / 1e6;
  const perBackend = subject.kind === "smoke" ? QDC_ESTIMATE.smokeBackendMinutes : QDC_ESTIMATE.backendMinutes;
  const minutes =
    QDC_ESTIMATE.setupMinutes +
    mb / QDC_ESTIMATE.fetchMBps / 60 +
    mb / QDC_ESTIMATE.checkMBps / 60 +
    backends.length * perBackend;
  return Math.min(timeoutMinutes, Math.ceil(minutes));
}

/** "probe": the smoke subject on a chipset with no probe yet. "named": a subject the runner was asked for by id. */
export type QdcJobWhy = PickWhy | "probe" | "named";

/** One QDC job: one chipset, one subject, one zip. */
export interface QdcJob {
  /** 1-based, in the batch. */
  n: number;
  key: string;
  name: string;
  chipset: string;
  subject: Subject;
  why: QdcJobWhy;
  settings: KitSettings;
  backends: Backend[];
  timeoutMinutes: number;
  expectedMinutes: number;
}

/** A (chipset, subject) the plan wants, before the cap. `rank` is its place in that chipset's list. */
export interface QdcCandidate {
  chipset: string;
  subject: Subject;
  why: QdcJobWhy;
  rank: number;
}

export interface QdcPlan {
  stamp: string;
  jobs: QdcJob[];
  /** What --max-jobs left for a later run. */
  later: QdcCandidate[];
  /** One plain sentence per chipset: what it gets and why, or why it gets nothing. */
  notes: string[];
}

export interface QdcPlanInput {
  /** utcStamp() of the batch, in every job name and result folder. */
  stamp: string;
  /** QDC_CHIPSETS, or the ones asked for. */
  chipsets: readonly string[];
  /** devices/qdc/targets.json. */
  probes: readonly QdcProbe[];
  /** The files pickSubjects chooses from: STAND_INS, or a tuned repo's files. */
  pool?: readonly Subject[];
  /** --subjects: run exactly these on every probed chipset instead of the picks. */
  named?: readonly Subject[];
  /** --max-jobs, QDC_MAX_JOBS_DEFAULT when unset. */
  maxJobs?: number;
  /** "<chipset> <subject id>" pairs that already have a result, left out (empty with --again). */
  done?: ReadonlySet<string>;
  /** BACKENDS when unset: every QDC phone is a Snapdragon one. */
  backends?: readonly Backend[];
}

function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/**
 * The batch: for each chipset, the smoke probe when it has no probe yet, otherwise the files pickSubjects gives its
 * RAM (or the named ones). Jobs are taken a rank at a time across chipsets (every chipset's first file before any
 * second one) until --max-jobs.
 */
export function planQdcJobs(input: QdcPlanInput): QdcPlan {
  const maxJobs = input.maxJobs ?? QDC_MAX_JOBS_DEFAULT;
  if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > QDC_MAX_JOBS_LIMIT) {
    throw new Error(`--max-jobs must be a whole number from 1 to ${QDC_MAX_JOBS_LIMIT}.`);
  }
  const backends = [...(input.backends ?? BACKENDS)];
  if (backends.length === 0) throw new Error("A QDC job needs at least one backend.");
  const pool = input.pool ?? STAND_INS;
  const done = input.done ?? new Set<string>();
  const notes: string[] = [];
  const candidates: QdcCandidate[] = [];

  for (const chipset of input.chipsets) {
    const label = `${chipset} (${QDC_CHIPSET_NAMES[chipset] ?? "QDC phone"})`;
    const probe = input.probes.find((p) => p.chipset === chipset);
    if (!probe) {
      candidates.push({ chipset, subject: SMOKE, why: "probe", rank: 0 });
      notes.push(`${label}: not probed yet, so it runs the smoke probe, which reads its RAM; its files come next time.`);
      continue;
    }
    const ramBytes = probe.ramKb * 1024;
    const tier = `${probe.marketedRamGiB} GB`;
    let wanted: Array<{ subject: Subject; why: QdcJobWhy }>;
    if (input.named && input.named.length > 0) {
      wanted = input.named.map((subject) => ({ subject, why: "named" as const }));
      const budget = Math.floor(marketedRamGiB(ramBytes) * GIB * RAM_SHARE.android);
      for (const s of input.named) {
        if (runNeedBytes(s) > budget) {
          notes.push(`${label}: ${s.id}'s run needs ${gb(runNeedBytes(s))}, over the ${gb(budget)} budget; the kit's RAM check decides.`);
        }
      }
    } else {
      const picks = pickSubjects({ os: "android", ramBytes }, pool);
      if (picks.length === 0) {
        const smallest = pool.filter((s) => s.kind !== "smoke").slice().sort((a, b) => a.bytes - b.bytes)[0];
        notes.push(
          smallest
            ? `${label}, ${tier}: nothing to run; even ${smallest.id}'s run needs ${gb(runNeedBytes(smallest))}, more than its RAM.`
            : `${label}, ${tier}: no files to choose from.`,
        );
        continue;
      }
      wanted = picks.map((p) => ({ subject: p.subject, why: p.why }));
      const words = picks.map((p) =>
        p.why === "proof"
          ? `${p.subject.id} as the proof (nothing fits the ${gb(p.budgetBytes)} budget)`
          : p.why === "smaller"
            ? `then ${p.subject.id}`
            : `${p.subject.id} (its run needs ${gb(p.needBytes)} of the ${gb(p.budgetBytes)} budget)`,
      );
      notes.push(`${label}, ${tier}: ${words.join(", ")}.`);
    }
    wanted.forEach((w, rank) => {
      if (done.has(`${chipset} ${w.subject.id}`)) {
        notes.push(`${label}: ${w.subject.id} already has a result (--again runs it again).`);
        return;
      }
      candidates.push({ chipset, subject: w.subject, why: w.why, rank });
    });
  }

  const order = candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) => a.c.rank - b.c.rank || a.i - b.i)
    .map((x) => x.c);
  const taken = order.slice(0, maxJobs);
  const later = order.slice(maxJobs);
  const perChipset = new Map<string, number>();
  for (const c of taken) perChipset.set(c.chipset, (perChipset.get(c.chipset) ?? 0) + 1);
  const seen = new Map<string, number>();
  const jobs = taken.map((c, i): QdcJob => {
    const k = (seen.get(c.chipset) ?? 0) + 1;
    seen.set(c.chipset, k);
    const settings = c.subject.kind === "smoke" ? KIT_SMOKE : KIT_DEFAULTS;
    const timeoutMinutes = qdcJobTimeoutMinutes(settings);
    return {
      n: i + 1,
      key: qdcRunKey(input.stamp, c.chipset, i + 1),
      name: qdcJobName(c.chipset, input.stamp, (perChipset.get(c.chipset) ?? 0) > 1 ? k : undefined),
      chipset: c.chipset,
      subject: c.subject,
      why: c.why,
      settings,
      backends,
      timeoutMinutes,
      expectedMinutes: qdcExpectedMinutes(c.subject, backends, timeoutMinutes),
    };
  });
  return { stamp: input.stamp, jobs, later, notes };
}

// ---------------------------------------------------------------------------------------------------------------
// On the phone (the same layout as Device Farm's, docs/DEVICES.md "Interfaces between the parts")

export const QDC_DEVICE_ROOT = "/data/local/tmp/mm";
/** The folder QDC collects from the phone when the job ends [R, llama.cpp's own QDC jobs]. */
export const QDC_LOGS_DIR = "/data/local/tmp/QDC_logs";

/** The two Android builds a job carries, and their folders in mm/ (and on the phone). */
export type QdcBuild = "android-arm64" | "android-arm64-snapdragon";
export const QDC_BUILDS: readonly QdcBuild[] = ["android-arm64", "android-arm64-snapdragon"];
export const QDC_BUILD_DIRS: Readonly<Record<QdcBuild, string>> = {
  "android-arm64": "llama-android",
  "android-arm64-snapdragon": "llama-snapdragon",
};

/**
 * Where one subject's files are on the phone: the plain build for cpu, the Snapdragon build for gpu and npu. `root` is
 * QDC_DEVICE_ROOT on every phone; tests of the adb runner put a phone's folder elsewhere.
 */
export function qdcKitPlace(subject: Subject, root: string = QDC_DEVICE_ROOT): KitPlace {
  return {
    model: `${root}/model/${subjectFileName(subject)}`,
    out: `${root}/out/${subject.id}`,
    system: `${root}/plan/${subject.id}.system`,
    ...(subject.templatePath ? { template: `${root}/plan/${subject.id}.jinja` } : {}),
    llama: {
      cpu: `${root}/${QDC_BUILD_DIRS["android-arm64"]}`,
      gpu: `${root}/${QDC_BUILD_DIRS["android-arm64-snapdragon"]}`,
      npu: `${root}/${QDC_BUILD_DIRS["android-arm64-snapdragon"]}`,
    },
  };
}

/** run.env's MM_PLAN_VERSION; the carrier refuses any other. */
export const QDC_PLAN_VERSION = 1;

/**
 * mm/plan/ for one job, by file name: run.env (MM_PLAN_VERSION, MM_RUN, MM_SUBJECTS), <id>.env (kitEnvLines with the
 * phone's paths and MM_MODEL_URL, so the phone downloads the file itself), <id>.system (the system message, exactly)
 * and <id>.jinja for a subject with templatePath (its text, which the runner read from the Hub).
 */
export function qdcPlanFiles(
  job: Pick<QdcJob, "key" | "subject" | "settings" | "backends">,
  template?: string,
  root: string = QDC_DEVICE_ROOT,
): Record<string, string> {
  const id = job.subject.id;
  if (!isSafeKitValue(job.key) || !/^[a-z0-9][a-z0-9._-]*$/.test(id)) throw new Error(`Unsafe run key or subject id: ${job.key} ${id}`);
  const env = kitEnvFor(job.subject, qdcKitPlace(job.subject, root), { backends: job.backends, settings: job.settings, fetch: true });
  const files: Record<string, string> = {
    "run.env": `MM_PLAN_VERSION=${QDC_PLAN_VERSION}\nMM_RUN=${job.key}\nMM_SUBJECTS=${id}\n`,
    [`${id}.env`]: kitEnvLines(env),
    [`${id}.system`]: job.subject.system,
  };
  if (job.subject.templatePath) {
    if (template === undefined) throw new Error(`${id} needs its ${job.subject.templatePath} from the Hub in the plan.`);
    files[`${id}.jinja`] = template;
  }
  return files;
}

/** The flat name the carrier gives a kit file in QDC_logs, "mm__<subject id>__<file>.log". submit.py undoes it. */
export function qdcLogName(subjectId: string, file: string): string {
  return `mm__${subjectId}__${file}.log`;
}

const LOG_NAME = /(?:^|[^A-Za-z0-9])mm__([a-z0-9][a-z0-9._-]*?)__([A-Za-z0-9][A-Za-z0-9._-]*)\.log$/;

/** The subject id and kit file name in a collected log's name, or null for any other file (QDC's own logs). */
export function parseQdcLogName(name: string): { subjectId: string; file: string } | null {
  const m = LOG_NAME.exec(name);
  return m ? { subjectId: m[1], file: m[2] } : null;
}

// ---------------------------------------------------------------------------------------------------------------
// The job zip (QDC extracts it under /qdc/appium/, installs requirements.txt and runs pytest there [R])

/** The zip's root, from devices/qdc/carrier/ (same paths). */
export const QDC_CARRIER_FILES: readonly string[] = [
  "requirements.txt",
  "pytest.ini",
  "tests/conftest.py",
  "tests/test_mm.py",
  "tests/mm_carrier.py",
];

/**
 * Where a file of a pinned Android build goes in the zip, from its path inside "llama-b11669/", or null for a file
 * keepLlamaFile leaves out. The plain build is flat; the Snapdragon build keeps bin/ and lib/.
 */
export function qdcLlamaZipPath(build: QdcBuild, path: string): string | null {
  if (!keepLlamaFile(path)) return null;
  const parts = path.split("/").filter(Boolean);
  const dir = `mm/${QDC_BUILD_DIRS[build]}`;
  if (build === "android-arm64") return parts.length === 1 ? `${dir}/${parts[0]}` : null;
  if (parts.length === 1) return parts[0] === "LICENSE" ? `${dir}/LICENSE` : null;
  return `${dir}/${parts[0]}/${parts[1]}`;
}

/** The names a job zip can't do without, given its subjects; returns the missing ones (none means it's complete). */
export function qdcZipMissing(names: readonly string[], subjectIds: readonly string[]): string[] {
  const plain = `mm/${QDC_BUILD_DIRS["android-arm64"]}`;
  const snap = `mm/${QDC_BUILD_DIRS["android-arm64-snapdragon"]}`;
  const need = [
    ...QDC_CARRIER_FILES,
    "mm/kit/run.sh",
    ...FIXED_PROMPTS.map((p) => `mm/kit/prompts/${p.id}.txt`),
    `${plain}/llama-bench`,
    `${plain}/llama-completion`,
    `${plain}/libllama.so`,
    `${plain}/libggml-base.so`,
    `${snap}/bin/llama-bench`,
    `${snap}/bin/llama-completion`,
    `${snap}/lib/libllama.so`,
    `${snap}/lib/libggml-cpu.so`,
    `${snap}/lib/libggml-opencl.so`,
    `${snap}/lib/libggml-hexagon.so`,
    "mm/plan/run.env",
    ...subjectIds.flatMap((id) => [`mm/plan/${id}.env`, `mm/plan/${id}.system`]),
  ];
  const have = new Set(names);
  return need.filter((n) => !have.has(n));
}

/** A file for a zip: its path in the zip, its bytes and its Unix permission bits (0o755 or 0o644). */
export interface ZipFile {
  name: string;
  data: Buffer;
  mode: number;
}

/** A file compressed once, so one copy of the builds serves every job zip of a batch. */
export interface PackedFile {
  name: string;
  mode: number;
  crc: number;
  size: number;
  method: 0 | 8;
  data: Buffer;
}

function safeZipName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length < 0xffff &&
    !name.startsWith("/") &&
    !name.includes("\\") &&
    name.split("/").every((p) => p !== "" && p !== "." && p !== "..") &&
    /^[\x21-\x7e]+$/.test(name)
  );
}

/** Deflates a file, or stores it when deflate doesn't make it smaller. */
export function packFile(file: ZipFile): PackedFile {
  if (!safeZipName(file.name)) throw new Error(`Not a safe path in a zip: ${file.name}`);
  const deflated = deflateRawSync(file.data, { level: 6 });
  const method = deflated.length < file.data.length ? 8 : 0;
  return {
    name: file.name,
    mode: file.mode & 0o777,
    crc: crc32(file.data) >>> 0,
    size: file.data.length,
    method,
    data: method === 8 ? deflated : file.data,
  };
}

/** Every entry's time: llama.cpp b11669's release day, so the same files make the same zip. */
const ZIP_DOS_TIME = 0;
const ZIP_DOS_DATE = ((2026 - 1980) << 9) | (10 << 5) | 15;

/** A zip (no zip64: under 4 GiB and 65,535 files) with Unix modes, in the order given. Throws on a repeated name. */
export function zipBytes(files: readonly PackedFile[]): Buffer {
  if (files.length >= 0xffff) throw new Error("Too many files for a zip without zip64.");
  const names = new Set<string>();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    if (names.has(f.name)) throw new Error(`${f.name} is in the zip twice.`);
    names.add(f.name);
    const name = Buffer.from(f.name, "ascii");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(f.method, 8);
    local.writeUInt16LE(ZIP_DOS_TIME, 10);
    local.writeUInt16LE(ZIP_DOS_DATE, 12);
    local.writeUInt32LE(f.crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(f.method, 10);
    central.writeUInt16LE(ZIP_DOS_TIME, 12);
    central.writeUInt16LE(ZIP_DOS_DATE, 14);
    central.writeUInt32LE(f.crc, 16);
    central.writeUInt32LE(f.data.length, 20);
    central.writeUInt32LE(f.size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((0o100000 | f.mode) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, f.data);
    centrals.push(central, name);
    offset += local.length + name.length + f.data.length;
    if (offset > 0xffffffff) throw new Error("The zip is over 4 GiB; zip64 isn't supported.");
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** Every file in a zip (directories left out), with its mode and CRC checked. Stored and deflated entries only. */
export function unzipBytes(zip: Buffer): ZipFile[] {
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("Not a zip: no end of central directory.");
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const out: ZipFile[] = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error("A broken zip: bad central directory entry.");
    const madeBy = zip.readUInt16LE(at + 4) >> 8;
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const packed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const attrs = zip.readUInt32LE(at + 38);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString(flags & 0x800 ? "utf8" : "latin1");
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    if (flags & 0x1) throw new Error(`${name} is encrypted.`);
    if (packed === 0xffffffff || size === 0xffffffff) throw new Error(`${name} needs zip64, which isn't supported.`);
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error(`A broken zip: no local header for ${name}.`);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + packed);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`${name} uses compression method ${method}, which isn't supported.`);
    if (data.length !== size || crc32(data) >>> 0 !== crc) throw new Error(`${name} fails its CRC check.`);
    const mode = madeBy === 3 && attrs >>> 16 ? (attrs >>> 16) & 0o777 : 0o644;
    out.push({ name, data, mode });
  }
  return out;
}

/** The names of the files in a zip that hold any of the values (secrets from the runner's environment), for a refusal. */
export function filesHolding(files: readonly ZipFile[], values: readonly string[]): string[] {
  const needles = values.filter((v) => v.length >= 8).map((v) => Buffer.from(v, "utf8"));
  return files.filter((f) => needles.some((n) => f.data.includes(n))).map((f) => f.name);
}

// ---------------------------------------------------------------------------------------------------------------
// Talking to devices/qdc/submit.py (it alone holds the key)

/** The manifest's version; submit.py refuses any other. */
export const QDC_MANIFEST_VERSION = 1;

export interface QdcManifestJob {
  key: string;
  chipset: string;
  name: string;
  timeoutMinutes: number;
  /** Absolute paths: the job's zip, and the folder submit.py writes job.json, logs/ and out/<subject id>/ into. */
  zip: string;
  outDir: string;
}

export interface QdcManifest {
  version: typeof QDC_MANIFEST_VERSION;
  jobs: QdcManifestJob[];
  pollSeconds: number;
  queueMinutes: number;
  logWaitMinutes: number;
}

/** What `submit.py run --manifest` reads for a batch. */
export function qdcManifest(jobs: readonly QdcJob[], paths: (job: QdcJob) => { zip: string; outDir: string }): QdcManifest {
  return {
    version: QDC_MANIFEST_VERSION,
    jobs: jobs.map((job) => {
      const { zip, outDir } = paths(job);
      if (!zip.startsWith("/") || !outDir.startsWith("/")) throw new Error("A manifest's paths must be absolute.");
      return { key: job.key, chipset: job.chipset, name: job.name, timeoutMinutes: job.timeoutMinutes, zip, outDir };
    }),
    pollSeconds: QDC_POLL_SECONDS,
    queueMinutes: QDC_QUEUE_MINUTES,
    logWaitMinutes: QDC_LOG_WAIT_MINUTES,
  };
}

/** One downloaded log file, as job.json lists it. "failed": it didn't come down. */
export interface QdcLogEntry {
  name: string;
  bytes: number | null;
  kind: "zip" | "raw" | "failed";
  error: string | null;
}

/** job.json, which submit.py writes for every job it handles (and prints in its summary). No user name or org id. */
export interface QdcJobRecord {
  key: string | null;
  chipset: string | null;
  name: string | null;
  targetId: string | null;
  marketingName: string | null;
  jobId: number | null;
  submittedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** The JobState's value ("Completed", "Canceled"), or a state the SDK couldn't parse. */
  state: string | null;
  /** QDC's JobResult ("Successful", "Unsuccessful", "Aborted", "Error"), when known. */
  result: string | null;
  logStatus: string | null;
  /** Why submit.py aborted the job, or null. */
  aborted: string | null;
  error: string | null;
  logs: QdcLogEntry[];
  /** The subjects whose kit folders came back (out/<id>/). */
  subjects: string[];
  carrierLog: boolean;
}

const strOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** A job.json document, checked field by field. Throws on anything that isn't one. */
export function readJobRecord(json: unknown): QdcJobRecord {
  if (!json || typeof json !== "object") throw new Error("A QDC job record must be an object.");
  const r = json as Record<string, unknown>;
  if (r.version !== 1) throw new Error(`A QDC job record of version ${String(r.version)}; this reads version 1.`);
  const jobId = typeof r.jobId === "number" && Number.isInteger(r.jobId) ? r.jobId : null;
  const logs = Array.isArray(r.logs)
    ? r.logs.map((raw): QdcLogEntry => {
        const e = (raw ?? {}) as Record<string, unknown>;
        const kind = e.kind === "zip" || e.kind === "raw" ? e.kind : "failed";
        return { name: String(e.name ?? ""), bytes: typeof e.bytes === "number" ? e.bytes : null, kind, error: strOrNull(e.error) };
      })
    : [];
  const subjects = Array.isArray(r.subjects)
    ? r.subjects.filter((s): s is string => typeof s === "string" && /^[a-z0-9][a-z0-9._-]*$/.test(s))
    : [];
  return {
    key: strOrNull(r.key),
    chipset: strOrNull(r.chipset),
    name: strOrNull(r.name),
    targetId: r.targetId === null || r.targetId === undefined ? null : String(r.targetId),
    marketingName: strOrNull(r.marketingName),
    jobId,
    submittedAt: strOrNull(r.submittedAt),
    startedAt: strOrNull(r.startedAt),
    finishedAt: strOrNull(r.finishedAt),
    state: strOrNull(r.state),
    result: strOrNull(r.result),
    logStatus: strOrNull(r.logStatus),
    aborted: strOrNull(r.aborted),
    error: strOrNull(r.error),
    logs,
    subjects,
    carrierLog: r.carrierLog === true,
  };
}

/** submit.py's stdout for run and fetch: {"version": 1, "jobs": [job.json, ...]}. */
export function readSubmitSummary(text: string): QdcJobRecord[] {
  const data = JSON.parse(text) as { version?: unknown; jobs?: unknown };
  if (data.version !== 1 || !Array.isArray(data.jobs)) throw new Error("submit.py's summary isn't version 1 with a jobs list.");
  return data.jobs.map(readJobRecord);
}

/** submit.py's `targets` output. */
export function readTargets(text: string): QdcTarget[] {
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error("submit.py targets must print a list.");
  return data.map((raw) => {
    const t = (raw ?? {}) as Record<string, unknown>;
    const s = (k: string) => (typeof t[k] === "string" ? (t[k] as string) : "");
    return {
      targetId: s("targetId"),
      chipset: s("chipset"),
      marketingName: s("marketingName"),
      platformName: s("platformName"),
      category: s("category"),
      os: s("os"),
      osVersion: s("osVersion"),
      state: s("state"),
    };
  });
}

/** The batch stamp in a run key "<stamp>-<chipset>-<n>", or null. */
export function stampOfRunKey(key: string): string | null {
  const m = /^(\d{8}T\d{6}Z)-[A-Za-z0-9_]+-\d+$/.exec(key);
  return m ? m[1] : null;
}

/**
 * Plain sentences for a result's notes from how the job went (job.json) and how the carrier ran the kit (its
 * mm__<id>__host.txt.log, key=value lines).
 */
export function carrierNotes(host: Readonly<Record<string, string>> | null, record: QdcJobRecord | null): string[] {
  const notes: string[] = [];
  if (record) {
    const how = [record.state && `ended ${record.state}`, record.result && `QDC's result: ${record.result}`].filter(Boolean);
    notes.push(`QDC job ${record.jobId ?? "(no id)"} on ${record.marketingName ?? record.chipset ?? "a QDC phone"}${how.length ? ` ${how.join(", ")}` : ""}.`);
    if (record.aborted) notes.push(`The submitter aborted the job: ${record.aborted}.`);
    const failed = record.logs.filter((l) => l.kind === "failed").length;
    if (failed > 0) notes.push(`${failed} of the job's log files didn't download, so some kit files may be missing.`);
  }
  if (!host) {
    notes.push("The carrier's host.txt didn't come back.");
    return notes;
  }
  if (host.push_seconds) notes.push(`The carrier pushed the kit and both llama.cpp builds in ${host.push_seconds} s.`);
  if (host.stopped === "1") notes.push(`The carrier stopped the kit after ${host.kit_seconds ?? "?"} s, past the kit's own limits plus its margin.`);
  else if (host.kit_exit && host.kit_exit !== "0") notes.push(`The kit exited with ${host.kit_exit} (2: it refused its inputs, 3: the model was missing or wrong).`);
  const drops = Number(host.adb_errors ?? 0);
  if (drops > 0) notes.push(`adb didn't answer ${drops} of the carrier's polls; the kit kept running on the phone.`);
  return notes;
}

/** A plan as plain lines for the terminal: the jobs, the estimate, what waits for a later run and the notes. */
export function qdcPlanText(plan: QdcPlan, options: { maxJobs: number }): string {
  const lines: string[] = [`QDC batch ${plan.stamp}: ${plan.jobs.length} job${plan.jobs.length === 1 ? "" : "s"} (at most ${options.maxJobs}).`];
  for (const job of plan.jobs) {
    lines.push(
      `  ${job.n}. ${job.name}: ${job.subject.id} (${gb(job.subject.bytes)}, ${job.why}) on ${job.backends.join(", ")}; ` +
        `timeout ${job.timeoutMinutes} min, expected about ${job.expectedMinutes} min.`,
    );
  }
  const expected = plan.jobs.reduce((n, j) => n + j.expectedMinutes, 0);
  const worst = plan.jobs.reduce((n, j) => n + j.timeoutMinutes, 0);
  lines.push(`QDC minutes: about ${expected} expected, ${worst} at most (QDC counts from each test's start; there is no charge).`);
  if (plan.later.length > 0) {
    lines.push(`Later (over --max-jobs): ${plan.later.map((c) => `${c.chipset} ${c.subject.id}`).join(", ")}.`);
  }
  for (const note of plan.notes) lines.push(`- ${note}`);
  return `${lines.join("\n")}\n`;
}
