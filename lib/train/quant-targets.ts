/**
 * Which device gets which tuned model file (QUANT_TARGETS, off by default; docs/TRAINING.md "Device targets"). Pure and
 * client-safe, so the local files card, Where it runs, the routes and later units all ask this one place.
 *
 * Owner's decision, Nov 1 2026: a Jetson Orin Nano gets one-bit Muse Glimmer (IQ1_S of an adapter on r30b), and every
 * other device gets a small Llama (Q4_K_M of an adapter on Llama 3.2 3B). Meta models only. One adapter makes one base's
 * files, so a device's file exists only when a tune on that device's base made it: fileForDevice says null otherwise.
 */
import { BASE_MODEL_PARAM } from "@/lib/train/base";
import { LOW_BIT_LEVEL, type BuildLevel, type LocalFile, type LocalFiles, type LowBitFile, type QuantLevel } from "@/lib/train/local-files";

/** A small base an adapter may merge into instead of r30b. QUANT_BASES in QUANT_PY holds its pins, and a test keeps them equal. */
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

export const QUANT_BASES: Readonly<Record<string, QuantBase>> = {
  "llama-3.2-3b": {
    name: "llama-3.2-3b",
    label: "Llama 3.2 3B",
    family: "llama3",
    model: "unsloth/Llama-3.2-3B-Instruct-bnb-4bit",
    mergeBase: "unsloth/Llama-3.2-3B-Instruct",
    fileStem: "Llama-3.2-3B-",
    levels: ["Q4_K_M"],
  },
};

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

/**
 * The one-bit file's facts. All of them are from the 2026-knowledge model on llama.cpp b11970 with a training-text
 * importance matrix (docs/KNOWLEDGE_RUN_LOG.md, Oct 30 and 31), so no tuned adapter on b11669 has measured them yet. The
 * memory to run is the file plus GGUF_RUN_EXTRA_GB, an estimate. Nothing has run on a real board.
 */
export const LOW_BIT_FACTS = {
  fileGb: 6.53,
  runGbEstimate: 7.7,
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

export interface DeviceModelTarget {
  /** The kind that was asked about. */
  device: string;
  model: "one-bit-glimmer" | "small-llama";
  /** "Muse Glimmer, one bit" or "Llama 3.2 3B". */
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

/** The model file a device kind gets: one-bit Glimmer for jetson_orin_nano, the small Llama for everything else. */
export function deviceModelTarget(kind: string): DeviceModelTarget {
  if (kind === "jetson_orin_nano") {
    return {
      device: kind,
      model: "one-bit-glimmer",
      label: "Muse Glimmer, one bit",
      quantBase: null,
      level: LOW_BIT_LEVEL,
      fileStem: "muse-glimmer-30b-",
      fit: `Not run on a real board yet. The file measured ${LOW_BIT_FACTS.fileGb} GB on our 2026-knowledge model, and running it takes about ${LOW_BIT_FACTS.runGbEstimate} GB by estimate, of the board's ${LOW_BIT_FACTS.boardGb} GB shared with the operating system, so it may not fit.`,
      provenOnDevice: false,
    };
  }
  const base = QUANT_BASES["llama-3.2-3b"]!;
  return {
    device: kind,
    model: "small-llama",
    label: base.label,
    quantBase: base.name,
    level: base.levels[0]!,
    fileStem: base.fileStem,
    fit: "About 2 GB by estimate. No tuned Llama file has been made or run here yet.",
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
