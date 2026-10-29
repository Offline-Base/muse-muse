/**
 * A kit output folder (devices/kit/run.sh, docs/DEVICES.md "The output folder") read into a Result with its verdict
 * (docs/DEVICES.md "Results and the verdict"), and written under devices/results/. Every runner calls these: the Mac's
 * scripts/devices/local.ts and the Device Farm and QDC runners, once they have the folder back from the phone.
 *
 * The kit writes plain key=value text and llama.cpp's own output; nothing here runs anything.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  FIXED_PROMPTS,
  LLAMA_TAG,
  deviceSlug,
  marketedRamGiB,
  resultDir,
  runNeedBytes,
} from "@/lib/devices/subjects";
import {
  ANSWERS_NEEDED,
  BACKENDS,
  KIT_VERSION,
  RESULT_SCHEMA,
  SLOW_GEN_TPS,
  USABLE_GEN_TPS,
  type Backend,
  type BackendRun,
  type Cloud,
  type Completion,
  type DeviceFacts,
  type DeviceOs,
  type LlamaBuild,
  type ModelCheck,
  type PromptId,
  type Rating,
  type Result,
  type StepEnd,
  type Subject,
  type Verdict,
} from "@/lib/devices/types";

export interface KitContext {
  cloud: Cloud;
  runId: string;
  stamp: string;
  subject: Subject;
  /**
   * What the runner knows: name, cloudId, or the planned RAM when device.txt lacks it. A manufacturer, model or slug
   * given here wins over device.txt's (a cloud's catalog names a phone better than its build properties do); RAM from
   * device.txt wins over the runner's.
   */
  device?: Partial<DeviceFacts>;
  notes?: string[];
}

/** Kept in Completion.raw and Completion.answer, in characters. */
const RAW_CHARS = 4000;
const ANSWER_CHARS = 2000;
const ERROR_CHARS = 300;
/** A prompt speed under this gets a note: a 500-token prompt then takes over 50 s. */
const SLOW_PROMPT_TPS = 10;

const STEP_ENDS: readonly StepEnd[] = ["ok", "error", "timeout", "killed", "crashed", "skipped"];
const CHECKS: readonly ModelCheck["check"][] = ["ok", "size", "sha256", "missing", "no_tool", "timeout", "skipped"];
const OSES: readonly DeviceOs[] = ["android", "ios", "macos", "linux"];

// ---------------------------------------------------------------------------------------------------------------
// Reading the kit's files

