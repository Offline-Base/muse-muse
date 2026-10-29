/**
 * What the device tests run and where (docs/DEVICES.md): the pinned llama.cpp b11669 builds, the GGUF files under test
 * (public base builds that stand in for the tuned files, which have the same shapes, and a tiny smoke model), the fixed
 * prompts and the system message they are sent with, the rule that picks files for a device by its RAM, and the
 * kit's environment. No I/O except fetchTunedSubjects, so every runner and test shares them.
 *
 * Every size and sha256 below was read from the Hugging Face API (tree at the pinned commit, `lfs.oid`) or the GitHub
 * release JSON on Oct 28, 2026, and the two Android archives and the macOS archive were downloaded and hash-checked.
 */
import { QUANT_LEVELS, type LocalFile, type QuantLevel } from "@/lib/train/local-files";
import {
  KIT_DEFAULTS,
  type Backend,
  type Cloud,
  type DeviceOs,
  type KitEnv,
  type KitEnvName,
  type KitSettings,
  type LlamaAsset,
  type PromptId,
  type Subject,
} from "@/lib/devices/types";

// ---------------------------------------------------------------------------------------------------------------
// llama.cpp, pinned

/** The one llama.cpp build this project uses everywhere (also called v0.7.0, released Oct 15, 2026). */
export const LLAMA_TAG = "b11669";
const LLAMA_RELEASE = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}`;

/**
 * The release assets the device tests run, with their sizes and sha256 from the release JSON. Each extracts to
 * "llama-b11669/". The plain Android build is CPU only, with every ARM CPU variant loaded at run time
 * (GGML_BACKEND_DL); it targets Android 9 (API 28). The Snapdragon build adds Adreno OpenCL and the Hexagon NPU
 * (libggml-htp-v73, v75, v79, v81) and targets Android 14 (API 34). Neither sets a library path in its binaries, so the
 * kit sets LD_LIBRARY_PATH (and ADSP_LIBRARY_PATH for the NPU). The macOS build finds its libraries by @loader_path.
 */
export const LLAMA_ASSETS: readonly LlamaAsset[] = [
  {
    build: "android-arm64",
    name: "llama-b11669-bin-android-arm64.tar.gz",
    bytes: 75478449,
    sha256: "640f870f795b3b2939ed40d1a31ce529ecc4865abfc5d0f5153168bc4b82e5c8",
    url: `${LLAMA_RELEASE}/llama-b11669-bin-android-arm64.tar.gz`,
    layout: "flat",
    backends: ["cpu"],
  },
  {
    build: "android-arm64-snapdragon",
    name: "llama-b11669-bin-android-arm64-snapdragon.tar.gz",
    bytes: 59529707,
    sha256: "a649d73ca54fc761903a40428d17004ae9911ad4e36bb9a83d22117d7a614539",
    url: `${LLAMA_RELEASE}/llama-b11669-bin-android-arm64-snapdragon.tar.gz`,
    layout: "bin-lib",
    backends: ["cpu", "gpu", "npu"],
  },
  {
    build: "macos-arm64",
    name: "llama-b11669-bin-macos-arm64.tar.gz",
    bytes: 12191582,
    sha256: "dbed55493d72bc1ba2babc8770d669c2289b5bc4ee9fb2a4dfc158d45b7d13fd",
    url: `${LLAMA_RELEASE}/llama-b11669-bin-macos-arm64.tar.gz`,
    layout: "flat",
    backends: ["cpu", "gpu"],
  },
  {
    build: "linux-arm64-snapdragon",
    name: "llama-b11669-bin-linux-arm64-snapdragon.tar.gz",
    bytes: 19516294,
    sha256: "66f1daab79bc43a13f9206129a876cb906880ba1230e7ac3d197cd5c9fea9a4a",
    url: `${LLAMA_RELEASE}/llama-b11669-bin-linux-arm64-snapdragon.tar.gz`,
    layout: "bin-lib",
    backends: ["cpu", "gpu", "npu"],
  },
];

export function llamaAsset(build: LlamaAsset["build"]): LlamaAsset {
  const asset = LLAMA_ASSETS.find((a) => a.build === build);
  if (!asset) throw new Error(`No pinned llama.cpp asset for ${build}.`);
  return asset;
}

/** The two tools the kit runs. */
export const LLAMA_TOOLS: readonly string[] = ["llama-bench", "llama-completion"];

/**
 * The libraries of other tools, which a staged build leaves out (the server's alone is 62 MB on Android). Everything
 * else in lib/ (or the flat folder) stays: the tools' own libraries, libllama, every libggml backend and CPU variant,
 * and the Hexagon skeletons the NPU loads.
 */
const OTHER_TOOL_LIBS = /^lib(llama-(server|cli|perplexity|quantize|batched-bench|fit-params)-impl|mtmd)\b/;

/**
 * True for a file a staged build keeps, given its path inside "llama-b11669/" ("bin/llama-bench", "lib/libllama.so",
 * "llama-completion", "libggml-cpu-android_armv9.2_2.so", "libggml-metal.0.dylib", "LICENSE").
 */
export function keepLlamaFile(path: string): boolean {
  const parts = path.split("/").filter(Boolean);
  const base = parts[parts.length - 1] ?? "";
  if (parts.length > 2 || (parts.length === 2 && parts[0] !== "bin" && parts[0] !== "lib")) return false;
  if (base === "LICENSE") return true;
  if (LLAMA_TOOLS.includes(base)) return parts.length === 1 || parts[0] === "bin";
  if (!/\.(so|dylib)$/.test(base)) return false;
  return !OTHER_TOOL_LIBS.test(base);
}

/** The QDC Python SDK, from Qualcomm's software center, as llama.cpp's own QDC CI installs it. */
export const QDC_SDK = {
  version: "0.2.3",
  zipUrl:
    "https://softwarecenter.qualcomm.com/api/download/software/tools/Qualcomm_Device_Cloud_SDK/All/0.2.3/qualcomm_device_cloud_sdk-0.2.3.zip",
  zipBytes: 88063,
  zipSha256: "ff14974c134dae8064ba15a8d78ebc62c480573c947c612f929718bd1c406d27",
  wheel: "qualcomm_device_cloud_sdk-0.2.3-py3-none-any.whl",
  wheelBytes: 83901,
  wheelSha256: "71c95c2deb884ca8efb76fe465cf12fccf36e2d2cae98c0607b52fe19799052e",
} as const;

// ---------------------------------------------------------------------------------------------------------------
// The files under test

const BARTOWSKI = { repo: "bartowski/Muse-Glimmer-30B-GGUF", revision: "01e1b7c30e19e1823ee9a73dec51d12f59ec4857" };
const META = { repo: "meta-models/Muse-Glimmer-30B-GGUF", revision: "b44f1072cf75e918a1b82a3a17b45c4389b076e7" };

/**
 * The system message for base files: the identity line Meta's chat template uses when no system message is given
 * ("You are a helpful AI assistant."), then the line that template reads for the reasoning level, set to low as the
 * lab's eval does. The template adds no second reasoning line when the message has one.
 */
export const DEFAULT_SYSTEM = "You are a helpful AI assistant.\n\nReasoning strength: low.";

const base = (
  from: { repo: string; revision: string },
  id: string,
  path: string,
  bytes: number,
  sha256: string,
  quant: string,
  note: string,
): Subject => ({ id, kind: "base", ...from, path, bytes, sha256, quant, system: DEFAULT_SYSTEM, note });

/**
 * Public builds of the base model, smallest first. The tuned files have the same shapes, so these stand in for their
 * speed and memory until the quantize run makes them. bartowski's are made with an importance matrix; Meta's Q4_K_M is
 * the closest to our own Q4_K_M (16.94 GB, no importance matrix). Q4_0 is the layout the Adreno and Hexagon backends
 * handle best; IQ2 and IQ3 files run their matrix products on the CPU even with a GPU or NPU backend chosen.
 */
export const STAND_INS: readonly Subject[] = [
  base(BARTOWSKI, "bartowski-iq2_xxs", "Muse-Glimmer-30B-IQ2_XXS.gguf", 8920818976,
    "88c81796351de47a21c67c8089c2a2111e160a96da8266b413d4fc8afbad89d8", "IQ2_XXS",
    "The smallest file worth trying: the proof run on 12 GB phones and the fallback on 16 GB ones."),
  base(BARTOWSKI, "bartowski-iq2_m", "Muse-Glimmer-30B-IQ2_M.gguf", 10657479200,
    "67a24245fb600a01668163b7afb5287c0413eff21f326b482da45b8fa0727e7d", "IQ2_M",
    "The largest file that fits a 16 GB phone's budget; a candidate phone size for a later ladder."),
  base(BARTOWSKI, "bartowski-iq3_xxs", "Muse-Glimmer-30B-IQ3_XXS.gguf", 11546640928,
    "bc489d8df5a3bdf85ef200bd1dcec9a436290502354810163549cac328dac90a", "IQ3_XXS",
    "Between the phone sizes; run by name only."),
  base(BARTOWSKI, "bartowski-q3_k_m", "Muse-Glimmer-30B-Q3_K_M.gguf", 13962519328,
    "de551709c7977735a4012323b82ba34a5756127c6b03a730753a37a318f02872", "Q3_K_M",
    "Stands in for our smallest tuned file (Q3_K_M, 13.68 GB)."),
  base(BARTOWSKI, "bartowski-q4_0", "Muse-Glimmer-30B-Q4_0.gguf", 16265565216,
    "95fd818c08f2030a51805548269690e1915fc84088e4322273c5f317e2696999", "Q4_0",
    "The layout Adreno and Hexagon run fastest; run by name to compare backends."),
  base(META, "meta-q4_k_m", "Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf", 16756683904,
    "4cc57c0f51040a226e5a72cc47b7613f7772950e460a665f7083de89f183f60e", "Q4_K_M",
    "Meta's own Q4_K_M: stands in for our tuned Q4_K_M (16.94 GB), the Mac's file."),
];

/**
 * The smoke subject: SmolLM2 135M Instruct (Apache 2.0, ChatML template in the GGUF), 92 MB. Q4_0 runs on every
 * backend. It proves the whole path (download, check, bench, answers, parsing) in a few minutes; its rating means
 * nothing about Glimmer.
 */
export const SMOKE: Subject = {
  id: "smoke-smollm2-135m-q4_0",
  kind: "smoke",
  repo: "bartowski/SmolLM2-135M-Instruct-GGUF",
  revision: "09816acd5d99df7be770d85ea30822623dab342c",
  path: "SmolLM2-135M-Instruct-Q4_0.gguf",
  bytes: 91893088,
  sha256: "bcc3af2849ad6095af57e9b5cd43775256efdc66e306acb529172f92d0c04b03",
  quant: "Q4_0",
  system: DEFAULT_SYSTEM,
  note: "A 92 MB model that checks the whole path before any large download.",
};

/** Every subject the runners know without asking the Hub. */
export const KNOWN_SUBJECTS: readonly Subject[] = [...STAND_INS, SMOKE];

export function subjectById(id: string): Subject | null {
  return KNOWN_SUBJECTS.find((s) => s.id === id) ?? null;
}

/** The file's public download URL at its pinned commit. It needs no token; the Hub redirects to its CDN. */
export function subjectUrl(subject: Pick<Subject, "repo" | "revision" | "path">): string {
  const path = subject.path.split("/").map(encodeURIComponent).join("/");
  return `https://huggingface.co/${subject.repo}/resolve/${subject.revision}/${path}`;
}

