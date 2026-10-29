/**
 * AWS Device Farm for the device tests (docs/DEVICES.md "On AWS Device Farm"): which Android phones to use and how much
 * RAM they have (ListDevices has no RAM field, so a table from the makers' spec sheets, or the MemTotal a smoke run
 * measured), the plan of runs (one per phone, at most two files each, with its job timeout), the plan files and the
 * test package's layout, the cost estimate and its caps, the ScheduleRun arguments, and reading uploads, runs, jobs and
 * artifacts back, with a small zip writer and reader for the package and the artifacts.
 *
 * Everything here is pure. scripts/devices/devicefarm.ts does the I/O and runs `aws` with awsArgs; devices/devicefarm
 * holds host.sh (the host side of a run), the test spec and the Python carrier Device Farm's upload check needs.
 */
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import {
  KIT_DEFAULTS,
  KIT_SMOKE,
  type Backend,
  type DeviceFacts,
  type KitEnv,
  type KitSettings,
  type LlamaAsset,
  type Result,
  type Subject,
} from "@/lib/devices/types";
import {
  GIB,
  PHONE_RAM_TIERS_GIB,
  SMOKE,
  STAND_INS,
  keepLlamaFile,
  kitEnvFor,
  kitEnvLines,
  llamaAsset,
  marketedRamGiB,
  pickSubjects,
  runNeedBytes,
  subjectFileName,
  subjectUrl,
  type PickWhy,
} from "@/lib/devices/subjects";

// ---------------------------------------------------------------------------------------------------------------
// The service and the owner's account

/** Device Farm runs only in us-west-2, and the owner's account (916979311153) only through this SSO profile. */
export const DF_REGION = "us-west-2";
export const DF_PROFILE = "base-test";
/** Every run goes in this project; the runner creates it once when ListProjects doesn't have it. */
export const DF_PROJECT = "muse-muse-devices";

/** A web test takes no app. The test spec runs host.sh, so the Python carrier in the package is never run. */
export const DF_TEST_TYPE = "APPIUM_WEB_PYTHON";
export const DF_PACKAGE_TYPE = "APPIUM_WEB_PYTHON_TEST_PACKAGE";
export const DF_SPEC_TYPE = "APPIUM_WEB_PYTHON_TEST_SPEC";

/** The metered price of a device minute, and the service's limits [V, the pricing and limits pages, Oct 28]. */
export const DF_USD_PER_MINUTE = 0.17;
export const DF_MAX_JOB_MINUTES = 150;
/** Phones that run at once on a metered account. */
export const DF_CONCURRENCY = 5;
/** Customer artifacts over 1 GB in all are dropped, every one of them. */
export const DF_ARTIFACT_CAP_BYTES = 1_000_000_000;

/** The runner's caps (docs/DEVICES.md "Costs and caps"). */
export const DF_DEFAULT_DEVICES = 3;
export const DF_DEFAULT_SMOKE_DEVICES = 1;
export const DF_DEFAULT_MAX_USD = 60;
export const DF_MAX_FILES_PER_RUN = 2;

/** Minutes a job gets beyond its files: the host's setup, pushing the builds, pulling the results. */
export const JOB_BASE_MINUTES = 5;
/** Seconds host.sh may spend getting one file onto the phone: the download, the host's check and the push, or the stream. */
export const TRANSFER_LIMIT = 1200;
/** The same for the 92 MB smoke file. */
export const SMOKE_TRANSFER_LIMIT = 300;

/** The kit's home on the phone (QDC uses the same layout). */
export const DEVICE_ROOT = "/data/local/tmp/mm";
/** run.env's MM_PLAN_VERSION, bumped when the plan folder's files change. host.sh refuses any other. */
export const PLAN_VERSION = 1;

/**
 * The arguments for `aws devicefarm <command> ...` with the owner's profile, the region and JSON output. Never
 * --debug, which prints signed requests, and never another profile or region.
 */
export function awsArgs(command: string, args: readonly string[] = []): string[] {
  if (!/^[a-z]+(-[a-z]+)*$/.test(command)) throw new Error(`Not a Device Farm command: ${command}`);
  for (const arg of args) {
    if (arg === "--debug" || arg === "--profile" || arg === "--region" || arg === "--output") {
      throw new Error(`awsArgs sets ${arg} itself.`);
    }
  }
  return ["devicefarm", command, ...args, "--profile", DF_PROFILE, "--region", DF_REGION, "--output", "json"];
}

// ---------------------------------------------------------------------------------------------------------------
// Phones and their RAM

