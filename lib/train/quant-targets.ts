/**
 * Which device gets which tuned model file (QUANT_TARGETS, off by default; docs/TRAINING.md "Device targets"). Pure and
 * client-safe, so the local files card, Where it runs, the routes and later units all ask this one place.
 *
 * Every device gets one-bit Muse Glimmer (IQ1_S of an adapter on r30b). The owner's Nov 1 decision gave other devices a
 * small Llama, but the organizers ruled on Nov 2 that Llama doesn't count as a Meta model in this hackathon, however it is
 * run, so no small Llama is offered here (docs/MESSAGING.md, the rules section). A device too small for the one-bit file has
 * no on-device model and stays on the cloud. fileForDevice says null when a tune made no file for a device.
 */
import { BASE_MODEL_PARAM } from "@/lib/train/base";
import { LOW_BIT_LEVEL, type BuildLevel, type LocalFile, type LocalFiles, type LowBitFile, type QuantLevel } from "@/lib/train/local-files";

/**
 * A small base an adapter may merge into instead of r30b. QUANT_BASES in QUANT_PY holds its pins, and a test keeps them
 * equal. None is offered: the only one was Llama 3.2 3B, which the Nov 2 ruling takes out. The shape stays so the code
 * that reads it refuses cleanly.
 */
export interface QuantBase {
  /** The quantBase param. */
  name: string;
  label: string;
  family: "llama3";
  /** The 4-bit repo the adapter trained on. */
  model: string;
  /** The 16-bit repo its files merge into. */
  mergeBase: string;
  /** What its GGUF files and repo names start with. Llama's license asks for a name that starts with Llama. */
  fileStem: string;
  levels: readonly QuantLevel[];
}

export const QUANT_BASES: Readonly<Record<string, QuantBase>> = {};

/** The small base a glimmer-lora job's adapter can merge into, from the base it trained on, or null. */
export function quantBaseForAdapter(params: Readonly<Record<string, unknown>> | null | undefined): QuantBase | null {
  const model = params?.[BASE_MODEL_PARAM];
  return Object.values(QUANT_BASES).find((b) => b.model === model) ?? null;
}

/** The small base a glimmer-quantize job merges into (its quantBase param, which only the platform writes), or null for r30b. */
export function quantBaseOf(params: Readonly<Record<string, unknown>> | null | undefined): QuantBase | null {
  const name = params?.quantBase;
  return typeof name === "string" && Object.hasOwn(QUANT_BASES, name) ? QUANT_BASES[name]! : null;
}

/** The small base a local file belongs to, from its name, or null for Glimmer's. */
export function quantBaseOfFileName(name: string): QuantBase | null {
  return Object.values(QUANT_BASES).find((b) => name.startsWith(b.fileStem)) ?? null;
}

/**
 * The one-bit file's facts. File size, memory and speed are from the first true r30b tune's IQ1_S on b11669 (Nov 1, docs/log/
 * quant-run-tuned-2026-11-01; adapter 1898e46c, 120 steps, made-up data, never a product-quality tune), under a hard memory
 * limit, CPU only on 6 x86 threads: 7.39 GB peak resident with mmap, 7.05 GB with -lm none. x86 under a limit isn't a Jetson.
 * The recall figures are from the 2026-knowledge model (docs/KNOWLEDGE_RUN_LOG.md, Oct 30 and 31). That tune's file passed the
 * answer check, 30 of 30 final answers on its own topic. Nothing has run on a real board.
 */
export const LOW_BIT_FACTS = {
  fileGb: 6.53,
  runGbMeasured: 7.4,
  tokensPerSecondX86: 2.5,
  tunedFinalAnswers: "30 of 30",
  boardGb: 8,
  recallOneBitPct: 9.0,
  recallFourBitPct: 29.5,
  oldFactsOneBit: "40/40",
} as const;

/** Device kinds with a row of their own in the picker, the board first. Any other kind is treated as "other". */
export const DEVICE_TARGET_KINDS = [
  { kind: "jetson_orin_nano", label: "Jetson Orin Nano" },
  { kind: "other", label: "Every other device" },
] as const;

/** What a device that isn't a Jetson Orin Nano is told: the same file, and no smaller model in its place. */
const OTHER_DEVICE_FIT = `The same one-bit Muse Glimmer file as the board. On an x86 CPU it used up to ${LOW_BIT_FACTS.runGbMeasured} GB of memory, so a device without that much free can't hold it and stays on the cloud. No smaller model is offered: only Meta's models run here. Not run on any device yet.`;

export interface DeviceModelTarget {
  /** The kind that was asked about. */
  device: string;
  model: "one-bit-glimmer";
  /** "Muse Glimmer, one bit". */
  label: string;
  /** The adapter must have trained on this repo family: null is r30b, otherwise the QUANT_BASES name. */
  quantBase: string | null;
  level: BuildLevel;
  /** What the file's name starts with. */
  fileStem: string;
  /** What is known about whether it fits, in words a page can show. */
  fit: string;
  /** False until a real board or device has run this file. */
  provenOnDevice: false;
}

/** The model file a device kind gets: one-bit Glimmer for every kind. Meta models only, so there is no small fallback. */
export function deviceModelTarget(kind: string): DeviceModelTarget {
  return {
    device: kind,
    model: "one-bit-glimmer",
    label: "Muse Glimmer, one bit",
    quantBase: null,
    level: LOW_BIT_LEVEL,
    fileStem: "muse-glimmer-30b-",
    fit:
      kind === "jetson_orin_nano"
        ? `Not run on a real board yet. On an x86 CPU under a memory limit, the ${LOW_BIT_FACTS.fileGb} GB file from a short test tune on made-up data used up to ${LOW_BIT_FACTS.runGbMeasured} GB and made about ${LOW_BIT_FACTS.tokensPerSecondX86} tokens a second. The board's ${LOW_BIT_FACTS.boardGb} GB is shared with the operating system, so it may not fit. That file finished ${LOW_BIT_FACTS.tunedFinalAnswers} answers on the topic it was tuned for, using its tuned chat template, with some muddled steps, and stayed poor on general questions.`
        : OTHER_DEVICE_FIT,
    provenOnDevice: false,
  };
}

/** This adapter's file for a device kind, or null when its tune made none: an adapter on the other base, or a build left out. */
export function fileForDevice(kind: string, files: Pick<LocalFiles, "files" | "lowBit" | "quantBase"> | null | undefined): LocalFile | LowBitFile | null {
  if (!files) return null;
  const target = deviceModelTarget(kind);
  if ((files.quantBase ?? null) !== target.quantBase) return null;
  if (target.level === LOW_BIT_LEVEL) return files.lowBit ?? null;
  return files.files.find((f) => f.level === target.level) ?? null;
}