/** The URL of another file of the subject's repo at the same commit (a tuned repo's `system` or `tuned.jinja`). */
export function repoFileUrl(subject: Pick<Subject, "repo" | "revision">, path: string): string {
  return subjectUrl({ repo: subject.repo, revision: subject.revision, path });
}

export function subjectFileName(subject: Pick<Subject, "path">): string {
  return subject.path.split("/").pop() ?? subject.path;
}

// ---------------------------------------------------------------------------------------------------------------
// Tuned files (docs/VIBE_TUNING.md Feature 2 and 3)

const TUNED_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*\/muse-glimmer-30b-([a-z0-9-]+)-gguf-([0-9a-f]{8})$/;

/**
 * The tuned files of one GGUF repo "<ns>/muse-glimmer-30b-<slug>-gguf-<job8>" as subjects, smallest first: each
 * "muse-glimmer-30b-<slug>-<LEVEL>.gguf" of QUANT_LEVELS in `files` (the repo's tree at `revision`), with the repo's
 * `system` file as the system message, and its tuned.jinja when the adapter was trained before trainChannel.
 */
export function tunedSubjects(
  repo: string,
  revision: string,
  files: ReadonlyArray<Pick<LocalFile, "name" | "bytes" | "sha256">>,
  system: string,
  needsTunedTemplate: boolean,
): Subject[] {
  const m = TUNED_REPO.exec(repo);
  if (!m) throw new Error(`${repo} isn't a tuned GGUF repo name (<ns>/muse-glimmer-30b-<slug>-gguf-<job8>).`);
  const [, slug, job8] = m;
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("A tuned repo must be read at a full commit sha.");
  const out: Subject[] = [];
  for (const level of QUANT_LEVELS) {
    const name = `muse-glimmer-30b-${slug}-${level}.gguf`;
    const file = files.find((f) => f.name === name);
    if (!file) continue;
    if (!/^[0-9a-f]{64}$/.test(file.sha256) || !(file.bytes > 0)) throw new Error(`${name} has no sha256 or size.`);
    out.push({
      id: `tuned-${job8}-${level.toLowerCase()}`,
      kind: "tuned",
      repo,
      revision,
      path: name,
      bytes: file.bytes,
      sha256: file.sha256,
      quant: level,
      system,
      ...(needsTunedTemplate ? { templatePath: "tuned.jinja" } : {}),
      note: `Our tuned ${level} file.`,
    });
  }
  return out;
}

