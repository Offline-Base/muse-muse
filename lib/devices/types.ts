/**
 * Device tests of the Muse Glimmer 30B GGUF files on real phones and on the owner's Mac (docs/DEVICES.md). One kit,
 * devices/kit/run.sh, runs on every device; three runners put it there: scripts/devices/local.ts (this Mac),
 * scripts/devices/devicefarm.ts (AWS Device Farm) and scripts/devices/qdc.ts with devices/qdc (Qualcomm Device Cloud).
 * lib/devices/result.ts turns any kit output folder into a Result. These are the types every part shares.
 *
 * Sizes are bytes, speeds are tokens a second, times are seconds unless a name says otherwise, dates are ISO strings.
 */

/** Where a run happened. */
export type Cloud = "local" | "devicefarm" | "qdc";

/** A device's operating system as the kit and the pickers see it. iOS is listed so a picker can say why it skips it. */
export type DeviceOs = "android" | "ios" | "macos" | "linux";

/**
 * A llama.cpp backend, by what it runs on. "cpu" is llama.cpp's CPU backend (`-dev none -ngl 0`). "gpu" is Adreno
 * through OpenCL on a Snapdragon phone (`-dev GPUOpenCL`) or Metal on a Mac (`-dev MTL0`). "npu" is the Hexagon NPU
 * on a Snapdragon phone (`-dev HTP0,...`, with GGML_HEXAGON_DEVICES set).
 */
export type Backend = "cpu" | "gpu" | "npu";
export const BACKENDS: readonly Backend[] = ["cpu", "gpu", "npu"];

/** What a subject is: a public base build standing in for the tuned files, a tuned file, or the tiny smoke model. */
export type SubjectKind = "base" | "tuned" | "smoke";

/**
 * One GGUF file under test, pinned to a commit of a public Hugging Face repo. The kit downloads nothing it can't check:
 * every subject has its exact size and sha256 (the file's LFS oid on the Hub).
 */
export interface Subject {
  /** Short and filesystem-safe, used in result paths: "bartowski-iq2_m", "meta-q4_k_m", "tuned-8f1d2c3b-q3_k_m". */
  id: string;
  kind: SubjectKind;
  /** "<namespace>/<repo>" on the Hub, and the commit the file is read at. */
  repo: string;
  revision: string;
  /** The file's path in the repo. */
  path: string;
  bytes: number;
  /** Lowercase hex. */
  sha256: string;
  /** The llama.cpp quant name as the file names it: "IQ2_M", "Q4_K_M". */
  quant: string;
  /** The exact system message the fixed prompts are sent with (DEFAULT_SYSTEM for base files, the repo's `system` file for tuned ones). */
  system: string;
  /**
   * A chat template file in the same repo and commit that must replace the one in the GGUF, for a tuned file made from
   * an adapter trained before trainChannel ("tuned.jinja", docs/VIBE_TUNING.md "Making it behave like the eval"). The
   * runner downloads it and the kit passes it with --chat-template-file. Absent for every other subject.
   */
  templatePath?: string;
  /** One plain sentence on why it is in the list, for the report. */
  note: string;
}

/**
 * A llama.cpp build, one of the pinned b11669 release assets (lib/devices/subjects.ts LLAMA_ASSETS). The phone runs use
 * the two Android builds and the Mac uses macos-arm64; linux-arm64-snapdragon is pinned for QDC's Linux boards, which
 * this test doesn't use yet.
 */
export type LlamaBuild = "android-arm64" | "android-arm64-snapdragon" | "macos-arm64" | "linux-arm64-snapdragon";

/** A pinned release asset: its name, size and sha256, and how its files are laid out once extracted. */
export interface LlamaAsset {
  build: LlamaBuild;
  name: string;
  bytes: number;
  sha256: string;
  url: string;
  /** "flat": binaries and libraries in one folder. "bin-lib": bin/ and lib/. Both under a top folder "llama-b11669/". */
  layout: "flat" | "bin-lib";
  /** The backends this build can run on a device that has the hardware. */
  backends: readonly Backend[];
}

/**
 * Facts about the device a run used, from the kit's device.txt plus what the runner knew (cloud ids, the RAM it
 * planned with). `ramBytes` is what the device itself reports (MemTotal on Android and Linux, hw.memsize on a Mac);
 * `marketedRamGiB` is the size it is sold with (12, 16, 24, 36), which the pickers use.
 */
export interface DeviceFacts {
  cloud: Cloud;
  /** Filesystem-safe, used in result paths: "samsung-galaxy-s24-ultra-12gb", "apple-mac16-6-36gb" (deviceSlug). */
  slug: string;
  name: string;
  manufacturer: string;
  model: string;
  os: DeviceOs;
  /** "15" on Android, "26.5.1" on a Mac. */
  osVersion: string;
  /** Android's API level (ro.build.version.sdk), when known. The Snapdragon build needs 34 or more. */
  apiLevel?: number;
  /** "SM8750" (ro.soc.model), "Apple M4 Max" (machdep.cpu.brand_string), when known. */
  soc?: string;
  /** "QTI", "Google", "Apple", when known. */
  socManufacturer?: string;
  ramBytes: number;
  marketedRamGiB: number;
  cpuCores?: number;
  /** Free space where the model sits, before it was copied there, when known. */
  freeDiskBytes?: number;
  /** Device Farm's public device ARN or QDC's target id and chipset name. Never a serial, an IMEI or a UDID. */
  cloudId?: string;
}