function readText(dir: string, name: string): string | null {
  const file = path.join(dir, name);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

/** key=value lines; a key that repeats keeps its last value. */
export function keyValues(text: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (text ?? "").split("\n")) {
    const m = /^([a-z0-9_]+)=(.*)$/.exec(line.replace(/\r$/, ""));
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/** A whole or decimal number, or null for "", "-", "inf", "nan" and the like. */
function num(value: string | undefined): number | null {
  if (value === undefined || !/^-?\d+(\.\d+)?$/.test(value.trim())) return null;
  return Number(value);
}

export interface StepLine {
  name: string;
  backend: Backend | null;
  prompt: string | null;
  start: number | null;
  seconds: number | null;
  limit: number | null;
  rc: number | null;
  end: StepEnd;
  why: string | null;
}

/** steps.txt: one line per step of space-separated key=value codes. */
export function parseSteps(text: string | null): StepLine[] {
  const out: StepLine[] = [];
  for (const line of (text ?? "").split("\n")) {
    const f: Record<string, string> = {};
    for (const word of line.trim().split(/\s+/)) {
      const at = word.indexOf("=");
      if (at > 0) f[word.slice(0, at)] = word.slice(at + 1);
    }
    if (!f.name || !STEP_ENDS.includes(f.end as StepEnd)) continue;
    const dash = (v: string | undefined) => (v === undefined || v === "-" || v === "" ? null : v);
    const backend = dash(f.backend);
    out.push({
      name: f.name,
      backend: backend && (BACKENDS as readonly string[]).includes(backend) ? (backend as Backend) : null,
      prompt: dash(f.prompt),
      start: num(f.start),
      seconds: num(f.seconds),
      limit: num(f.limit),
      rc: num(f.rc),
      end: f.end as StepEnd,
      why: dash(f.why),
    });
  }
  return out;
}

export type MemSample = Record<string, number>;

/** mem-<step>.txt: one sample per line, "t=<s>" and the platform's key=value numbers. */
export function parseMem(text: string | null): MemSample[] {
  const out: MemSample[] = [];
  for (const line of (text ?? "").split("\n")) {
    const sample: MemSample = {};
    for (const word of line.trim().split(/\s+/)) {
      const m = /^([a-z_]+)=(\d+)$/.exec(word);
      if (m) sample[m[1]] = Number(m[2]);
    }
    if (sample.t !== undefined) out.push(sample);
  }
  return out;
}

export interface MemSummary {
  peakRssBytes: number | null;
  minAvailableBytes: number | null;
  availDropBytes: number | null;
  maxTempC: number | null;
}

/**
 * Peak resident memory (VmHWM, or sampled RSS where there is none, as on a Mac), the lowest MemAvailable, how far it
 * fell from the t=0 sample, and the hottest plausible thermal reading.
 */
export function memSummary(samples: MemSample[]): MemSummary {
  const all = (key: string) => samples.map((s) => s[key]).filter((v): v is number => v !== undefined);
  const max = (vs: number[]) => (vs.length ? Math.max(...vs) : null);
  const hwm = max(all("hwm_kb"));
  const rss = max(all("rss_kb"));
  const peak = hwm ?? rss;
  const avail = all("avail_kb");
  const minAvail = avail.length ? Math.min(...avail) : null;
  const first = samples.find((s) => s.avail_kb !== undefined)?.avail_kb;
  const temps = all("temp_mc").filter((v) => v > 0 && v < 150_000);
  return {
    peakRssBytes: peak === null ? null : peak * 1024,
    minAvailableBytes: minAvail === null ? null : minAvail * 1024,
    availDropBytes: minAvail === null || first === undefined ? null : Math.max(0, first - minAvail) * 1024,
    maxTempC: temps.length ? Math.max(...temps) / 1000 : null,
  };
}

export interface BenchNumbers {
  loaded: boolean;
  promptTps: number | null;
  genTps: number | null;
  promptTokens: number | null;
  genTokens: number | null;
  reps: number | null;
}

/** llama-bench's JSONL: the pp line (n_prompt above 0, n_gen 0) and the tg line (n_gen above 0, n_prompt 0). */
export function parseBenchJsonl(text: string | null): BenchNumbers {
  const out: BenchNumbers = { loaded: false, promptTps: null, genTps: null, promptTokens: null, genTokens: null, reps: null };
  for (const line of (text ?? "").split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const nPrompt = typeof row.n_prompt === "number" ? row.n_prompt : 0;
    const nGen = typeof row.n_gen === "number" ? row.n_gen : 0;
    const ts = typeof row.avg_ts === "number" && Number.isFinite(row.avg_ts) ? row.avg_ts : null;
    out.loaded = true;
    if (nPrompt > 0 && nGen === 0 && out.promptTps === null) {
      out.promptTps = ts;
      out.promptTokens = nPrompt;
    } else if (nGen > 0 && nPrompt === 0 && out.genTps === null) {
      out.genTps = ts;
      out.genTokens = nGen;
      if (Array.isArray(row.samples_ts)) out.reps = row.samples_ts.length;
    }
  }
  return out;
}

/**
 * From a bench log: "offloaded N/M layers" and each "<name> model|KV|compute buffer size = <x> MiB". llama-bench loads
 * the model once for all its tests (they share its settings) and makes a context per test, so model buffers of one
 * name add up (a mapped file can come in several buffers) and KV and compute buffers keep their largest size.
 */
export function parseBenchLog(text: string | null): { offloaded: string | null; buffersMiB: Record<string, number> } {
  const log = text ?? "";
  const offloaded = /offloaded (\d+\/\d+) layers/.exec(log)?.[1] ?? null;
  const buffersMiB: Record<string, number> = {};
  for (const m of log.matchAll(/(\S+)\s+(model|KV|compute) buffer size =\s*([\d.]+) MiB/g)) {
    const name = `${m[1]} ${m[2]}`;
    const mib = Number(m[3]);
    if (!Number.isFinite(mib)) continue;
    const seen = buffersMiB[name] ?? 0;
    buffersMiB[name] = m[2] === "model" ? Math.round((seen + mib) * 100) / 100 : Math.max(seen, mib);
  }
  return { offloaded, buffersMiB };
}

export interface AnswerTimings {
  promptTps: number | null;
  genTps: number | null;
  promptTokens: number | null;
  genTokens: number | null;
  loadSeconds: number | null;
}

/** llama-completion's --perf lines, which carry a log prefix ("0.00.739.738 I common_perf_print:"). */
export function parseAnswerLog(text: string | null): AnswerTimings {
  const log = text ?? "";
  const prompt = /prompt eval time =\s*[\d.]+ ms \/\s*(\d+) tokens \([^)]*?([\d.]+|inf|nan|-?inf) tokens per second\)/.exec(log);
  const gen = /(?<!prompt )eval time =\s*[\d.]+ ms \/\s*(\d+) runs\s*\([^)]*?([\d.]+|inf|nan|-?inf) tokens per second\)/.exec(log);
  const load = /load time =\s*([\d.]+) ms/.exec(log);
  return {
    promptTps: prompt ? num(prompt[2]) : null,
    promptTokens: prompt ? Number(prompt[1]) : null,
    genTps: gen ? num(gen[2]) : null,
    genTokens: gen ? Number(gen[1]) : null,
    loadSeconds: load ? Math.round(Number(load[1])) / 1000 : null,
  };
}