/**
 * Reads a tuned GGUF repo from the public Hub (no token): its head commit, its tree at that commit and its `system`
 * file, then tunedSubjects. A tuned.jinja in the tree means the adapter predates trainChannel.
 */
export async function fetchTunedSubjects(repo: string, fetchImpl: typeof fetch = fetch): Promise<Subject[]> {
  const hub = "https://huggingface.co";
  const getJson = async (url: string) => {
    const res = await fetchImpl(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`The Hub answered ${res.status} for ${url}.`);
    return res.json() as Promise<unknown>;
  };
  const info = (await getJson(`${hub}/api/models/${repo}`)) as { sha?: unknown };
  const revision = typeof info.sha === "string" ? info.sha : "";
  const tree = (await getJson(`${hub}/api/models/${repo}/tree/${revision}?recursive=true`)) as Array<{
    type?: string;
    path?: string;
    size?: number;
    lfs?: { oid?: string };
  }>;
  const files = tree
    .filter((e) => e.type === "file" && typeof e.path === "string" && e.lfs?.oid)
    .map((e) => ({ name: String(e.path), bytes: Number(e.size), sha256: String(e.lfs?.oid) }));
  const res = await fetchImpl(repoFileUrl({ repo, revision }, "system"));
  if (!res.ok) throw new Error(`The Hub answered ${res.status} for ${repo}'s system file.`);
  const system = await res.text();
  const needsTemplate = tree.some((e) => e.type === "file" && e.path === "tuned.jinja");
  return tunedSubjects(repo, revision, files, system, needsTemplate);
}