/** How a kit step ended (devices/kit/run.sh steps.txt `end=`). */
export type StepEnd =
  | "ok" // exited 0
  | "error" // exited non-zero by itself (a llama.cpp error, a bad flag, a missing library)
  | "timeout" // the kit's own time limit stopped it
  | "killed" // SIGKILL that wasn't the kit's: the low-memory killer when `why` is "lmk"
  | "crashed" // another signal: SIGSEGV, SIGBUS, SIGABRT
  | "skipped"; // never started (see `why`)

/**
 * Why a step was skipped, killed or crashed (steps.txt `why=`): "time" (the run's total limit), "unavailable" (the
 * backend's device isn't on this device), "nobuild" (no llama.cpp build given for the backend), "android_sdk" (the
 * Snapdragon build needs Android 14), "noload" (the backend's bench produced nothing, so no answers), "model" (the
 * model check failed), "ram" (the device has less RAM than MM_MIN_RAM_KB), "lmk" (the low-memory killer's log names
 * the process), "signal9" (killed, no log), "signal<N>" (crashed with signal N), "limit" (timed out).
 */
export type StepWhy = string;

/**
 * The model file check (model.txt): its size, then its sha256. "timeout" (kit builder): the size matched but the sha256
 * didn't finish within MM_LIMIT_CHECK, so the run went on unverified, as with "no_tool".
 */
export interface ModelCheck {
  check: "ok" | "size" | "sha256" | "missing" | "no_tool" | "timeout" | "skipped";
  bytes: number | null;
  sha256: string | null;
  seconds: number | null;
  /** True when the kit downloaded the file itself (MM_MODEL_URL), with how long that took. */
  fetched: boolean;
  fetchSeconds: number | null;
}

/** One backend's measurement: its llama-bench step (bench-<backend>.jsonl and .log), with memory and heat sampled. */
export interface BackendRun {
  backend: Backend;
  /** The llama.cpp device string it ran with: "none", "GPUOpenCL", "HTP0,HTP1,HTP2", "MTL0". */
  device: string;
  build: LlamaBuild;
  /** False when the backend's device wasn't listed on this device (then it was skipped). "cpu" is always available. */
  available: boolean;
  /** True once llama-bench printed at least one result: the model loaded and ran on this backend. */
  loaded: boolean;
  /** Prompt processing and generation speed (llama-bench avg_ts for the pp and tg tests), null when not measured. */
  promptTps: number | null;
  genTps: number | null;
  promptTokens: number;
  genTokens: number;
  reps: number;
  /** "53/53" from "offloaded N/M layers to GPU", when the log has it. */
  offloaded: string | null;
  /** Buffer sizes from the bench log, MiB by name: "CPU_Mapped model", "GPUOpenCL model", "HTP0 KV", "CPU compute". */
  buffersMiB: Record<string, number>;
  /** The peak of the process's resident memory (VmHWM on Android and Linux, sampled RSS on a Mac). */
  peakRssBytes: number | null;
  /** The lowest MemAvailable during the step (Android and Linux), or null. */
  minAvailableBytes: number | null;
  /**
   * MemAvailable just before the step minus its lowest value during it: the memory the run took from the system,
   * including GPU and NPU driver memory that RSS doesn't show. Null off Android and Linux.
   */
  availDropBytes: number | null;
  /** The hottest thermal zone seen during the step, in degrees C, or null. */
  maxTempC: number | null;
  end: StepEnd;
  why: StepWhy | null;
  rc: number | null;
  seconds: number | null;
  /** The first error line from the log, at most 300 characters. */
  error: string | null;
}

/** The ids of the fixed prompts (lib/devices/subjects.ts FIXED_PROMPTS, devices/kit/prompts/<id>.txt). */
export type PromptId = "capital" | "sum" | "color";

/** One fixed prompt answered on one backend (answer-<backend>-<prompt>.txt and .log). */
export interface Completion {
  backend: Backend;
  promptId: PromptId;
  /** The final answer: after the last " to=user<|message|>" when there is one, without control tokens. At most 2,000 characters. */
  answer: string;
  /** The raw output with control tokens, at most 4,000 characters. */
  raw: string;
  /** True when the model ended its turn before the token limit ("[end of text]"). */
  finished: boolean;
  /** True when the answer matches the prompt's expected pattern. */
  right: boolean;
  promptTps: number | null;
  genTps: number | null;
  promptTokens: number | null;
  genTokens: number | null;
  /** llama-completion's "load time": loading the model for this one answer. */
  loadSeconds: number | null;
  peakRssBytes: number | null;
  end: StepEnd;
  why: StepWhy | null;
  rc: number | null;
  seconds: number | null;
  error: string | null;
}