/** One phone model and OS version as ListDevices lists it. Its ARN is Device Farm's public device ARN, not account data. */
export interface DfDevice {
  arn: string;
  /** "Samsung Galaxy S25 Ultra", "Google Pixel 10 Pro XL". */
  name: string;
  manufacturer: string;
  model: string;
  modelId: string;
  /** "15", "8.1.0". */
  os: string;
  /** HIGHLY_AVAILABLE, AVAILABLE, BUSY or TEMPORARY_NOT_AVAILABLE. */
  availability: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** The public Android phones in a ListDevices answer ({ devices: [...] }). */
export function androidPhones(listDevices: unknown): DfDevice[] {
  const devices = (listDevices as { devices?: unknown } | null)?.devices;
  if (!Array.isArray(devices)) throw new Error("ListDevices answered without a devices list.");
  const out: DfDevice[] = [];
  for (const raw of devices as Array<Record<string, unknown> | null>) {
    if (!raw || raw.platform !== "ANDROID" || raw.formFactor !== "PHONE") continue;
    if (raw.fleetType !== undefined && raw.fleetType !== "PUBLIC") continue;
    const arn = str(raw.arn);
    const name = str(raw.name);
    if (!arn.startsWith("arn:aws:devicefarm:") || !name) continue;
    out.push({
      arn,
      name,
      manufacturer: str(raw.manufacturer),
      model: str(raw.model),
      modelId: str(raw.modelId),
      os: str(raw.os),
      availability: str(raw.availability),
    });
  }
  return out;
}

export type SocFamily = "snapdragon" | "tensor" | "exynos" | "mediatek";

/**
 * What the makers' spec sheets say about a phone model. ListDevices' `memory` is storage and `heapSize` the Java heap
 * (devices/devicefarm/fixtures/README.md), so RAM comes from here, or from a smoke run's MemTotal.
 */
export interface PhoneSpec {
  /** Device Farm's device name, exactly. */
  name: string;
  /** The RAM it is sold with, in GB; for "variants" the smallest; null when unknown. */
  ramGiB: number | null;
  /**
   * "spec": the maker's spec sheet. "variants": sold with more than one size, so the smallest (a larger one only
   * makes the kit's own check pass more easily). "reported": press reports of the launched phone, not a spec sheet I
   * could read; a smoke run confirms it before any large file. "unknown": newer than every source; probe it.
   */
  ramFrom: "spec" | "variants" | "reported" | "unknown";
  soc: SocFamily;
  /** "Snapdragon 8 Elite for Galaxy", "Tensor G5". */
  chipName: string;
  /** Qualcomm's part number (ro.soc.model) for Snapdragon phones. */
  chip?: string;
  /** The year it went on sale, to prefer newer phones. */
  year: number;
}

const phone = (
  name: string,
  ramGiB: number | null,
  ramFrom: PhoneSpec["ramFrom"],
  soc: SocFamily,
  chipName: string,
  year: number,
  chip?: string,
): PhoneSpec => ({ name, ramGiB, ramFrom, soc, chipName, year, ...(chip ? { chip } : {}) });

/**
 * RAM, chip and year for the phones Device Farm lists (devices/devicefarm/fixtures/list-devices-android-phones.json),
 * from the makers' spec sheets as I know them [R]. Samsung's are the US models Device Farm has (U and U1), which use
 * Snapdragon chips since the S20. Pixels from the 6 on use Google's Tensor chips: no Adreno and no Hexagon, so only the
 * CPU backend runs there. The Galaxy A, LG and Redmi phones are left out: none is sold with 12 GB in the US models.
 * The Galaxy S26 phones (12 GB at 256 GB, US models on the SM8850) and the Pixel 11 phones (12 GB at 256 GB, the size
 * Device Farm lists; 16 GB from 512 GB) come from retailer and spec-site listings on Oct 28, 2026, so they are
 * "reported": a smoke run measures them before any large file.
 */
export const PHONE_SPECS: readonly PhoneSpec[] = [
  phone("Google Pixel 2 XL", 4, "spec", "snapdragon", "Snapdragon 835", 2017, "MSM8998"),
  phone("Google Pixel 3", 4, "spec", "snapdragon", "Snapdragon 845", 2018, "SDM845"),
  phone("Google Pixel 3 XL", 4, "spec", "snapdragon", "Snapdragon 845", 2018, "SDM845"),
  phone("Google Pixel 3a", 4, "spec", "snapdragon", "Snapdragon 670", 2019, "SDM670"),
  phone("Google Pixel 3a XL", 4, "spec", "snapdragon", "Snapdragon 670", 2019, "SDM670"),
  phone("Google Pixel 4 (Unlocked)", 6, "spec", "snapdragon", "Snapdragon 855", 2019, "SM8150"),
  phone("Google Pixel 4a", 6, "spec", "snapdragon", "Snapdragon 730G", 2020, "SM7150"),
  phone("Google Pixel 5 (Unlocked)", 8, "spec", "snapdragon", "Snapdragon 765G", 2020, "SM7250"),
  phone("Google Pixel 5a 5G", 6, "spec", "snapdragon", "Snapdragon 765G", 2021, "SM7250"),
  phone("Google Pixel 6 (Unlocked)", 8, "spec", "tensor", "Tensor", 2021),
  phone("Google Pixel 6 Pro (Unlocked)", 12, "spec", "tensor", "Tensor", 2021),
  phone("Google Pixel 7", 8, "spec", "tensor", "Tensor G2", 2022),
  phone("Google Pixel 7 Pro", 12, "spec", "tensor", "Tensor G2", 2022),
  phone("Google Pixel 7a", 8, "spec", "tensor", "Tensor G2", 2023),
  phone("Google Pixel 8", 8, "spec", "tensor", "Tensor G3", 2023),
  phone("Google Pixel 8 Pro", 12, "spec", "tensor", "Tensor G3", 2023),
  phone("Google Pixel 8a", 8, "spec", "tensor", "Tensor G3", 2024),
  phone("Google Pixel 9", 12, "spec", "tensor", "Tensor G4", 2024),
  phone("Google Pixel 9 Pro", 16, "spec", "tensor", "Tensor G4", 2024),
  phone("Google Pixel 9 Pro XL", 16, "spec", "tensor", "Tensor G4", 2024),
  phone("Google Pixel 9a", 8, "spec", "tensor", "Tensor G4", 2025),
  phone("Google Pixel 10", 12, "spec", "tensor", "Tensor G5", 2025),
  phone("Google Pixel 10 Pro", 16, "spec", "tensor", "Tensor G5", 2025),
  phone("Google Pixel 10 Pro XL", 16, "spec", "tensor", "Tensor G5", 2025),
  phone("Google Pixel 11", 12, "reported", "tensor", "Tensor G6", 2026),
  phone("Google Pixel 11 Pro", 12, "reported", "tensor", "Tensor G6", 2026),
  phone("Google Pixel 11 Pro XL", 12, "reported", "tensor", "Tensor G6", 2026),
  phone("Samsung Galaxy S9 (Unlocked)", 4, "spec", "snapdragon", "Snapdragon 845", 2018, "SDM845"),
  phone("Samsung Galaxy S9+ (Unlocked)", 6, "spec", "snapdragon", "Snapdragon 845", 2018, "SDM845"),
  phone("Samsung Galaxy S10", 8, "spec", "snapdragon", "Snapdragon 855", 2019, "SM8150"),
  phone("Samsung Galaxy S20 (Unlocked)", 12, "spec", "snapdragon", "Snapdragon 865", 2020, "SM8250"),
  phone("Samsung Galaxy S21", 8, "spec", "snapdragon", "Snapdragon 888", 2021, "SM8350"),
  phone("Samsung Galaxy S21 Ultra", 12, "variants", "snapdragon", "Snapdragon 888", 2021, "SM8350"),
  phone("Samsung Galaxy S22 5G", 8, "spec", "snapdragon", "Snapdragon 8 Gen 1", 2022, "SM8450"),
  phone("Samsung Galaxy S22+ 5G", 8, "spec", "snapdragon", "Snapdragon 8 Gen 1", 2022, "SM8450"),
  phone("Samsung Galaxy S22 Ultra 5G", 8, "variants", "snapdragon", "Snapdragon 8 Gen 1", 2022, "SM8450"),
  phone("Samsung Galaxy S23", 8, "spec", "snapdragon", "Snapdragon 8 Gen 2 for Galaxy", 2023, "SM8550"),
  phone("Samsung Galaxy S23+", 8, "spec", "snapdragon", "Snapdragon 8 Gen 2 for Galaxy", 2023, "SM8550"),
  phone("Samsung Galaxy S23 Ultra", 8, "variants", "snapdragon", "Snapdragon 8 Gen 2 for Galaxy", 2023, "SM8550"),
  phone("Samsung Galaxy S24", 8, "spec", "snapdragon", "Snapdragon 8 Gen 3 for Galaxy", 2024, "SM8650"),
  phone("Samsung Galaxy S24+", 12, "spec", "snapdragon", "Snapdragon 8 Gen 3 for Galaxy", 2024, "SM8650"),
  phone("Samsung Galaxy S24 Ultra", 12, "spec", "snapdragon", "Snapdragon 8 Gen 3 for Galaxy", 2024, "SM8650"),
  phone("Samsung Galaxy S25", 12, "spec", "snapdragon", "Snapdragon 8 Elite for Galaxy", 2025, "SM8750"),
  phone("Samsung Galaxy S25+", 12, "spec", "snapdragon", "Snapdragon 8 Elite for Galaxy", 2025, "SM8750"),
  phone("Samsung Galaxy S25 Ultra", 12, "spec", "snapdragon", "Snapdragon 8 Elite for Galaxy", 2025, "SM8750"),
  phone("Samsung Galaxy S26", 12, "reported", "snapdragon", "Snapdragon 8 Elite Gen 5 for Galaxy", 2026, "SM8850"),
  phone("Samsung Galaxy S26+", 12, "reported", "snapdragon", "Snapdragon 8 Elite Gen 5 for Galaxy", 2026, "SM8850"),
  phone("Samsung Galaxy S26 Ultra", 12, "reported", "snapdragon", "Snapdragon 8 Elite Gen 5 for Galaxy", 2026, "SM8850"),
  phone("Samsung Galaxy Note20", 8, "spec", "exynos", "Exynos 990", 2020),
  phone("Xiaomi 12", 8, "variants", "snapdragon", "Snapdragon 8 Gen 1", 2021, "SM8450"),
  phone("Xiaomi 13", 8, "variants", "snapdragon", "Snapdragon 8 Gen 2", 2022, "SM8550"),
  phone("Xiaomi 13 Pro", 8, "variants", "snapdragon", "Snapdragon 8 Gen 2", 2022, "SM8550"),
];

export function phoneSpec(name: string): PhoneSpec | null {
  const key = name.trim().toLowerCase();
  return PHONE_SPECS.find((s) => s.name.toLowerCase() === key) ?? null;
}

/**
 * The Snapdragon chips the Snapdragon build has an NPU library for (libggml-htp-v73, v75, v79, v81) and whose CPUs
 * run its armv8.7a code: 8 Gen 2, 8 Gen 3, 8 Elite and 8 Elite Gen 5. Older Snapdragons get the CPU backend only.
 */
export const SNAPDRAGON_BUILD_CHIPS: readonly string[] = ["SM8550", "SM8650", "SM8750", "SM8850"];

/** The Snapdragon build targets Android 14 (API 34) [V]; the kit skips gpu and npu below it anyway. */
export const SNAPDRAGON_MIN_ANDROID = 14;

export function androidMajor(os: string): number {
  const m = /^(\d+)/.exec(os.trim());
  return m ? Number(m[1]) : 0;
}

/**
 * The backends to ask the kit for, in bench order: cpu first (the plain build, every phone), then gpu and npu on a
 * Snapdragon phone the Snapdragon build supports with Android 14 or later. A phone not in the table gets all three on
 * Android 14 or later, since the kit lists the devices it has and skips the others.
 */
export function backendsFor(spec: PhoneSpec | null, os: string): Backend[] {
  if (androidMajor(os) < SNAPDRAGON_MIN_ANDROID) return ["cpu"];
  if (!spec) return ["cpu", "gpu", "npu"];
  if (spec.soc === "snapdragon" && spec.chip && SNAPDRAGON_BUILD_CHIPS.includes(spec.chip)) return ["cpu", "gpu", "npu"];
  return ["cpu"];
}

/** A Device Farm phone with what the plan needs to know about it. */
export interface Phone {
  device: DfDevice;
  spec: PhoneSpec | null;
  /** The marketed RAM the plan uses, in GB, or null until a smoke run measures it. */
  ramGiB: number | null;
  ramFrom: PhoneSpec["ramFrom"] | "measured" | "none";
  backends: Backend[];
}

/**
 * The phone for a ListDevices entry. `measured` maps a device ARN or a lowercase device name to the MemTotal a smoke
 * run read on it (measuredRam); it wins over the table.
 */
export function phoneFor(device: DfDevice, measured: ReadonlyMap<string, number> = new Map()): Phone {
  const spec = phoneSpec(device.name);
  const ram = measured.get(device.arn) ?? measured.get(device.name.toLowerCase());
  const backends = backendsFor(spec, device.os);
  if (ram !== undefined && ram > 0) return { device, spec, ramGiB: marketedRamGiB(ram), ramFrom: "measured", backends };
  if (!spec) return { device, spec, ramGiB: null, ramFrom: "none", backends };
  return { device, spec, ramGiB: spec.ramGiB, ramFrom: spec.ramFrom, backends };
}

/** True when the phone's RAM is known well enough to pick large files for it. */
export function ramKnown(phone: Phone): boolean {
  return phone.ramGiB !== null && (phone.ramFrom === "spec" || phone.ramFrom === "variants" || phone.ramFrom === "measured");
}

/** True for a phone in the table whose RAM a smoke run should measure first: the newest models. */
export function needsProbe(phone: Phone): boolean {
  return phone.spec !== null && phone.ramFrom !== "measured" && (phone.ramFrom === "reported" || phone.ramFrom === "unknown");
}

/**
 * The MemTotal each phone reported in earlier results (result.json files of devices/results/devicefarm), by device
 * ARN and by lowercase device name, the newest result winning.
 */
export function measuredRam(
  results: ReadonlyArray<{ cloud: string; stamp: string; device: { cloudId?: string; name?: string; ramBytes?: number } }>,
): Map<string, number> {
  const out = new Map<string, number>();
  const sorted = results.filter((r) => r.cloud === "devicefarm").slice().sort((a, b) => a.stamp.localeCompare(b.stamp));
  for (const r of sorted) {
    const ram = r.device.ramBytes;
    if (!ram || ram <= 0) continue;
    if (r.device.cloudId) out.set(r.device.cloudId, ram);
    if (r.device.name) out.set(r.device.name.toLowerCase(), ram);
  }
  return out;
}

const AVAILABILITY_RANK: Record<string, number> = { HIGHLY_AVAILABLE: 0, AVAILABLE: 1, BUSY: 2 };

/** Better first: more backends, newer, more available, newer Android, then by name and ARN so the order is stable. */
export function comparePhones(a: Phone, b: Phone): number {
  return (
    b.backends.length - a.backends.length ||
    (b.spec?.year ?? 0) - (a.spec?.year ?? 0) ||
    (AVAILABILITY_RANK[a.device.availability] ?? 3) - (AVAILABILITY_RANK[b.device.availability] ?? 3) ||
    androidMajor(b.device.os) - androidMajor(a.device.os) ||
    a.device.name.localeCompare(b.device.name) ||
    a.device.arn.localeCompare(b.device.arn)
  );
}

const chipOf = (p: Phone) => p.spec?.chipName ?? "unknown";

/** The best instance of each model (Device Farm lists one ARN per model and Android version). */
function bestPerModel(phones: readonly Phone[]): Phone[] {
  const byModel = new Map<string, Phone>();
  for (const p of phones) {
    const key = p.device.name.toLowerCase();
    const prev = byModel.get(key);
    if (!prev || comparePhones(p, prev) < 0) byModel.set(key, p);
  }
  return [...byModel.values()].sort(comparePhones);
}

/** Takes one phone from each group in turn until `max`, preferring in each group a chip it hasn't had yet. */
function roundRobin(groups: Phone[][], max: number): Phone[] {
  const queues = groups.map((g) => g.slice());
  const chips = groups.map(() => new Set<string>());
  const chosen: Phone[] = [];
  while (chosen.length < max && queues.some((q) => q.length > 0)) {
    for (let i = 0; i < queues.length && chosen.length < max; i++) {
      const q = queues[i];
      if (q.length === 0) continue;
      const at = Math.max(0, q.findIndex((p) => !chips[i].has(chipOf(p))));
      const [p] = q.splice(at, 1);
      chips[i].add(chipOf(p));
      chosen.push(p);
    }
  }
  return chosen;
}

/**
 * The phones for a plan: for each RAM tier in turn (12, 16, 24 GB; Device Farm lists none with 24), the best phone
 * whose RAM is known, one per model, preferring Snapdragon phones (three backends), newer ones and a chip the tier
 * hasn't had yet. Phones Device Farm marks TEMPORARY_NOT_AVAILABLE are left out.
 */
export function choosePhones(
  phones: readonly Phone[],
  options: { maxDevices: number; tiers?: readonly number[] },
): Phone[] {
  const tiers = options.tiers ?? PHONE_RAM_TIERS_GIB;
  const pool = bestPerModel(
    phones.filter((p) => ramKnown(p) && p.device.availability !== "TEMPORARY_NOT_AVAILABLE"),
  );
  return roundRobin(
    tiers.map((t) => pool.filter((p) => p.ramGiB === t)),
    options.maxDevices,
  );
}

/** The phones a probe should measure: the newest models whose RAM isn't confirmed, one per model, varied chips. */
export function chooseProbes(phones: readonly Phone[], options: { maxDevices: number }): Phone[] {
  const pool = bestPerModel(phones.filter((p) => needsProbe(p) && p.device.availability !== "TEMPORARY_NOT_AVAILABLE"));
  return roundRobin([pool], options.maxDevices);
}

/**
 * The phones for a smoke run before any large file: the best ones whatever their RAM (the smoke model needs 92 MB), so
 * the first run tries every backend on the newest chip, and measures the RAM of a phone whose RAM is only reported.
 */
export function chooseSmoke(phones: readonly Phone[], options: { maxDevices: number }): Phone[] {
  const pool = bestPerModel(phones.filter((p) => p.device.availability !== "TEMPORARY_NOT_AVAILABLE"));
  return roundRobin([pool], options.maxDevices);
}

/** Phones by the names or ARNs the owner gave (--device), in that order. Throws on one that matches nothing. */
export function namedPhones(phones: readonly Phone[], names: readonly string[]): Phone[] {
  const out: Phone[] = [];
  for (const name of names) {
    const key = name.trim().toLowerCase();
    const matches = phones.filter((p) => p.device.arn.toLowerCase() === key || p.device.name.toLowerCase() === key);
    if (matches.length === 0) throw new Error(`No Device Farm phone is named ${name}.`);
    const best = matches.slice().sort(comparePhones)[0];
    if (!out.includes(best)) out.push(best);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The plan: runs, their files and their time limits

/** How host.sh gets a file onto the phone: by the host's free disk ("auto"), always a download and a push, or always a stream. */
export type CopyMode = "auto" | "push" | "stream";
export const COPY_MODES: readonly CopyMode[] = ["auto", "push", "stream"];

export interface PlannedSubject {
  subject: Subject;
  /** pickSubjects' reason, "named" for --subjects, "smoke" for the smoke model. */
  why: PickWhy | "named" | "smoke";
  /** The phone's budget pickSubjects used, when it chose. */
  budgetBytes: number | null;
  settings: KitSettings;
  /** The kit's environment on the phone (kitEnvFor), written to <id>.env. */
  env: KitEnv;
}

/** One ScheduleRun: one phone, at most two files, run by host.sh in this order. */
export interface PlannedRun {
  /** "<stamp>-<nn>": the plan folder's name, MM_PLAN on the run, and part of its name. */
  key: string;
  phone: Phone;
  subjects: PlannedSubject[];
  transferLimit: number;
  jobTimeoutMinutes: number;
}

export interface Batch {
  /** utcStamp when it was planned: the folder of its package and the results' last folder. */
  stamp: string;
  smoke: boolean;
  copy: CopyMode;
  /** One package serves every run. */
  runs: PlannedRun[];
  /** Phones that were chosen or named but get no run, with the reason in plain words. */
  skipped: Array<{ phone: Phone; why: string }>;
}

export interface BatchOptions {
  stamp: string;
  /** The smoke model with KIT_SMOKE's limits, instead of the picked files. */
  smoke?: boolean;
  /** Files every phone runs instead of pickSubjects' choice (--subjects), when its RAM can hold them at all. */
  subjects?: readonly Subject[];
  /** What pickSubjects chooses from: STAND_INS, or a tuned repo's files (fetchTunedSubjects). */
  pool?: readonly Subject[];
  /** Only these backends, where a phone has them (--backends). */
  backends?: readonly Backend[];
  copy?: CopyMode;
  /** Seconds per copy; TRANSFER_LIMIT, or SMOKE_TRANSFER_LIMIT for smoke runs. */
  transferLimit?: number;
}

/** Where a run's files are on the phone (DEVICE_ROOT, docs/DEVICES.md "Interfaces between the parts"). */
export function devicePlace(key: string, subject: Subject) {
  return {
    model: `${DEVICE_ROOT}/model/${subjectFileName(subject)}`,
    out: `${DEVICE_ROOT}/out/${subject.id}`,
    system: `${DEVICE_ROOT}/plan/${key}/${subject.id}.system`,
    ...(subject.templatePath ? { template: `${DEVICE_ROOT}/plan/${key}/${subject.id}.jinja` } : {}),
    llama: {
      cpu: `${DEVICE_ROOT}/llama-android`,
      gpu: `${DEVICE_ROOT}/llama-snapdragon`,
      npu: `${DEVICE_ROOT}/llama-snapdragon`,
    },
  };
}

/**
 * A job's timeout: JOB_BASE_MINUTES plus, for each file, its copy limit, the kit's check limit and its total limit.
 * Two files with the defaults: 5 + 2 x (1200 + 600 + 2400) / 60 = 145 minutes.
 */
export function jobTimeoutMinutes(settings: readonly KitSettings[], transferLimit: number): number {
  const seconds = settings.reduce((sum, s) => sum + transferLimit + s.limitCheck + s.limitTotal, 0);
  return JOB_BASE_MINUTES + Math.ceil(seconds / 60);
}

type Choice = { subject: Subject; why: PlannedSubject["why"]; budgetBytes: number | null };

function picksFor(phone: Phone, options: BatchOptions): { picks: Choice[]; why: string } {
  if (options.smoke) return { picks: [{ subject: SMOKE, why: "smoke", budgetBytes: null }], why: "" };
  const ram = phone.ramGiB === null ? null : phone.ramGiB * GIB;
  if (options.subjects) {
    const picks = options.subjects
      .filter((s) => ram === null || runNeedBytes(s) <= ram)
      .map((s): Choice => ({ subject: s, why: s.kind === "smoke" ? "smoke" : "named", budgetBytes: null }));
    return { picks, why: `none of the named files fits its ${phone.ramGiB} GB of RAM` };
  }
  if (ram === null || !ramKnown(phone)) {
    return { picks: [], why: "its RAM isn't confirmed: measure it first with a smoke run (run --smoke --probe)" };
  }
  const picks = pickSubjects({ os: "android", ramBytes: ram }, options.pool ?? STAND_INS).map(
    (p): Choice => ({ subject: p.subject, why: p.why, budgetBytes: p.budgetBytes }),
  );
  return { picks, why: `no file's run fits its ${phone.ramGiB} GB of RAM` };
}

/**
 * The batch for these phones, in order: each phone's files (the smoke model, the named files, or pickSubjects' choice
 * by its RAM) in runs of at most DF_MAX_FILES_PER_RUN whose job fits DF_MAX_JOB_MINUTES, each subject with its kit
 * environment for the phone's paths.
 */
export function planBatch(phones: readonly Phone[], options: BatchOptions): Batch {
  if (!/^\d{8}T\d{6}Z$/.test(options.stamp)) throw new Error(`Not a UTC stamp: ${options.stamp}`);
  const smoke = options.smoke ?? false;
  const transferLimit = options.transferLimit ?? (smoke ? SMOKE_TRANSFER_LIMIT : TRANSFER_LIMIT);
  if (!Number.isInteger(transferLimit) || transferLimit < 60) throw new Error("The transfer limit must be at least 60 seconds.");
  const runs: PlannedRun[] = [];
  const skipped: Batch["skipped"] = [];
  const models = new Set<string>();
  for (const p of phones) {
    // Results are filed by model, subject and the batch's stamp, so a second phone of the same model would overwrite them.
    const model = p.device.name.toLowerCase();
    if (models.has(model)) {
      skipped.push({ phone: p, why: "the batch already has this model (one per model per batch)" });
      continue;
    }
    models.add(model);
    const backends = options.backends ? p.backends.filter((b) => options.backends?.includes(b)) : p.backends;
    if (backends.length === 0) {
      skipped.push({ phone: p, why: `it has none of the backends asked for (${options.backends?.join(", ")})` });
      continue;
    }
    const { picks, why } = picksFor(p, options);
    if (picks.length === 0) {
      skipped.push({ phone: p, why });
      continue;
    }
    const settingsOf = (c: Choice) => (c.why === "smoke" ? KIT_SMOKE : KIT_DEFAULTS);
    let group: Choice[] = [];
    const flush = () => {
      if (group.length === 0) return;
      const key = `${options.stamp}-${String(runs.length + 1).padStart(2, "0")}`;
      const subjects = group.map((c): PlannedSubject => {
        const settings = settingsOf(c);
        const env = kitEnvFor(c.subject, devicePlace(key, c.subject), { backends, settings });
        return { subject: c.subject, why: c.why, budgetBytes: c.budgetBytes, settings, env };
      });
      runs.push({
        key,
        phone: p,
        subjects,
        transferLimit,
        jobTimeoutMinutes: jobTimeoutMinutes(subjects.map((s) => s.settings), transferLimit),
      });
      group = [];
    };
    for (const c of picks) {
      const tooLong = jobTimeoutMinutes([...group, c].map(settingsOf), transferLimit) > DF_MAX_JOB_MINUTES;
      if (group.length > 0 && (group.length >= DF_MAX_FILES_PER_RUN || tooLong)) flush();
      group.push(c);
    }
    flush();
  }
  return { stamp: options.stamp, smoke, copy: options.copy ?? "auto", runs, skipped };
}

/** The run's name on Device Farm: "mm <key> <phone>", which `fetch` reads the key back from. */
export function runName(run: Pick<PlannedRun, "key" | "phone">): string {
  return `mm ${run.key} ${run.phone.device.name}`.slice(0, 256);
}

/** The run key in a run's name, or null. */
export function runKeyFromName(name: string): string | null {
  const m = /^mm (\d{8}T\d{6}Z-\d{2})\b/.exec(name);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------------------------------------------
// The account, the estimate and the caps

/** What the plan needs from GetAccountSettings. The account number is never kept. */
export interface DfAccount {
  trialMinutesLeft: number | null;
  unmeteredAndroid: number;
  maxJobTimeoutMinutes: number | null;
}

export function readAccount(json: unknown): DfAccount {
  const s = (json as { accountSettings?: Record<string, unknown> } | null)?.accountSettings;
  if (!s || typeof s !== "object") throw new Error("GetAccountSettings answered without accountSettings.");
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const trial = s.trialMinutes as { remaining?: unknown } | undefined;
  const unmetered = s.unmeteredDevices as Record<string, unknown> | undefined;
  return {
    trialMinutesLeft: num(trial?.remaining),
    unmeteredAndroid: num(unmetered?.ANDROID) ?? 0,
    maxJobTimeoutMinutes: num(s.maxJobTimeoutMinutes),
  };
}

/** METERED unless the account has unmetered Android slots (it has none: fixtures/README.md). */
export function billingFor(account: DfAccount | null): "METERED" | "UNMETERED" {
  return account && account.unmeteredAndroid > 0 ? "UNMETERED" : "METERED";
}

/**
 * The expected time of a run [I]: 3 minutes to start, each copy at 25 MB/s, each check at 250 MB/s, and 8 minutes per
 * backend per file (most of a minute for the smoke model). The worst case is the job's timeout.
 */
export const ESTIMATE = {
  startMinutes: 3,
  copyBytesPerSecond: 25_000_000,
  checkBytesPerSecond: 250_000_000,
  backendMinutes: 8,
  smokeBackendMinutes: 0.75,
} as const;

export interface Estimate {
  expectedMinutes: number;
  worstMinutes: number;
  expectedUsd: number;
  worstUsd: number;
}

export function usd(minutes: number): number {
  return Math.round(minutes * DF_USD_PER_MINUTE * 100) / 100;
}

export function estimateRun(run: PlannedRun): Estimate {
  let minutes = ESTIMATE.startMinutes;
  for (const s of run.subjects) {
    const backends = (s.env.MM_BACKENDS ?? "cpu").split(",").length;
    minutes += s.subject.bytes / ESTIMATE.copyBytesPerSecond / 60 + s.subject.bytes / ESTIMATE.checkBytesPerSecond / 60;
    minutes += backends * (s.why === "smoke" ? ESTIMATE.smokeBackendMinutes : ESTIMATE.backendMinutes);
  }
  const expectedMinutes = Math.round(minutes * 10) / 10;
  return { expectedMinutes, worstMinutes: run.jobTimeoutMinutes, expectedUsd: usd(minutes), worstUsd: usd(run.jobTimeoutMinutes) };
}

export function estimateBatch(batch: Batch): Estimate {
  const runs = batch.runs.map(estimateRun);
  const expected = runs.reduce((sum, e) => sum + e.expectedMinutes, 0);
  const worst = runs.reduce((sum, e) => sum + e.worstMinutes, 0);
  return { expectedMinutes: Math.round(expected * 10) / 10, worstMinutes: worst, expectedUsd: usd(expected), worstUsd: usd(worst) };
}

export interface Caps {
  /** Phones in the batch (--max-devices), at most DF_CONCURRENCY. */
  maxDevices: number;
  /** The worst case's cost in dollars (--max-usd). */
  maxUsd: number;
}

/** Why a batch can't be scheduled under these caps, in plain sentences; empty when it can. */
export function capProblems(batch: Batch, caps: Caps, account: DfAccount | null = null): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(caps.maxDevices) || caps.maxDevices < 1 || caps.maxDevices > DF_CONCURRENCY) {
    problems.push(`--max-devices must be from 1 to ${DF_CONCURRENCY}, the phones Device Farm runs at once.`);
  }
  const phones = new Set(batch.runs.map((r) => r.phone.device.arn));
  if (phones.size > caps.maxDevices) problems.push(`The plan uses ${phones.size} phones, over --max-devices ${caps.maxDevices}.`);
  const maxJob = Math.min(DF_MAX_JOB_MINUTES, account?.maxJobTimeoutMinutes ?? DF_MAX_JOB_MINUTES);
  for (const run of batch.runs) {
    if (run.subjects.length > DF_MAX_FILES_PER_RUN) problems.push(`Run ${run.key} has ${run.subjects.length} files, over ${DF_MAX_FILES_PER_RUN}.`);
    if (run.jobTimeoutMinutes > maxJob) {
      problems.push(`Run ${run.key} needs a ${run.jobTimeoutMinutes}-minute job timeout, over Device Farm's ${maxJob}.`);
    }
  }
  const worst = estimateBatch(batch).worstUsd;
  if (worst > caps.maxUsd) problems.push(`The worst case costs $${worst.toFixed(2)}, over --max-usd ${caps.maxUsd}.`);
  if (batch.runs.length === 0) problems.push("The plan has no runs.");
  return problems;
}

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(2)} GB`;
const money = (v: number) => `$${v.toFixed(2)}`;

function whyText(s: PlannedSubject, phone: Phone): string {
  const budget = s.budgetBytes === null ? "" : ` ${(s.budgetBytes / 1e9).toFixed(1)} GB`;
  switch (s.why) {
    case "fits":
      return `the largest file whose run fits its${budget} budget`;
    case "smaller":
      return "the step down";
    case "proof":
      return `the proof: nothing fits its${budget} budget, and this fits its ${phone.ramGiB} GB`;
    case "named":
      return "named";
    case "smoke":
      return "the smoke model";
  }
}

function ramText(p: Phone): string {
  const from: Record<Phone["ramFrom"], string> = {
    spec: "spec sheet",
    variants: "the smallest model sold",
    reported: "reported, not confirmed",
    unknown: "unknown",
    measured: "measured",
    none: "not in the RAM table",
  };
  return p.ramGiB === null ? `RAM ${from[p.ramFrom]}` : `${p.ramGiB} GB (${from[p.ramFrom]})`;
}

/** One line about a phone, for `devices` and the plan. */
export function phoneLine(p: Phone): string {
  const chip = p.spec ? p.spec.chipName : "chip unknown";
  return `${p.device.name}, Android ${p.device.os}, ${ramText(p)}, ${chip}, backends ${p.backends.join(",")}, ${p.device.availability || "availability unknown"}`;
}

/** The plan as the runner prints it: each run with its files, limits and cost, then the totals and the caps. */
export function planText(batch: Batch, account: DfAccount | null, caps: Caps, notes: readonly string[] = []): string {
  const lines: string[] = [];
  const total = estimateBatch(batch);
  const phones = new Set(batch.runs.map((r) => r.phone.device.arn)).size;
  lines.push(
    `Device Farm plan ${batch.stamp}${batch.smoke ? " (smoke)" : ""}: ${batch.runs.length} run${batch.runs.length === 1 ? "" : "s"} on ${phones} phone${phones === 1 ? "" : "s"}` +
      ` (${DF_REGION}, profile ${DF_PROFILE}, project ${DF_PROJECT}).`,
  );
  batch.runs.forEach((run, i) => {
    const e = estimateRun(run);
    lines.push("");
    lines.push(`${i + 1}. ${phoneLine(run.phone)}`);
    lines.push(`   ${run.phone.device.arn}`);
    for (const s of run.subjects) lines.push(`   ${s.subject.id}, ${gb(s.subject.bytes)}: ${whyText(s, run.phone)}`);
    lines.push(
      `   run ${run.key}: backends ${run.subjects[0]?.env.MM_BACKENDS ?? "-"}; job timeout ${run.jobTimeoutMinutes} min; ` +
        `expected ${e.expectedMinutes} min (${money(e.expectedUsd)}), worst ${e.worstMinutes} min (${money(e.worstUsd)})`,
    );
  });
  lines.push("");
  lines.push(
    `In all: expected ${total.expectedMinutes} min (${money(total.expectedUsd)}), worst ${total.worstMinutes} min (${money(total.worstUsd)}) at $${DF_USD_PER_MINUTE} a device minute.`,
  );
  if (account) {
    const trial = account.trialMinutesLeft;
    lines.push(
      `Billing ${billingFor(account)}: ${account.unmeteredAndroid} unmetered Android slots; ` +
        (trial === null ? "no trial minutes reported." : `${trial} trial minutes left, which ${trial >= total.worstMinutes ? "cover the worst case" : trial >= total.expectedMinutes ? "cover the expected time but not the worst case" : "don't cover the expected time"}.`),
    );
  } else {
    lines.push("Billing: not read (no AWS call). The fixture README reported 620.25 trial minutes and no unmetered slots on Oct 28.");
  }
  lines.push(`Caps: ${phones} of --max-devices ${caps.maxDevices} phones; worst case ${money(total.worstUsd)} of --max-usd ${caps.maxUsd}.`);
  for (const s of batch.skipped) lines.push(`Not run: ${s.phone.device.name}: ${s.why}.`);
  for (const n of notes) lines.push(n);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// Scheduling and watching runs

/** The uploads' names: a test package's must end in .zip (CreateUpload) and a test spec's in .yml (UpdateUpload) [V]. */
export function uploadNames(stamp: string): { package: string; spec: string } {
  if (!/^\d{8}T\d{6}Z$/.test(stamp)) throw new Error(`Not a UTC stamp: ${stamp}`);
  return { package: `mm-devices-${stamp}.zip`, spec: `mm-devices-${stamp}.yml` };
}

/** Both uploads are created with this content type and sent with it, since a presigned PUT checks a type it was signed with. */
export const UPLOAD_CONTENT_TYPE = "application/octet-stream";

/** Where ScheduleRun points a run: the project, the batch's two uploads, and how it is billed. */
export interface ScheduleTargets {
  projectArn: string;
  packageArn: string;
  specArn: string;
  billing: "METERED" | "UNMETERED";
}

const isDfArn = (arn: string) => arn.startsWith(`arn:aws:devicefarm:${DF_REGION}:`);

/**
 * ScheduleRun's input for one run, for `aws devicefarm schedule-run --cli-input-json`: the run's one phone by ARN, the
 * batch's package and spec, MM_PLAN naming the run's plan folder, its job timeout, and no video (a video can reach
 * 1 GB of artifacts). No app: a web test takes none.
 */
export function scheduleRunInput(run: PlannedRun, targets: ScheduleTargets) {
  for (const arn of [targets.projectArn, targets.packageArn, targets.specArn, run.phone.device.arn]) {
    if (!isDfArn(arn)) throw new Error(`Not a Device Farm ARN in ${DF_REGION}: ${arn}`);
  }
  if (!Number.isInteger(run.jobTimeoutMinutes) || run.jobTimeoutMinutes < 5 || run.jobTimeoutMinutes > DF_MAX_JOB_MINUTES) {
    throw new Error(`Run ${run.key}'s job timeout of ${run.jobTimeoutMinutes} minutes isn't from 5 to ${DF_MAX_JOB_MINUTES}.`);
  }
  if (run.subjects.length === 0 || run.subjects.length > DF_MAX_FILES_PER_RUN) {
    throw new Error(`Run ${run.key} has ${run.subjects.length} files; a run takes 1 to ${DF_MAX_FILES_PER_RUN}.`);
  }
  return {
    projectArn: targets.projectArn,
    name: runName(run),
    deviceSelectionConfiguration: {
      filters: [{ attribute: "ARN", operator: "IN", values: [run.phone.device.arn] }],
      maxDevices: 1,
    },
    test: { type: DF_TEST_TYPE, testPackageArn: targets.packageArn, testSpecArn: targets.specArn },
    configuration: {
      billingMethod: targets.billing,
      environmentVariables: [{ name: "MM_PLAN", value: run.key }],
    },
    executionConfiguration: { jobTimeoutMinutes: run.jobTimeoutMinutes, videoCapture: false },
  };
}

/** GetRun statuses before the run has its phone, so before any device minute. */
const QUEUED_STATUSES = new Set(["PENDING", "PENDING_CONCURRENCY", "PENDING_DEVICE", "PROCESSING", "SCHEDULING"]);

/** Seconds between GetRun calls, how long a run may wait for its phone, and how far past its job timeout it may go. */
export const POLL_SECONDS = 60;
export const QUEUE_LIMIT_MINUTES = 360;
export const OVERRUN_MINUTES = 20;

export interface RunWatch {
  /** Epoch ms: when the runner scheduled the run, and when it first saw the run with its phone. */
  scheduledAt: number;
  startedAt: number | null;
  jobTimeoutMinutes: number;
}

/**
 * The watch after a fresh GetRun status, and why the runner should stop the run now (null: let it go on). Device Farm
 * stops a job at its own timeout; this is the runner's backstop, so nothing bills for hours if that fails.
 */
export function watchRun(watch: RunWatch, status: string, now: number): { watch: RunWatch; stop: string | null } {
  if (status === "COMPLETED" || status === "STOPPING") return { watch, stop: null };
  if (QUEUED_STATUSES.has(status)) {
    const waited = (now - watch.scheduledAt) / 60_000;
    return {
      watch,
      stop: waited > QUEUE_LIMIT_MINUTES ? `it waited ${Math.round(waited)} minutes for its phone` : null,
    };
  }
  const next = watch.startedAt === null ? { ...watch, startedAt: now } : watch;
  const ran = (now - (next.startedAt ?? now)) / 60_000;
  const limit = next.jobTimeoutMinutes + OVERRUN_MINUTES;
  return {
    watch: next,
    stop: ran > limit ? `it ran ${Math.round(ran)} minutes, past its ${next.jobTimeoutMinutes}-minute job timeout` : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The plan folder and the test package

export interface TextFile {
  /** The path inside the test package. */
  path: string;
  text: string;
}

/** run.env: what host.sh needs for the whole run (docs/DEVICES.md "On AWS Device Farm"). */
export function runEnvText(run: PlannedRun, copy: CopyMode): string {
  return [
    `MM_PLAN_VERSION=${PLAN_VERSION}`,
    `MM_RUN=${run.key}`,
    `MM_SUBJECTS=${run.subjects.map((s) => s.subject.id).join(",")}`,
    `MM_TRANSFER_LIMIT=${run.transferLimit}`,
    `MM_COPY=${copy}`,
    "",
  ].join("\n");
}

/**
 * The files of mm/plan/<key>/: run.env, and per subject <id>.env (the kit's environment), <id>.system (the system
 * message, exactly), <id>.url (the file's public URL for the host to download; never a token) and <id>.jinja for a
 * subject with templatePath (its text from `templates`, by subject id).
 */
export function planFiles(run: PlannedRun, copy: CopyMode, templates: ReadonlyMap<string, string> = new Map()): TextFile[] {
  const dir = `mm/plan/${run.key}`;
  const files: TextFile[] = [{ path: `${dir}/run.env`, text: runEnvText(run, copy) }];
  for (const s of run.subjects) {
    const id = s.subject.id;
    files.push({ path: `${dir}/${id}.env`, text: kitEnvLines(s.env) });
    files.push({ path: `${dir}/${id}.system`, text: s.subject.system });
    files.push({ path: `${dir}/${id}.url`, text: `${subjectUrl(s.subject)}\n` });
    if (s.subject.templatePath) {
      const template = templates.get(id);
      if (template === undefined) throw new Error(`${id} needs its ${s.subject.templatePath} in the plan.`);
      files.push({ path: `${dir}/${id}.jinja`, text: template });
    }
  }
  return files;
}

/** A pinned wheel of the carrier's wheelhouse, from PyPI, checked by sha256. */
export interface CarrierWheel {
  name: string;
  version: string;
  file: string;
  bytes: number;
  sha256: string;
  url: string;
}

const PYPI = "https://files.pythonhosted.org/packages";

/**
 * pytest 8.4.2 and what it installs, read from PyPI on Oct 28, 2026: versions from the same months that still take
 * Python 3.9, plus exceptiongroup and tomli, which pytest needs below Python 3.11 and which install on any later
 * Python, so `pip install --no-index --find-links wheelhouse -r requirements.txt` works whatever Python the upload
 * check uses. Every one is a py3-none-any wheel, the only kind the check takes besides linux_x86_64.
 */
export const CARRIER_WHEELS: readonly CarrierWheel[] = [
  {
    name: "pytest",
    version: "8.4.2",
    file: "pytest-8.4.2-py3-none-any.whl",
    bytes: 365750,
    sha256: "872f880de3fc3a5bdc88a11b39c9710c3497a547cfa9320bc3c5e62fbf272e79",
    url: `${PYPI}/a8/a4/20da314d277121d6534b3a980b29035dcd51e6744bd79075a6ce8fa4eb8d/pytest-8.4.2-py3-none-any.whl`,
  },
  {
    name: "iniconfig",
    version: "2.1.0",
    file: "iniconfig-2.1.0-py3-none-any.whl",
    bytes: 6050,
    sha256: "9deba5723312380e77435581c6bf4935c94cbfab9b1ed33ef8d238ea168eb760",
    url: `${PYPI}/2c/e1/e6716421ea10d38022b952c159d5161ca1193197fb744506875fbb87ea7b/iniconfig-2.1.0-py3-none-any.whl`,
  },
  {
    name: "packaging",
    version: "25.0",
    file: "packaging-25.0-py3-none-any.whl",
    bytes: 66469,
    sha256: "29572ef2b1f17581046b3a2227d5c611fb25ec70ca1ba8554b24b0e69331a484",
    url: `${PYPI}/20/12/38679034af332785aac8774540895e234f4d07f7545804097de4b666afd8/packaging-25.0-py3-none-any.whl`,
  },
  {
    name: "pluggy",
    version: "1.6.0",
    file: "pluggy-1.6.0-py3-none-any.whl",
    bytes: 20538,
    sha256: "e920276dd6813095e9377c0bc5566d94c932c33b27a3e3945d8389c374dd4746",
    url: `${PYPI}/54/20/4d324d65cc6d9205fabedc306948156824eb9f0ee1633355a8f7ec5c66bf/pluggy-1.6.0-py3-none-any.whl`,
  },
  {
    name: "pygments",
    version: "2.19.2",
    file: "pygments-2.19.2-py3-none-any.whl",
    bytes: 1225217,
    sha256: "86540386c03d588bb81d44bc3928634ff26449851e99741617ecb9037ee5ec0b",
    url: `${PYPI}/c7/21/705964c7812476f378728bdf590ca4b771ec72385c533964653c68e86bdc/pygments-2.19.2-py3-none-any.whl`,
  },
  {
    name: "exceptiongroup",
    version: "1.2.2",
    file: "exceptiongroup-1.2.2-py3-none-any.whl",
    bytes: 16453,
    sha256: "3111b9d131c238bec2f8f516e123e14ba243563fb135d3fe885990585aa7795b",
    url: `${PYPI}/02/cc/b7e31358aac6ed1ef2bb790a9746ac2c69bcb3c8588b41616914eb106eaf/exceptiongroup-1.2.2-py3-none-any.whl`,
  },
  {
    name: "tomli",
    version: "2.2.1",
    file: "tomli-2.2.1-py3-none-any.whl",
    bytes: 14257,
    sha256: "cb55c73c5f4408779d0cf3eef9f762b9c9f147a77de7b258bef0a5628adc85cc",
    url: `${PYPI}/6e/c2/61d3e0f47e2b74ef40a68b9e6ad5984f6241a942f7cd3bbfbdbd03861ea9/tomli-2.2.1-py3-none-any.whl`,
  },
];

/** devices/devicefarm/carrier/requirements.txt: one exact pin per wheel, nothing else (no comments, no markers). */
export function carrierRequirements(wheels: readonly CarrierWheel[] = CARRIER_WHEELS): string {
  return wheels.map((w) => `${w.name}==${w.version}\n`).join("");
}

/** Where a package file comes from: the repo's carrier, host.sh or kit folders, a staged build, or the wheelhouse. */
export type PackageRoot = "carrier" | "host" | "kit" | "android" | "snapdragon" | "wheelhouse";

export interface PackageEntry {
  /** The path inside the zip. */
  path: string;
  mode: number;
  /** A file to copy, relative to its root... */
  from?: { root: PackageRoot; path: string };
  /** ...or a text to write. */
  text?: string;
}

export interface PackageInput {
  /** Files of devices/kit, relative to it ("run.sh", "prompts/capital.txt"). */
  kitFiles: readonly string[];
  /** Files of the extracted builds, relative to their "llama-b11669/" folder. */
  androidFiles: readonly string[];
  snapdragonFiles: readonly string[];
  wheels?: readonly CarrierWheel[];
  /** planFiles of every run in the batch. */
  plans: readonly TextFile[];
}

const EXECUTABLE = /(^|\/)(llama-bench|llama-completion|run\.sh|host\.sh)$|\.so$/;

/**
 * The test package's files, sorted: the carrier Device Farm's upload check needs (requirements.txt, tests/, the
 * wheelhouse) and our files under mm/: host.sh, the kit, both Android builds trimmed by keepLlamaFile (the plain one
 * flat, the Snapdragon one with bin/ and lib/), and every run's plan folder.
 */
export function packageEntries(input: PackageInput): PackageEntry[] {
  const entries: PackageEntry[] = [];
  const file = (path: string, root: PackageRoot, from: string) =>
    entries.push({ path, mode: EXECUTABLE.test(path) ? 0o755 : 0o644, from: { root, path: from } });
  file("requirements.txt", "carrier", "requirements.txt");
  file("tests/test_carrier.py", "carrier", "tests/test_carrier.py");
  for (const w of input.wheels ?? CARRIER_WHEELS) file(`wheelhouse/${w.file}`, "wheelhouse", w.file);
  file("mm/host.sh", "host", "host.sh");
  if (!input.kitFiles.includes("run.sh")) throw new Error("The kit has no run.sh.");
  for (const f of input.kitFiles) {
    if (!safeRelative(f) || f.split("/").some((part) => part.startsWith("."))) continue;
    file(`mm/kit/${f}`, "kit", f);
  }
  // Each build keeps its pinned layout: host.sh and the kit look for the plain build's tools at its top and the
  // Snapdragon build's in bin/.
  const builds: Array<[PackageRoot, readonly string[], string, LlamaAsset["layout"]]> = [
    ["android", input.androidFiles, "mm/llama-android", llamaAsset("android-arm64").layout],
    ["snapdragon", input.snapdragonFiles, "mm/llama-snapdragon", llamaAsset("android-arm64-snapdragon").layout],
  ];
  for (const [root, files, dir, layout] of builds) {
    const kept = files.filter((f) => safeRelative(f) && keepLlamaFile(f));
    for (const tool of ["llama-bench", "llama-completion"]) {
      const at = layout === "bin-lib" ? `bin/${tool}` : tool;
      if (!kept.includes(at)) throw new Error(`The ${root} build has no ${at}.`);
    }
    for (const f of kept) file(`${dir}/${f}`, root, f);
  }
  for (const p of input.plans) {
    if (!p.path.startsWith("mm/plan/") || !safeRelative(p.path)) throw new Error(`Not a plan file: ${p.path}`);
    entries.push({ path: p.path, mode: 0o644, text: p.text });
  }
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.path)) throw new Error(`The package has ${e.path} twice.`);
    seen.add(e.path);
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/** The test spec: every phase runs host.sh, and Device Farm keeps $DEVICEFARM_LOG_DIR (devices/devicefarm/testspec.yml). */
export function testSpecYaml(): string {
  const phases = ["install", "pre_test", "test", "post_test"];
  return [
    "# The Muse Muse device tests on AWS Device Farm (docs/DEVICES.md \"On AWS Device Farm\"). Every phase runs mm/host.sh",
    "# from the test package on the Amazon Linux 2023 host, which has adb to the phone; MM_PLAN, set on each run, names",
    "# its folder in mm/plan/. Appium is never started. lib/devices/devicefarm.ts testSpecYaml writes the same text.",
    "version: 0.1",
    "",
    "android_test_host: amazon_linux_2023",
    "",
    "phases:",
    ...phases.flatMap((p) => [`  ${p}:`, "    commands:", `      - bash "$DEVICEFARM_TEST_PACKAGE_PATH/mm/host.sh" ${p}`]),
    "",
    "artifacts:",
    "  - $DEVICEFARM_LOG_DIR",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// Secrets

/**
 * Patterns no package, plan, log or result may hold: an AWS access key id, AWS credential lines, a presigned URL's
 * signature, a Hugging Face token, a QDC key assignment.
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /\bA(?:KIA|SIA)[0-9A-Z]{16}\b/,
  /aws_secret_access_key\s*[=:]/i,
  /aws_session_token\s*[=:]/i,
  /X-Amz-(?:Signature|Credential|Security-Token)=/i,
  /\bhf_[A-Za-z0-9]{30,}\b/,
  /\bQDC_API_KEY=\S/,
];

const SECRET_NAMES = /^(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AWS_SECURITY_TOKEN|HF_TOKEN|HUGGING_FACE_HUB_TOKEN|HUGGINGFACE_TOKEN|QDC_API_KEY)$|(_TOKEN|_SECRET|_API_KEY|_PASSWORD)$/;

/** The values of the secret-looking variables in an environment, so a scan can look for them too. Never printed. */
export function secretValues(env: Readonly<Record<string, string | undefined>>): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= 8 && SECRET_NAMES.test(name)) out.push({ name, value });
  }
  return out;
}

/** What a text holds that it mustn't: pattern descriptions and secret variable names, never the values. */
export function secretHits(text: string, values: ReadonlyArray<{ name: string; value: string }> = []): string[] {
  const hits: string[] = [];
  for (const p of SECRET_PATTERNS) if (p.test(text)) hits.push(`something matching ${p.source}`);
  for (const v of values) if (text.includes(v.value)) hits.push(`the value of ${v.name}`);
  return hits;
}

/** Removes every URL that carries an AWS signature or credential (CreateUpload's and ListArtifacts' presigned URLs). */
export function scrubPresigned(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>]+/g, (url) =>
    /x-amz-(signature|credential|security-token)|signature=|awsaccesskeyid=/i.test(url) ? "[presigned URL removed]" : url,
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Reading Device Farm's answers

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

export interface DfUpload {
  arn: string;
  /** INITIALIZED, PROCESSING, SUCCEEDED or FAILED. */
  status: string;
  /** CreateUpload's presigned PUT URL: a credential while it lasts, so never logged or stored. */
  url: string;
  message: string;
  /** What the upload check found (JSON text), scrubbed and cut to 2,000 characters, for a refused upload's error. */
  metadata: string;
}

export function readUpload(json: unknown): DfUpload {
  const u = obj(obj(json).upload);
  if (typeof u.arn !== "string") throw new Error("Device Farm answered without an upload.");
  return {
    arn: u.arn,
    status: str(u.status),
    url: str(u.url),
    message: scrubPresigned(str(u.message)),
    metadata: scrubPresigned(str(u.metadata)).slice(0, 2000),
  };
}

export function readProjects(json: unknown): Array<{ arn: string; name: string }> {
  const list = obj(json).projects;
  return Array.isArray(list)
    ? list.map(obj).filter((p) => typeof p.arn === "string").map((p) => ({ arn: String(p.arn), name: str(p.name) }))
    : [];
}

export function readProject(json: unknown): { arn: string; name: string } {
  const p = obj(obj(json).project);
  if (typeof p.arn !== "string") throw new Error("CreateProject answered without a project.");
  return { arn: p.arn, name: str(p.name) };
}

export interface DfRun {
  arn: string;
  name: string;
  /** PENDING, PENDING_CONCURRENCY, PENDING_DEVICE, PROCESSING, SCHEDULING, PREPARING, RUNNING, COMPLETED or STOPPING. */
  status: string;
  /** PENDING, PASSED, WARNED, FAILED, SKIPPED, ERRORED or STOPPED. */
  result: string;
  message: string;
  /** Device minutes billed so far, when Device Farm says. */
  deviceMinutes: number | null;
}

const minutesOf = (v: unknown) => {
  const total = obj(v).total;
  return typeof total === "number" ? total : null;
};

export function readRun(json: unknown): DfRun {
  const r = obj(obj(json).run);
  if (typeof r.arn !== "string") throw new Error("Device Farm answered without a run.");
  return {
    arn: r.arn,
    name: str(r.name),
    status: str(r.status),
    result: str(r.result),
    message: scrubPresigned(str(r.message)),
    deviceMinutes: minutesOf(r.deviceMinutes),
  };
}

export function runDone(run: Pick<DfRun, "status">): boolean {
  return run.status === "COMPLETED";
}

export interface DfJob {
  arn: string;
  status: string;
  result: string;
  message: string;
  device: { arn: string; name: string; manufacturer: string; model: string; os: string };
  deviceMinutes: number | null;
}

export function readJobs(json: unknown): DfJob[] {
  const list = obj(json).jobs;
  if (!Array.isArray(list)) return [];
  return list.map(obj).filter((j) => typeof j.arn === "string").map((j) => {
    const d = obj(j.device);
    return {
      arn: String(j.arn),
      status: str(j.status),
      result: str(j.result),
      message: scrubPresigned(str(j.message)),
      device: { arn: str(d.arn), name: str(d.name), manufacturer: str(d.manufacturer), model: str(d.model), os: str(d.os) },
      deviceMinutes: minutesOf(j.deviceMinutes),
    };
  });
}

/** Suites or tests (ListSuites, ListTests): their ARNs, to look for artifacts below a job. */
export function readArns(json: unknown, key: "suites" | "tests"): string[] {
  const list = obj(json)[key];
  return Array.isArray(list) ? list.map(obj).map((x) => str(x.arn)).filter(Boolean) : [];
}

export interface DfArtifact {
  arn: string;
  name: string;
  /** CUSTOMER_ARTIFACT (the zip of $DEVICEFARM_LOG_DIR), TESTSPEC_OUTPUT (the spec's console), DEVICE_LOG and others. */
  type: string;
  extension: string;
  /** A presigned GET URL: a credential while it lasts, so never logged or stored. */
  url: string;
}

export function readArtifacts(json: unknown): DfArtifact[] {
  const list = obj(json).artifacts;
  if (!Array.isArray(list)) return [];
  return list
    .map(obj)
    .filter((a) => typeof a.arn === "string" && typeof a.url === "string")
    .map((a) => ({ arn: String(a.arn), name: str(a.name), type: str(a.type), extension: str(a.extension), url: String(a.url) }));
}

/** key=value lines (the kit's and host.sh's files): the key [a-z0-9_]+, the value the rest of the line. */
export function readKeyValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([a-z0-9_]+)=(.*)$/.exec(line.replace(/\r$/, ""));
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/**
 * The kit folders in an unzipped customer artifact, by subject id: every folder ".../mm/<id>/" holding run.txt or
 * host-<id>.txt. Device Farm's zip may put $DEVICEFARM_LOG_DIR under a folder of its own, so the prefix can be anything.
 */
export function kitDirsIn(paths: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of paths) {
    const m = /^(?:(.*)\/)?mm\/([a-z0-9][a-z0-9._-]*)\/(run\.txt|host-([a-z0-9][a-z0-9._-]*)\.txt)$/i.exec(p);
    if (!m) continue;
    const [, prefix, id, , hostId] = m;
    if (hostId !== undefined && hostId !== id) continue;
    if (!out.has(id)) out.set(id, `${prefix ? `${prefix}/` : ""}mm/${id}`);
  }
  return out;
}

const kbGb = (kb: string) => `${((Number(kb) * 1024) / 1e9).toFixed(1)} GB`;

/** Plain sentences about how host.sh got a file onto the phone (host-<id>.txt), for the result's notes. */
export function hostNotes(host: Readonly<Record<string, string>>): string[] {
  const notes: string[] = [];
  const s = (k: string) => host[k] ?? "";
  switch (s("copy")) {
    case "push":
      notes.push(
        `The Device Farm host downloaded the file in ${s("download_seconds") || "?"} s, ` +
          `${s("host_sha256") === "ok" ? "checked its sha256" : "didn't check its sha256"} and pushed it with adb in ${s("push_seconds") || "?"} s.`,
      );
      break;
    case "stream":
      notes.push(`The file was streamed from the Hub to the phone in ${s("stream_seconds") || "?"} s; the kit's check was the only sha256 check.`);
      break;
    case "present":
      notes.push("The file was already on the phone.");
      break;
    case "ram_skip":
      notes.push(`The phone's MemTotal (${s("mem_total_kb")} kB) is under the file's run need (${s("min_ram_kb")} kB), so nothing was copied.`);
      break;
  }
  if (s("adb_dropped") === "1") notes.push("The adb session dropped while the kit ran; the host waited for the kit to finish.");
  if (s("kit_finished") === "0") notes.push("The kit hadn't finished when the host stopped waiting for it.");
  return notes;
}