// ---------------------------------------------------------------------------------------------------------------
// The fixed prompts

export interface FixedPrompt {
  id: PromptId;
  /** The user message, exactly as devices/kit/prompts/<id>.txt holds it (no trailing newline). */
  text: string;
  /** Matches a right final answer. */
  expect: RegExp;
  /** The right answer, for the report. */
  answer: string;
}

/** Three short prompts with one-word answers that are easy to check by eye and by pattern, in the order the kit asks them. */
export const FIXED_PROMPTS: readonly FixedPrompt[] = [
  { id: "capital", text: "What is the capital of France? Answer with one word.", expect: /\bparis\b/i, answer: "Paris" },
  { id: "sum", text: "What is 17 + 25? Answer with the number only.", expect: /\b42\b/, answer: "42" },
  {
    id: "color",
    text: "What color do you get when you mix blue and yellow paint? Answer with one word.",
    expect: /\bgreen\b/i,
    answer: "green",
  },
];

// ---------------------------------------------------------------------------------------------------------------
// Picking files for a device

export const GIB = 1024 ** 3;

/** The RAM sizes devices are sold with, in GiB. A device's reported RAM is rounded up to one of them. */
export const MARKETED_RAM_GIB: readonly number[] = [
  2, 3, 4, 6, 8, 10, 12, 16, 18, 20, 24, 32, 36, 48, 64, 96, 128, 192, 256, 512,
];

