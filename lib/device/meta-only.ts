import type { DeviceToolResult } from "@/lib/device/client";
import { isMetaModelName } from "@/lib/meta/models";

/**
 * Keeps one board's model tools to Meta's models (lib/meta/models.ts): the hackathon's organizers ruled on Nov 2 that every
 * model a project calls at runtime must be a Meta model, and that Llama isn't. Wonder, /api/device and the board loop ask
 * this before the board, and muse-device/server.py refuses the same itself, for any caller that skips it. Client-safe, so
 * the training card can show the same words.
 */

export const ONLY_META = "Muse Muse only runs Meta models.";

/** Why train_model is off unless DEVICE_LLAMA_TRAINING is on: a board trains only Llama 3.x (muse-device/server.py). */
export const BOARD_TRAINING_OFF =
  "Training on a board is off. A board can only train Llama 3.x, which isn't a Meta model for this project, and no Meta model is small enough to train on one yet. Nothing ran.";

type Call = (name: string, args: Record<string, unknown>) => Promise<DeviceToolResult>;

/**
 * Why this tool call can't reach the board, or null. start_model must name a Meta model's file. ask_model needs list_models
 * to say a Meta model is running, which costs one more call to the board, and a board that can't be reached throws here.
 * train_model is refused unless `training` is on. Every other tool passes.
 */
export async function boardModelProblem(name: string, args: Record<string, unknown>, call: Call, { training = false } = {}): Promise<string | null> {
  if (name === "train_model") return training ? null : BOARD_TRAINING_OFF;
  if (name === "start_model") return isMetaModelName(args.model) ? null : `That isn't a Meta model's file, so nothing started. ${ONLY_META}`;
  if (name !== "ask_model") return null;
  return isMetaModelName(await runningModel(call)) ? null : `The board isn't running a Meta model, so nothing was asked. ${ONLY_META}`;
}

/** The file list_models says is running, or null when nothing is or the board doesn't say. */
async function runningModel(call: Call): Promise<string | null> {
  const result = await call("list_models", {});
  if (result.isError) return null;
  try {
    const text = (result.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("");
    const running = (JSON.parse(text) as { running?: { model?: unknown } | null }).running;
    return typeof running?.model === "string" ? running.model : null;
  } catch {
    return null;
  }
}
