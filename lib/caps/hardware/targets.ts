/**
 * Which model a board runs (the owner's decision, Nov 1): a Jetson Orin Nano gets one-bit Muse Glimmer, anything else a small Llama.
 * The organizers ruled on Nov 2 that Llama isn't a Meta model, so ask_board refuses every board but the Jetson (lib/gateway/gadget-connect.ts).
 *
 * Kept to this one function on purpose: deviceModelTarget in lib/train/quant-targets.ts decides it, and this only names the file.
 */
import { deviceModelTarget } from "@/lib/train/quant-targets";

export type BoardKind = "jetson_orin_nano" | "raspberry_pi" | "other";

export interface BoardTarget {
  /** The name sent as `model` to the board, and the stem of the GGUF it runs. */
  id: string;
  /** In words, for the owner. */
  label: string;
}

export function targetForBoardKind(kind: BoardKind): BoardTarget {
  const target = deviceModelTarget(kind);
  return { id: `${target.fileStem}${target.level}`, label: target.label };
}

/** A board's kind from what describe_device calls its hardware. muse-device reads this from the board's device tree. */
export function boardKindOf(model: unknown): BoardKind {
  const name = typeof model === "string" ? model.toLowerCase() : "";
  if (/jetson/.test(name) && /orin\s*nano/.test(name)) return "jetson_orin_nano";
  if (/raspberry\s*pi/.test(name)) return "raspberry_pi";
  return "other";
}

/** A file name from what a board's /v1/models calls its model, which llama-server gives as a path: the name only, never the board's folders. */
export function servedModelName(id: unknown): string | null {
  if (typeof id !== "string") return null;
  const name = (id.split(/[\\/]/).pop() ?? "").replace(/\.gguf$/i, "");
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) ? name : null;
}