const ERROR_LINE = /error|failed|unable|GGML_ASSERT|out of memory|cannot|not found/i;
/** Lines that match ERROR_LINE in every healthy -v bench log (a weight that stays off the repacked CPU buffer). */
const NOT_ERRORS = /cannot be used with preferred buffer type/;

/** The first line of the given texts that reads like an error, at most 300 characters. */
export function firstError(...texts: Array<string | null>): string | null {
  for (const text of texts) {
    for (const line of (text ?? "").split("\n")) {
      if (ERROR_LINE.test(line) && !NOT_ERRORS.test(line)) return line.trim().slice(0, ERROR_CHARS);
    }
  }
  return null;
}

const STOPS = ["<|eot|>", "<|eom|>", "<|end_of_text|>", "<|im_end|>", "<|start|>", "[end of text]"];

/**
 * The final answer in llama-completion's raw output (printed with -sp, so control tokens show). Glimmer reasons on the
 * to=self channel and answers on to=user: the answer is what follows the last "to=user<|message|>". Output with a
 * message but no to=user never answered. Anything else (SmolLM2's ChatML) is the answer as it is. Each is cut at the
 * first end-of-message or end-of-turn token, without other control tokens. `finished` is true when the model ended
 * its turn before the token limit ("[end of text]").
 */
export function finalAnswer(raw: string): { answer: string; finished: boolean } {
  const finished = raw.includes("[end of text]");
  const marker = "to=user<|message|>";
  const at = raw.lastIndexOf(marker);
  let text = at >= 0 ? raw.slice(at + marker.length) : raw.includes("<|message|>") ? "" : raw;
  let cut = text.length;
  for (const stop of STOPS) {
    const i = text.indexOf(stop);
    if (i >= 0 && i < cut) cut = i;
  }
  text = text.slice(0, cut).replace(/<\|[^|<>]*\|>/g, "").trim();
  return { answer: text, finished };
}

// ---------------------------------------------------------------------------------------------------------------
// The Result

function isOs(value: string | undefined): value is DeviceOs {
  return OSES.includes(value as DeviceOs);
}