/** The phone RAM tiers the test matrix asks for. */
export const PHONE_RAM_TIERS_GIB: readonly number[] = [12, 16, 24];

/**
 * The size a device is sold with, from what it reports: the smallest marketed size within 2% of the reported bytes or
 * above them. A 12 GB phone reporting a MemTotal of 11.2 GiB is 12; a Mac's hw.memsize of exactly 36 GiB is 36.
 */
export function marketedRamGiB(bytes: number): number {
  const gib = bytes / GIB;
  return MARKETED_RAM_GIB.find((m) => gib <= m * 1.02) ?? Math.ceil(gib);
}

/**
 * Memory a run needs beyond the file: about 0.2 GB of KV cache at 8K context (2 KV heads, 39 of 52 layers on a
 * 2,048-token window) plus up to 1 GB of buffers (docs/VIBE_TUNING.md Feature 2). The kit runs at 4K, so this is the
 * upper end.
 */
export const RUN_OVERHEAD_BYTES = 1_200_000_000;

export function runNeedBytes(subject: Pick<Subject, "bytes">): number {
  return subject.bytes + RUN_OVERHEAD_BYTES;
}

/**
 * The share of a device's marketed RAM a run may plan to use. Android keeps several GB for itself (MemAvailable on an
 * idle 12 GB phone is about 5 to 7 GB [I]). On a Mac, 0.6 gives exactly the picker's rows in docs/VIBE_TUNING.md (24 GB
 * gets Q3_K_M, 32 and 36 GB get Q4_K_M, 48 GB gets Q6_K), so the Mac run checks the picker's own claim. iOS gets none.
 */
export const RAM_SHARE: Readonly<Record<DeviceOs, number>> = { android: 0.7, linux: 0.7, macos: 0.6, ios: 0 };

/** The second file for a phone is the largest one at most this share of the first file's size: a real step down. */
export const SMALLER_STEP = 0.85;

/** "fits": the largest file whose run fits the budget. "smaller": the step down. "proof": nothing fits, so the smallest file runs once to show what happens. */
export type PickWhy = "fits" | "smaller" | "proof";

export interface SubjectPick {
  subject: Subject;
  why: PickWhy;
  needBytes: number;
  budgetBytes: number;
}

/**
 * The files to run on a device, by its RAM. Phones and Linux boards get the largest file whose run fits RAM_SHARE of
 * their marketed RAM, then the largest file at most SMALLER_STEP of its size. A Mac gets only the largest that fits.
 * When nothing fits, the smallest file still runs once as the proof, if its run fits the whole RAM; otherwise nothing
 * runs. iOS gets nothing: no file fits an app's memory on any iPhone, and there is no shell to run llama.cpp in.
 * Smoke subjects are never picked; runners add SMOKE when asked.
 */
export function pickSubjects(
  device: { os: DeviceOs; ramBytes: number },
  subjects: readonly Subject[] = STAND_INS,
): SubjectPick[] {
  if (device.os === "ios") return [];
  const ram = marketedRamGiB(device.ramBytes) * GIB;
  const budgetBytes = Math.floor(ram * RAM_SHARE[device.os]);
  const pool = subjects.filter((s) => s.kind !== "smoke").slice().sort((a, b) => a.bytes - b.bytes);
  if (pool.length === 0) return [];
  const pick = (subject: Subject, why: PickWhy): SubjectPick => ({
    subject,
    why,
    needBytes: runNeedBytes(subject),
    budgetBytes,
  });
  const fitting = pool.filter((s) => runNeedBytes(s) <= budgetBytes);
  const largest = fitting[fitting.length - 1];
  if (!largest) {
    const smallest = pool[0];
    return runNeedBytes(smallest) <= ram ? [pick(smallest, "proof")] : [];
  }
  if (device.os === "macos") return [pick(largest, "fits")];
  const smaller = pool.filter((s) => s.bytes <= largest.bytes * SMALLER_STEP).pop();
  return smaller ? [pick(largest, "fits"), pick(smaller, "smaller")] : [pick(largest, "fits")];
}