/** Why a subject has no kit output to parse (its folder has no run.txt), from host-<id>.txt, in plain words. */
export function notTestedReason(host: Readonly<Record<string, string>> | null): string {
  if (!host) return "the artifacts have nothing for it (the job may have stopped before it)";
  const why = host.copy_why ? ` (${host.copy_why})` : "";
  if (host.copy === "no_space") {
    return `the phone had ${kbGb(host.phone_free_kb ?? "0")} free in /data/local/tmp, short of the file plus 1 GiB`;
  }
  if (host.copy === "failed") return `the copy to the phone failed${why}`;
  if (host.kit_rc === "2") return "the kit refused its inputs (see the console file)";
  return "the kit left no run.txt";
}

/** The two artifacts a job's results come from: the zip of $DEVICEFARM_LOG_DIR (ListArtifacts FILE) and the spec's console (LOG). */
export function pickArtifacts(
  files: readonly DfArtifact[],
  logs: readonly DfArtifact[],
): { customer: DfArtifact | null; console: DfArtifact | null } {
  return {
    customer: files.find((a) => a.type === "CUSTOMER_ARTIFACT") ?? null,
    console: logs.find((a) => a.type === "TESTSPEC_OUTPUT") ?? null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// A batch's record, and what the results need from it

/** What a batch's record keeps about a phone: its public device ARN and names, and the RAM it was planned with. */
export interface RecordedPhone {
  arn: string;
  name: string;
  manufacturer: string;
  model: string;
  os: string;
  ramGiB: number | null;
  ramFrom: Phone["ramFrom"];
}

export interface RecordedRun {
  key: string;
  /** The run's ARN once ScheduleRun answered. */
  arn: string | null;
  jobTimeoutMinutes: number;
  phone: RecordedPhone;
  subjects: Subject[];
}

/**
 * <cache>/devicefarm/<stamp>/batch.json, written as the runs are scheduled: what `fetch` and `stop` need later. Device
 * Farm ARNs and the plan only: no presigned URL and no credential.
 */
export interface BatchRecord {
  version: typeof PLAN_VERSION;
  stamp: string;
  smoke: boolean;
  copy: CopyMode;
  projectArn: string | null;
  packageArn: string | null;
  specArn: string | null;
  runs: RecordedRun[];
}

export function recordedPhone(p: Phone): RecordedPhone {
  const d = p.device;
  return { arn: d.arn, name: d.name, manufacturer: d.manufacturer, model: d.model, os: d.os, ramGiB: p.ramGiB, ramFrom: p.ramFrom };
}

export function batchRecord(batch: Batch): BatchRecord {
  return {
    version: PLAN_VERSION,
    stamp: batch.stamp,
    smoke: batch.smoke,
    copy: batch.copy,
    projectArn: null,
    packageArn: null,
    specArn: null,
    runs: batch.runs.map((r) => ({
      key: r.key,
      arn: null,
      jobTimeoutMinutes: r.jobTimeoutMinutes,
      phone: recordedPhone(r.phone),
      subjects: r.subjects.map((s) => s.subject),
    })),
  };
}

/** A batch.json read back. Throws on another version or a record without its runs. */
export function readBatchRecord(json: unknown): BatchRecord {
  const r = obj(json);
  if (r.version !== PLAN_VERSION || typeof r.stamp !== "string" || !Array.isArray(r.runs)) {
    throw new Error(`Not a version ${PLAN_VERSION} Device Farm batch record.`);
  }
  return r as unknown as BatchRecord;
}

/** The recorded run a GetRun belongs to, by its ARN or the key in its name. */
export function recordedRun(record: BatchRecord, run: Pick<DfRun, "arn" | "name">): RecordedRun | null {
  const key = runKeyFromName(run.name);
  return record.runs.find((r) => r.arn === run.arn) ?? record.runs.find((r) => key !== null && r.key === key) ?? null;
}

/**
 * What the runner tells parseKitOutput about a phone: Device Farm's names for it, its public ARN, and the RAM it was
 * planned with, which only counts when device.txt has no MemTotal.
 */
export function kitDevice(phone: RecordedPhone): Partial<DeviceFacts> {
  const out: Partial<DeviceFacts> = {
    name: phone.name,
    manufacturer: phone.manufacturer,
    model: phone.model,
    os: "android",
    cloudId: phone.arn,
  };
  if (phone.ramGiB) {
    out.ramBytes = phone.ramGiB * GIB;
    out.marketedRamGiB = phone.ramGiB;
  }
  return out;
}

/** A phone known only from a job's device (a run fetched without its batch record). */
export function phoneOfJob(job: DfJob): RecordedPhone {
  const spec = phoneSpec(job.device.name);
  return {
    arn: job.device.arn,
    name: job.device.name,
    manufacturer: job.device.manufacturer,
    model: job.device.model || job.device.name,
    os: job.device.os,
    ramGiB: spec?.ramGiB ?? null,
    ramFrom: spec?.ramFrom ?? "none",
  };
}

/**
 * True when an earlier Device Farm smoke run went through the whole path: it finished (done or cut) and some backend
 * loaded the model. A batch of large files waits for one, so a broken path costs a smoke run, not hours of phones.
 */
export function smokePassed(results: ReadonlyArray<Pick<Result, "cloud" | "status" | "subject" | "backends">>): boolean {
  return results.some(
    (r) =>
      r.cloud === "devicefarm" &&
      r.subject.kind === "smoke" &&
      (r.status === "done" || r.status === "cut") &&
      r.backends.some((b) => b.loaded),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Zip files: the test package out, the customer artifacts in

export interface ZipEntry {
  path: string;
  data: Uint8Array;
  /** Unix permission bits. */
  mode?: number;
}

/** A path that is relative, has no "..", no backslash, no NUL and no empty part. */
export function safeRelative(path: string): boolean {
  if (!path || path.startsWith("/") || /[\\\0]/.test(path) || /^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

const ZIP_LIMIT = 0xffffffff;
/** 1980-01-01 00:00, so a package's bytes depend only on its files. */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

/** A zip of the entries in order: deflated unless that doesn't help, UTF-8 names, Unix modes, fixed times, no zip64. */
export function zipBuild(entries: readonly ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  if (entries.length >= 0xffff) throw new Error("Too many files for a zip without zip64.");
  for (const e of entries) {
    if (!safeRelative(e.path)) throw new Error(`Not a safe zip path: ${e.path}`);
    const name = Buffer.from(e.path, "utf8");
    const data = Buffer.from(e.data.buffer, e.data.byteOffset, e.data.byteLength);
    const deflated = deflateRawSync(data);
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = crc32(data) >>> 0;
    if (data.length > ZIP_LIMIT || offset + body.length > ZIP_LIMIT) throw new Error("The package is too large for a zip without zip64.");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE((3 << 8) | 20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(stored ? 0 : 8, 10);
    head.writeUInt16LE(0, 12);
    head.writeUInt16LE(DOS_DATE, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(body.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE((((0o100000 | ((e.mode ?? 0o644) & 0o777)) << 16) >>> 0), 38);
    head.writeUInt32LE(offset, 42);
    parts.push(local, name, body);
    central.push(head, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

/**
 * The files of a zip (stored or deflated, zip64 too), checked against their CRCs. Throws on an encrypted entry, an
 * unsafe path ("..", absolute) or more than `maxBytes` unpacked in all. Folders are left out.
 */
export function zipRead(zip: Uint8Array, options: { maxBytes?: number } = {}): ZipEntry[] {
  const buf = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  const maxBytes = options.maxBytes ?? 2 * DF_ARTIFACT_CAP_BYTES;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a zip file.");
  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === ZIP_LIMIT) {
    const locator = eocd - 20;
    if (locator < 0 || buf.readUInt32LE(locator) !== 0x07064b50) throw new Error("A zip64 file without its locator.");
    const z64 = Number(buf.readBigUInt64LE(locator + 8));
    if (buf.readUInt32LE(z64) !== 0x06064b50) throw new Error("A broken zip64 end record.");
    count = Number(buf.readBigUInt64LE(z64 + 32));
    cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
  }
  const out: ZipEntry[] = [];
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("A broken zip central directory.");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    let csize = buf.readUInt32LE(p + 20);
    let usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const attrs = buf.readUInt32LE(p + 38);
    let local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const extra = buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    for (let x = 0; x + 4 <= extra.length; ) {
      const id = extra.readUInt16LE(x);
      const size = extra.readUInt16LE(x + 2);
      if (id === 0x0001) {
        let at = x + 4;
        if (usize === ZIP_LIMIT) {
          usize = Number(extra.readBigUInt64LE(at));
          at += 8;
        }
        if (csize === ZIP_LIMIT) {
          csize = Number(extra.readBigUInt64LE(at));
          at += 8;
        }
        if (local === ZIP_LIMIT) local = Number(extra.readBigUInt64LE(at));
      }
      x += 4 + size;
    }
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    if (flags & 1) throw new Error(`${name} is encrypted.`);
    if (!safeRelative(name)) throw new Error(`The zip has an unsafe path: ${name}`);
    total += usize;
    if (total > maxBytes) throw new Error(`The zip unpacks to more than ${maxBytes} bytes.`);
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`A broken zip entry: ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const body = buf.subarray(start, start + csize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(body);
    else if (method === 8) data = usize === 0 ? Buffer.alloc(0) : inflateRawSync(body, { maxOutputLength: usize });
    else throw new Error(`${name} uses zip method ${method}.`);
    if (data.length !== usize || (crc32(data) >>> 0) !== crc) throw new Error(`${name} is damaged.`);
    const mode = (attrs >>> 16) & 0o777;
    out.push({ path: name, data, ...(mode ? { mode } : {}) });
  }
  return out;
}