function deviceFacts(dev: Record<string, string>, run: Record<string, string>, context: KitContext): DeviceFacts {
  const given = context.device ?? {};
  const os: DeviceOs = isOs(dev.platform) ? dev.platform : isOs(run.platform) ? run.platform : given.os ?? "linux";
  const ramKb = num(dev.ram_kb);
  const ramBytes = ramKb !== null && ramKb > 0 ? ramKb * 1024 : given.ramBytes ?? 0;
  const marketed = ramBytes > 0 ? marketedRamGiB(ramBytes) : given.marketedRamGiB ?? 0;
  const manufacturer =
    given.manufacturer ?? (os === "android" ? dev.manufacturer ?? "" : os === "macos" ? "Apple" : dev.manufacturer ?? "");
  const model = given.model ?? (os === "android" ? dev.model ?? "" : os === "macos" ? dev.hw_model ?? "" : dev.cpu ?? "");
  const soc = os === "android" ? dev.soc_model || dev.board : os === "macos" ? dev.chip : undefined;
  const socManufacturer = os === "android" ? dev.soc_manufacturer : os === "macos" ? "Apple" : undefined;
  const osVersion =
    given.osVersion ?? (os === "android" ? dev.android : os === "macos" ? dev.macos : dev.os_release || dev.kernel) ?? "";
  const fallbackName =
    os === "macos"
      ? `${model || "Mac"}${dev.chip ? ` (${dev.chip})` : ""}`
      : [manufacturer, model].filter(Boolean).join(" ") || "Unknown device";
  const facts: DeviceFacts = {
    cloud: context.cloud,
    slug: given.slug ?? deviceSlug({ manufacturer, model, marketedRamGiB: marketed }),
    name: given.name ?? fallbackName,
    manufacturer,
    model,
    os,
    osVersion,
    ramBytes,
    marketedRamGiB: marketed,
  };
  const api = num(dev.sdk);
  if (os === "android" && api !== null) facts.apiLevel = api;
  else if (given.apiLevel !== undefined) facts.apiLevel = given.apiLevel;
  if (soc || given.soc) facts.soc = soc || given.soc;
  if (socManufacturer || given.socManufacturer) facts.socManufacturer = socManufacturer || given.socManufacturer;
  const cores = num(dev.cores);
  if (cores !== null && cores > 0) facts.cpuCores = cores;
  const freeKb = num(dev.disk_free_kb);
  if (freeKb !== null) facts.freeDiskBytes = freeKb * 1024;
  else if (given.freeDiskBytes !== undefined) facts.freeDiskBytes = given.freeDiskBytes;
  if (given.cloudId) facts.cloudId = given.cloudId;
  return facts;
}

/** The pinned build a backend ran from, by platform and the build folder's layout (run.txt layout_<backend>). */
function buildFor(os: DeviceOs, backend: Backend, layout: string | undefined): LlamaBuild {
  if (os === "macos") return "macos-arm64";
  if (os === "android") {
    if (layout === "bin-lib") return "android-arm64-snapdragon";
    if (layout === "flat") return "android-arm64";
    return backend === "cpu" ? "android-arm64" : "android-arm64-snapdragon";
  }
  return "linux-arm64-snapdragon";
}

/** The llama.cpp device string the kit passes with -dev for llama-completion. */
function deviceFor(os: DeviceOs, backend: Backend, sessions: number): string {
  if (backend === "cpu") return "none";
  if (backend === "gpu") return os === "macos" ? "MTL0" : "GPUOpenCL";
  return Array.from({ length: Math.max(1, sessions) }, (_, i) => `HTP${i}`).join(",");
}

function modelCheck(model: Record<string, string>): ModelCheck {
  const check = CHECKS.includes(model.check as ModelCheck["check"]) ? (model.check as ModelCheck["check"]) : "skipped";
  return {
    check,
    bytes: num(model.bytes),
    sha256: /^[0-9a-f]{64}$/.test(model.sha256 ?? "") ? model.sha256 : null,
    seconds: num(model.seconds),
    fetched: model.fetched === "1",
    fetchSeconds: num(model.fetch_seconds),
  };
}

function isoAt(epochSeconds: number | null): string {
  return epochSeconds === null ? "" : new Date(epochSeconds * 1000).toISOString();
}

const isPromptId = (id: string | null): id is PromptId => FIXED_PROMPTS.some((p) => p.id === id);