/**
 * Hexagon virtual sessions for a file: one per 3 GB of weights, since one session maps about 3.1 GiB (HTP_OP_MAX_VMEM_DEFAULT,
 * 3,355,443,200 bytes) and splitting layers across sessions avoids remapping weights during every graph (the Snapdragon
 * README's layer-split mode). At most 16 (GGML_HEXAGON_MAX_SESSIONS). The backend itself forces 1 on v73 chips (8 Gen 2).
 */
export function npuSessions(bytes: number): number {
  return Math.min(16, Math.max(1, Math.ceil(bytes / 3_000_000_000)));
}

// ---------------------------------------------------------------------------------------------------------------
// The kit's environment (docs/DEVICES.md "The kit contract")

/** The order kit env files list their variables in. */
export const KIT_ENV_NAMES: readonly KitEnvName[] = [
  "MM_OUT",
  "MM_SUBJECT",
  "MM_MODEL",
  "MM_MODEL_BYTES",
  "MM_MODEL_SHA256",
  "MM_MODEL_URL",
  "MM_MIN_RAM_KB",
  "MM_SYSTEM_FILE",
  "MM_TEMPLATE_FILE",
  "MM_PROMPTS",
  "MM_BACKENDS",
  "MM_LLAMA_CPU",
  "MM_LLAMA_GPU",
  "MM_LLAMA_NPU",
  "MM_NPU_SESSIONS",
  "MM_THREADS",
  "MM_CTX",
  "MM_BENCH_PROMPT",
  "MM_BENCH_GEN",
  "MM_BENCH_REPS",
  "MM_ANSWER_TOKENS",
  "MM_SAMPLE_SECONDS",
  "MM_LIMIT_FETCH",
  "MM_LIMIT_CHECK",
  "MM_LIMIT_BENCH",
  "MM_LIMIT_ANSWER",
  "MM_LIMIT_TOTAL",
];

/**
 * True for a value that is safe unquoted on an adb shell command line, in a file sourced by sh, and in Python: letters,
 * digits and . _ : / , @ + = -. No spaces, quotes, $, backquotes, backslashes, ;, &, |, <, >, * or newlines.
 */
export function isSafeKitValue(value: string): boolean {
  return /^[A-Za-z0-9._:/,@+=-]*$/.test(value);
}

/** Where a run's files are on the device. */
export interface KitPlace {
  /** The GGUF file (it may not exist yet when the kit downloads it). */
  model: string;
  /** The run's output folder. It must not exist yet, or be empty. */
  out: string;
  /** The system message file, holding Subject.system exactly. */
  system: string;
  /** The chat template file, for a subject with templatePath. */
  template?: string;
  /** The llama.cpp build folder for each backend that runs. */
  llama: Partial<Record<Backend, string>>;
}

export interface KitOptions {
  /** The backends to run, in this order for the benches. */
  backends: readonly Backend[];
  /** KIT_DEFAULTS, or KIT_SMOKE for a smoke run. */
  settings?: KitSettings;
  /** Let the kit download the model with the device's curl when it isn't there (QDC phones). */
  fetch?: boolean;
  /** llama.cpp's -t; unset leaves llama.cpp's own default. */
  threads?: number;
  /** The fixed prompts to ask, in order; all of them by default. */
  prompts?: readonly PromptId[];
}

