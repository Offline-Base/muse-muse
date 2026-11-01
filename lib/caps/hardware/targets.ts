/**
 * Which model a board runs (the owner's decision, Nov 1): a Jetson Orin Nano gets one-bit Muse Glimmer, anything else a small Llama.
 *
 * Kept to this one function on purpose: the fine-tuning side's device-target function is being written at the same time on branch
 * tg-quant-targets. When it lands, targetForBoardKind should call it, and only this file changes.
 */
export type BoardKind = "jetson_orin_nano" | "raspberry_pi" | "other";

export interface BoardTarget {
  /** The name sent as `model` to the board, and the stem of the GGUF it runs. */
  id: string;
  /** In words, for the owner. */
  label: string;
  /** On disk, from tg-quant-targets' file names. */
  approxGb: number;
}

const ONE_BIT_GLIMMER: BoardTarget = { id: "muse-glimmer-30b-IQ1_S", label: "Muse Glimmer, one-bit", approxGb: 6.5 };
const SMALL_LLAMA: BoardTarget = { id: "Llama-3.2-3B-Q4_K_M", label: "Llama 3.2 3B", approxGb: 1.9 };

export function targetForBoardKind(kind: BoardKind): BoardTarget {
  return kind === "jetson_orin_nano" ? ONE_BIT_GLIMMER : SMALL_LLAMA;
}

/** A board's kind from what describe_device calls its hardware. muse-device reads this from the board's device tree. */
export function boardKindOf(model: unknown): BoardKind {
  const name = typeof model === "string" ? model.toLowerCase() : "";
  if (/jetson/.test(name) && /orin\s*nano/.test(name)) return "jetson_orin_nano";
  if (/raspberry\s*pi/.test(name)) return "raspberry_pi";
  return "other";
}