/**
 * Reads a kit output folder. Throws only when run.txt is missing or its kit= isn't KIT_VERSION. A folder the kit never
 * finished (the phone or the host ended it) still reads: its status is "cut" and a note says so. In such a folder, and
 * in one a signal stopped (why=signal), every planned step without a line in steps.txt reads as skipped, why "stopped".
 */
export function parseKitOutput(dir: string, context: KitContext): Result {
  const runText = readText(dir, "run.txt");
  if (runText === null) throw new Error(`No run.txt in ${dir}: the kit didn't start there.`);
  const run = keyValues(runText);
  if (run.kit !== String(KIT_VERSION)) {
    throw new Error(`${dir}/run.txt is from kit ${run.kit ?? "(none)"}; this parser reads kit ${KIT_VERSION}.`);
  }
  const dev = keyValues(readText(dir, "device.txt"));
  const modelKv = keyValues(readText(dir, "model.txt"));
  const steps = parseSteps(readText(dir, "steps.txt"));
  const notes = [...(context.notes ?? [])];
  const device = deviceFacts(dev, run, context);
  // The kit runs the NPU on fewer sessions than asked when the backend lists fewer (npu_sessions_used).
  const sessions = num(run.npu_sessions_used) ?? num(run.npu_sessions) ?? 1;
  const planned = (run.backends ?? "")
    .split(",")
    .filter((b): b is Backend => (BACKENDS as readonly string[]).includes(b));
  const prompts = (run.prompts ?? "").split(",").filter(Boolean);
  const finished = run.status !== undefined && ["done", "cut", "skipped", "failed"].includes(run.status);
  const stopped = !finished || run.why === "signal";
  if (!finished) notes.push("The kit stopped before it finished (run.txt has no status): the host or the device ended it.");
  if (run.npu_sessions_used) {
    notes.push(`The NPU backend listed ${run.npu_sessions_used} of the ${run.npu_sessions ?? "?"} Hexagon sessions asked for, so the NPU ran on those.`);
  }

  const backends: BackendRun[] = planned.map((backend) => {
    const bench = steps.filter((s) => s.name === "bench" && s.backend === backend).pop();
    const list = steps.filter((s) => s.name === "list" && s.backend === backend).pop();
    const jsonl = readText(dir, `bench-${backend}.jsonl`);
    const log = readText(dir, `bench-${backend}.log`);
    const numbers = parseBenchJsonl(jsonl);
    const fromLog = parseBenchLog(log);
    const mem = memSummary(parseMem(readText(dir, `mem-bench-${backend}.txt`)));
    const end: StepEnd = bench?.end ?? "skipped";
    const why = bench ? bench.why : stopped ? "stopped" : "missing";
    let error: string | null = null;
    if (end !== "ok" && end !== "skipped") error = firstError(log, jsonl);
    else if (end === "skipped" && why === "unavailable" && list) error = firstError(readText(dir, `list-${backend}.txt`));
    return {
      backend,
      device: deviceFor(device.os, backend, sessions),
      build: buildFor(device.os, backend, run[`layout_${backend}`]),
      available: !(end === "skipped" && (why === "unavailable" || why === "android_sdk")),
      loaded: numbers.loaded,
      promptTps: numbers.promptTps,
      genTps: numbers.genTps,
      promptTokens: numbers.promptTokens ?? num(run.bench_prompt) ?? 0,
      genTokens: numbers.genTokens ?? num(run.bench_gen) ?? 0,
      reps: numbers.reps ?? num(run.bench_reps) ?? 0,
      offloaded: fromLog.offloaded,
      buffersMiB: fromLog.buffersMiB,
      ...mem,
      end,
      why,
      rc: bench?.rc ?? null,
      seconds: bench?.seconds ?? null,
      error,
    };
  });

  const completions: Completion[] = [];
  const unknown = new Set<string>();
  for (const step of steps.filter((s) => s.name === "answer" && s.backend)) {
    if (!isPromptId(step.prompt)) {
      unknown.add(step.prompt ?? "-");
      continue;
    }
    const backend = step.backend as Backend;
    const name = `answer-${backend}-${step.prompt}`;
    const raw = readText(dir, `${name}.txt`) ?? "";
    const log = readText(dir, `${name}.log`);
    const { answer, finished: ended } = finalAnswer(raw);
    const prompt = FIXED_PROMPTS.find((p) => p.id === step.prompt)!;
    const timings = parseAnswerLog(log);
    completions.push({
      backend,
      promptId: step.prompt,
      answer: answer.slice(0, ANSWER_CHARS),
      raw: raw.slice(0, RAW_CHARS),
      finished: ended,
      right: prompt.expect.test(answer),
      ...timings,
      peakRssBytes: memSummary(parseMem(readText(dir, `mem-${name}.txt`))).peakRssBytes,
      end: step.end,
      why: step.why,
      rc: step.rc,
      seconds: step.seconds,
      error: step.end !== "ok" && step.end !== "skipped" ? firstError(log, raw) : null,
    });
  }
  if (unknown.size) notes.push(`Answers to prompts this parser doesn't know were left out: ${[...unknown].join(", ")}.`);
  if (stopped) {
    // The steps the kit never reached, so the verdict can say what wasn't asked.
    for (const backend of planned) {
      for (const id of prompts) {
        if (!isPromptId(id) || completions.some((c) => c.backend === backend && c.promptId === id)) continue;
        completions.push({
          backend,
          promptId: id,
          answer: "",
          raw: "",
          finished: false,
          right: false,
          promptTps: null,
          genTps: null,
          promptTokens: null,
          genTokens: null,
          loadSeconds: null,
          peakRssBytes: null,
          end: "skipped",
          why: "stopped",
          rc: null,
          seconds: null,
          error: null,
        });
      }
    }
  }

  const model = modelCheck(modelKv);
  const fetchError = firstError(readText(dir, "fetch.log"));
  if (run.why === "no_curl") notes.push("The device has no curl, so the kit couldn't download the model.");
  if (run.why === "disk") notes.push("The device didn't have room for the download: the file plus 1 GiB.");
  if (run.why === "fetch") notes.push(`The kit's download failed or ran out of time${fetchError ? `: ${fetchError}` : "."}`);
  if (run.why === "signal") notes.push("A signal from outside stopped the kit before it finished.");
  if (model.check === "no_tool") notes.push("The device has no sha256 tool: the size matched and the kit left the sha256 unchecked.");
  if (model.check === "timeout") {
    notes.push(`The kit's sha256 didn't finish within ${run.limit_check ?? "its limit"} s: the size matched and the run went on unverified.`);
  }

  const started = num(run.started);
  const ended = num(run.finished) ?? Math.max(started ?? 0, ...steps.map((s) => (s.start ?? 0) + (s.seconds ?? 0)));
  const status: Result["status"] = finished ? (run.status as Result["status"]) : "cut";
  const withoutVerdict: Omit<Result, "verdict"> = {
    schema: RESULT_SCHEMA,
    kit: KIT_VERSION,
    cloud: context.cloud,
    runId: context.runId,
    stamp: context.stamp,
    device,
    subject: context.subject,
    // The builds a step ran from: none for a run skipped for RAM or a model that failed its check.
    llama: { tag: LLAMA_TAG, builds: [...new Set(backends.filter((b) => b.end !== "skipped").map((b) => b.build))] },
    startedAt: isoAt(started),
    finishedAt: isoAt(ended || started),
    seconds: num(run.seconds) ?? (started !== null && ended ? ended - started : 0),
    status,
    model,
    backends,
    completions,
    notes,
  };
  return { ...withoutVerdict, verdict: verdictFor(withoutVerdict) };
}