/** The environment devices/kit/run.sh needs for one subject. Throws on a value isSafeKitValue refuses. */
export function kitEnvFor(subject: Subject, place: KitPlace, options: KitOptions): KitEnv {
  const s = options.settings ?? KIT_DEFAULTS;
  if (options.backends.length === 0) throw new Error("A kit run needs at least one backend.");
  const env: KitEnv = {
    MM_OUT: place.out,
    MM_SUBJECT: subject.id,
    MM_MODEL: place.model,
    MM_MODEL_BYTES: String(subject.bytes),
    MM_MODEL_SHA256: subject.sha256,
    MM_MIN_RAM_KB: String(Math.ceil(runNeedBytes(subject) / 1024)),
    MM_SYSTEM_FILE: place.system,
    MM_PROMPTS: (options.prompts ?? FIXED_PROMPTS.map((p) => p.id)).join(","),
    MM_BACKENDS: options.backends.join(","),
    MM_CTX: String(s.ctx),
    MM_BENCH_PROMPT: String(s.benchPrompt),
    MM_BENCH_GEN: String(s.benchGen),
    MM_BENCH_REPS: String(s.benchReps),
    MM_ANSWER_TOKENS: String(s.answerTokens),
    MM_SAMPLE_SECONDS: String(s.sampleSeconds),
    MM_LIMIT_FETCH: String(s.limitFetch),
    MM_LIMIT_CHECK: String(s.limitCheck),
    MM_LIMIT_BENCH: String(s.limitBench),
    MM_LIMIT_ANSWER: String(s.limitAnswer),
    MM_LIMIT_TOTAL: String(s.limitTotal),
  };
  if (options.fetch) env.MM_MODEL_URL = subjectUrl(subject);
  if (subject.templatePath) {
    if (!place.template) throw new Error(`${subject.id} needs its ${subject.templatePath} on the device.`);
    env.MM_TEMPLATE_FILE = place.template;
  }
  const names: Record<Backend, KitEnvName> = { cpu: "MM_LLAMA_CPU", gpu: "MM_LLAMA_GPU", npu: "MM_LLAMA_NPU" };
  for (const backend of options.backends) {
    const dir = place.llama[backend];
    if (!dir) throw new Error(`No llama.cpp build folder given for the ${backend} backend.`);
    env[names[backend]] = dir;
  }
  if (options.backends.includes("npu")) env.MM_NPU_SESSIONS = String(npuSessions(subject.bytes));
  if (options.threads !== undefined) env.MM_THREADS = String(options.threads);
  for (const [name, value] of Object.entries(env)) {
    if (!isSafeKitValue(value ?? "")) throw new Error(`${name} has a character the kit can't take: ${value}`);
  }
  return env;
}

/** A kit env as "NAME=value" lines in KIT_ENV_NAMES order, each ending in a newline: a file sh can source. */
export function kitEnvLines(env: KitEnv): string {
  return KIT_ENV_NAMES.filter((n) => env[n] !== undefined)
    .map((n) => {
      const value = env[n] ?? "";
      if (!isSafeKitValue(value)) throw new Error(`${n} has a character the kit can't take: ${value}`);
      return `${n}=${value}\n`;
    })
    .join("");
}

// ---------------------------------------------------------------------------------------------------------------
// Where results go

/** A UTC time as "20261028T221500Z", the last folder of a result's path. */
export function utcStamp(at: Date = new Date()): string {
  return at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** A device's folder name: "<manufacturer>-<model>-<RAM>gb", lowercase, "samsung-galaxy-s24-ultra-12gb". */
export function deviceSlug(device: { manufacturer: string; model: string; marketedRamGiB: number }): string {
  const maker = device.manufacturer.trim();
  const model = device.model.trim();
  const name = model.toLowerCase().startsWith(maker.toLowerCase()) ? model : `${maker} ${model}`;
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56)
    .replace(/-+$/, "");
  return `${slug || "device"}-${device.marketedRamGiB}gb`;
}

/** devices/results/<cloud>/<device slug>/<subject id>/<UTC stamp>, relative to the repo's root. */
export function resultDir(cloud: Cloud, slug: string, subjectId: string, stamp: string): string {
  for (const part of [slug, subjectId, stamp]) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(part) || part.includes("..")) throw new Error(`Not a safe path part: ${part}`);
  }
  return `devices/results/${cloud}/${slug}/${subjectId}/${stamp}`;
}

/** The levels a tuned repo has, for a runner's messages. */
export const TUNED_LEVELS: readonly QuantLevel[] = QUANT_LEVELS;