/** The verdict's rating. See verdict rules in docs/DEVICES.md "Results and the verdict". */
export type Rating = "usable" | "slow" | "unusable" | "failed";

export interface Verdict {
  rating: Rating;
  /** The backend the rating is for (the fastest one whose answers were right), or null. */
  backend: Backend | null;
  genTps: number | null;
  promptTps: number | null;
  /** Of that backend's answers: how many were right, of how many asked. */
  answersRight: number;
  answersTotal: number;
  /** Plain sentences, one per backend that didn't count and why, then the rating's own reason. */
  reasons: string[];
}

/** The verdict's thresholds, in generated tokens a second, and how many of the fixed prompts must be right. */
export const USABLE_GEN_TPS = 4;
export const SLOW_GEN_TPS = 1;
export const ANSWERS_NEEDED = 2;

/** Bumped when Result changes shape. */
export const RESULT_SCHEMA = 1;
/** Bumped when the kit's inputs or its output layout change; the kit writes it as run.txt `kit=` and result.ts checks it. */
export const KIT_VERSION = 1;

/** One device, one subject, one kit run: devices/results/<cloud>/<device slug>/<subject id>/<UTC stamp>/result.json. */
export interface Result {
  schema: typeof RESULT_SCHEMA;
  kit: number;
  cloud: Cloud;
  /** The runner's id for the run: a Device Farm run ARN, a QDC job id, or "local-<stamp>". */
  runId: string;
  /** UTC, "20261028T221500Z" (utcStamp). */
  stamp: string;
  device: DeviceFacts;
  subject: Subject;
  llama: { tag: string; builds: LlamaBuild[] };
  startedAt: string;
  finishedAt: string;
  seconds: number;
  /**
   * "done": every planned step ran or was skipped for a reason other than time. "cut": the total limit skipped some.
   * "skipped": the device has less RAM than the file's run needs (MM_MIN_RAM_KB), so nothing was copied or run.
   * "failed": the model download or check failed, or the kit couldn't start.
   */
  status: "done" | "cut" | "skipped" | "failed";
  model: ModelCheck;
  backends: BackendRun[];
  completions: Completion[];
  verdict: Verdict;
  /** Plain sentences the runner or the parser adds: "The host verified the sha256 before pushing", a skipped file. */
  notes: string[];
}

// ---------------------------------------------------------------------------------------------------------------
// The kit's inputs (docs/DEVICES.md "The kit contract")

/**
 * Every environment variable devices/kit/run.sh reads. Runners build them with kitEnvFor (lib/devices/subjects.ts).
 * Values never contain spaces or quotes (isSafeKitValue), lists are comma-separated, so the same lines can be passed on
 * an adb shell command line, sourced by sh, or read by Python.
 */
export type KitEnvName =
  | "MM_OUT"
  | "MM_SUBJECT"
  | "MM_MODEL"
  | "MM_MODEL_BYTES"
  | "MM_MODEL_SHA256"
  | "MM_MODEL_URL"
  | "MM_MIN_RAM_KB"
  | "MM_SYSTEM_FILE"
  | "MM_TEMPLATE_FILE"
  | "MM_PROMPTS"
  | "MM_BACKENDS"
  | "MM_LLAMA_CPU"
  | "MM_LLAMA_GPU"
  | "MM_LLAMA_NPU"
  | "MM_NPU_SESSIONS"
  | "MM_THREADS"
  | "MM_CTX"
  | "MM_BENCH_PROMPT"
  | "MM_BENCH_GEN"
  | "MM_BENCH_REPS"
  | "MM_ANSWER_TOKENS"
  | "MM_SAMPLE_SECONDS"
  | "MM_LIMIT_FETCH"
  | "MM_LIMIT_CHECK"
  | "MM_LIMIT_BENCH"
  | "MM_LIMIT_ANSWER"
  | "MM_LIMIT_TOTAL";

export type KitEnv = Partial<Record<KitEnvName, string>>;

/** The kit's knobs with their defaults (run.sh uses the same numbers when a variable is unset). */
export interface KitSettings {
  ctx: number;
  benchPrompt: number;
  benchGen: number;
  benchReps: number;
  answerTokens: number;
  sampleSeconds: number;
  /** Time limits in seconds: the kit's own download, the size and sha256 check, one bench, one answer, the whole run after the download. */
  limitFetch: number;
  limitCheck: number;
  limitBench: number;
  limitAnswer: number;
  limitTotal: number;
}

export const KIT_DEFAULTS: KitSettings = {
  ctx: 4096,
  benchPrompt: 128,
  benchGen: 16,
  benchReps: 2,
  answerTokens: 192,
  sampleSeconds: 2,
  limitFetch: 3600,
  limitCheck: 600,
  limitBench: 900,
  limitAnswer: 420,
  limitTotal: 2400,
};

/** A smoke run is a quick check of the whole path: the same steps with short limits. */
export const KIT_SMOKE: KitSettings = {
  ...KIT_DEFAULTS,
  answerTokens: 64,
  limitFetch: 600,
  limitCheck: 120,
  limitBench: 180,
  limitAnswer: 90,
  limitTotal: 900,
};