// ---------------------------------------------------------------------------------------------------------------
// The verdict

const fmt = (n: number) => (n >= 100 ? String(Math.round(n)) : n >= 10 ? n.toFixed(1) : n.toFixed(2));
const gb = (bytes: number) => (bytes / 1e9).toFixed(1);

function noun(os: DeviceOs): string {
  return os === "android" || os === "ios" ? "phone" : os === "macos" ? "Mac" : "device";
}

/** Why a step was skipped, killed or crashed, in words. */
function whyWords(why: string | null): string {
  switch (why) {
    case "time":
      return "out of time";
    case "unavailable":
      return "its device isn't on this one";
    case "nobuild":
      return "no llama.cpp build for it";
    case "android_sdk":
      return "the Snapdragon build needs Android 14";
    case "noload":
      return "its bench measured nothing";
    case "model":
      return "the model check failed";
    case "ram":
      return "not enough RAM";
    case "stopped":
      return "the kit was stopped first";
    case "missing":
      return "steps.txt has no line for it";
    default:
      return why ?? "no reason given";
  }
}

/** How a step that didn't end ok ended, as the end of "the bench ..." or "an answer ...". */
function endWords(end: StepEnd, why: string | null, seconds?: number | null): string {
  switch (end) {
    case "killed":
      return why === "lmk" ? "was killed by the low-memory killer" : "was killed (SIGKILL, with no low-memory log)";
    case "crashed":
      return `crashed (${why?.replace(/^signal(\d+)$/, "signal $1") ?? "a signal"})`;
    case "timeout":
      return seconds ? `ran out of time after ${seconds} s` : "ran out of time";
    case "error":
      return "stopped with an error";
    case "skipped":
      return `wasn't run: ${whyWords(why)}`;
    default:
      return "ended";
  }
}

/**
 * One sentence for a backend that doesn't count, or null when it does: it counts with a generation speed, at least
 * ANSWERS_NEEDED right answers and no step killed. A bench that crashed or timed out after measuring generation still
 * counts (some backends crash as they exit); its end shows in the report.
 */
function backendFault(run: BackendRun, answers: Completion[]): string | null {
  const b = run.backend;
  if (run.end === "skipped") return `${b}: not run, ${whyWords(run.why)}.`;
  if (run.end === "killed") return `${b}: the bench ${endWords(run.end, run.why)}.`;
  if (!run.loaded) {
    if (run.end === "error") return `${b}: it didn't load${run.error ? ` (${run.error})` : ""}.`;
    return `${b}: the bench ${endWords(run.end, run.why, run.seconds)} before its first result.`;
  }
  if (run.genTps === null) return `${b}: the bench ${endWords(run.end, run.why, run.seconds)} before measuring generation.`;
  const killed = answers.find((c) => c.end === "killed");
  if (killed) return `${b}: an answer ${endWords("killed", killed.why)}.`;
  const asked = answers.filter((c) => c.end !== "skipped");
  const right = answers.filter((c) => c.right).length;
  if (asked.length === 0) {
    const skipped = answers.find((c) => c.end === "skipped");
    return `${b}: answers not asked, ${whyWords(skipped?.why ?? null)}.`;
  }
  if (right < ANSWERS_NEEDED) return `${b}: ${right} of ${asked.length} answers right.`;
  return null;
}

/**
 * The verdict for one result (docs/DEVICES.md "The verdict"): failed when the model couldn't be had or nothing loaded,
 * unusable for a RAM skip or when no backend counts, otherwise the fastest counting backend's speed decides. A backend
 * counts with a generation speed, at least ANSWERS_NEEDED right answers and no step killed.
 */
export function verdictFor(result: Omit<Result, "verdict">): Verdict {
  const none = { backend: null, genTps: null, promptTps: null, answersRight: 0, answersTotal: 0 };
  const check = result.model.check;
  if (check === "missing" || check === "size" || check === "sha256" || result.status === "failed") {
    const why =
      check === "size"
        ? `The model file has ${result.model.bytes ?? "an unknown number of"} bytes, not ${result.subject.bytes}.`
        : check === "sha256"
          ? "The model file's sha256 doesn't match the pinned one."
          : check === "missing"
            ? `The model file wasn't on the device${result.model.fetchSeconds !== null ? " and the kit's download failed" : ""}.`
            : "The kit couldn't run the file.";
    return { rating: "failed", ...none, reasons: [why] };
  }
  if (result.status === "skipped") {
    const reason =
      `This ${noun(result.device.os)} has ${result.device.marketedRamGiB} GB of RAM and the file's run needs ` +
      `${gb(runNeedBytes(result.subject))} GB.`;
    return { rating: "unusable", ...none, reasons: [reason] };
  }
  if (result.backends.length === 0) return { rating: "failed", ...none, reasons: ["The kit's run.txt names no backend."] };
  if (!result.backends.some((b) => b.loaded)) {
    if (result.backends.every((b) => b.end === "skipped")) {
      const reason = `No backend ran: ${result.backends.map((b) => `${b.backend}, ${whyWords(b.why)}`).join("; ")}.`;
      return { rating: "failed", ...none, reasons: [reason] };
    }
    const error = result.backends.map((b) => b.error).find(Boolean);
    const reasons = [`It didn't load on any backend${error ? `: ${error}` : "."}`];
    for (const run of result.backends) {
      const fault = backendFault(run, result.completions.filter((c) => c.backend === run.backend));
      if (fault) reasons.push(fault);
    }
    return { rating: "failed", ...none, reasons };
  }
  const reasons: string[] = [];
  const counting: BackendRun[] = [];
  for (const run of result.backends) {
    const fault = backendFault(run, result.completions.filter((c) => c.backend === run.backend));
    if (fault) reasons.push(fault);
    else counting.push(run);
  }
  if (counting.length === 0) {
    reasons.push("No backend ran with enough right answers and without a kill.");
    return { rating: "unusable", ...none, reasons };
  }
  const best = counting.reduce((a, b) => ((b.genTps ?? 0) > (a.genTps ?? 0) ? b : a));
  const answers = result.completions.filter((c) => c.backend === best.backend);
  const asked = answers.filter((c) => c.end !== "skipped");
  const right = answers.filter((c) => c.right).length;
  const tps = best.genTps ?? 0;
  const rating: Rating = tps >= USABLE_GEN_TPS ? "usable" : tps >= SLOW_GEN_TPS ? "slow" : "unusable";
  const words = rating === "usable" ? "usable" : rating === "slow" ? `slow (usable needs ${USABLE_GEN_TPS})` : `unusable (slow needs ${SLOW_GEN_TPS})`;
  reasons.push(`${best.backend}: ${fmt(tps)} tokens a second with ${right} of ${asked.length} answers right: ${words}.`);
  if (best.promptTps !== null && best.promptTps < SLOW_PROMPT_TPS) {
    reasons.push(
      `It reads prompts at ${fmt(best.promptTps)} tokens a second, so a 500-token prompt takes about ` +
        `${Math.round(500 / Math.max(best.promptTps, 0.01))} s before the first word.`,
    );
  }
  return {
    rating,
    backend: best.backend,
    genTps: best.genTps,
    promptTps: best.promptTps,
    answersRight: right,
    answersTotal: asked.length,
    reasons,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Writing results

/** Files a result folder never takes, whatever a kit folder holds: models, partial downloads, archives, libraries. */
const NEVER_COPY = /\.(gguf|part|zip|whl|so|dylib|tar|gz|tgz)$/i;
/** The kit caps its files at 256 KiB; anything much larger in a kit folder isn't the kit's. */
const MAX_COPY_BYTES = 1024 * 1024;

/**
 * Copies every file of the kit's folder (the kit already capped them) and writes result.json into resultDir(...)
 * under repoRoot; returns that folder. Hidden files, subfolders, models, archives and anything over 1 MiB stay out.
 */
export function writeResult(repoRoot: string, result: Result, kitOutDir: string): string {
  const dir = path.join(repoRoot, resultDir(result.cloud, result.device.slug, result.subject.id, result.stamp));
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(kitOutDir)) {
    if (name.startsWith(".") || name === "result.json" || NEVER_COPY.test(name)) continue;
    const from = path.join(kitOutDir, name);
    const info = lstatSync(from);
    if (!info.isFile() || info.size > MAX_COPY_BYTES) continue;
    copyFileSync(from, path.join(dir, name));
  }
  writeFileSync(path.join(dir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  return dir;
}

/** Reads a result.json back, checking its schema. */
export function readResult(file: string): Result {
  const result = JSON.parse(readFileSync(file, "utf8")) as Result;
  if (result.schema !== RESULT_SCHEMA) throw new Error(`${file} has result schema ${String(result.schema)}, not ${RESULT_SCHEMA}.`);
  return result;
}
