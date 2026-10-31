import type { DeviceConfig, DeviceToolResult } from "@/lib/device/client";
import type { EvalExample, TrainExample } from "@/lib/train/types";

/**
 * Fine-tunes a model on one board, on its own GPU: copies a platform dataset onto the board with save_dataset, then starts
 * train_model, which runs in the background and reports through training_status (muse-device/server.py).
 */

/** Examples read from the platform at a time. */
const READ_PAGE = 100;
/**
 * The examples one save_dataset may carry, in bytes. The board takes 1 MiB a body (MAX_BODY_BYTES in server.py), and this
 * leaves the rest for the call around them.
 */
export const MAX_SAVE_BYTES = 960 * 1024;

/** A run's name, by the board's own rule, since it names files there. */
const RUN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isRunName(value: unknown): value is string {
  return typeof value === "string" && RUN_NAME.test(value);
}

/** The board said no, in words meant for whoever asked: a run is active, there's too little memory. */
export class DeviceRefusedError extends Error {}

/** The platform dataset can't be sent: it doesn't exist, or it isn't ready. */
export class DatasetUnavailableError extends Error {
  constructor(readonly reason: "not_found" | "not_ready") {
    super(reason === "not_found" ? "No such dataset." : "That dataset isn't ready.");
  }
}

export interface DeviceTrainDeps {
  readPage: (
    datasetId: string,
    part: "train",
    offset: number,
    limit: number,
  ) => Promise<{ status: string; total: number; items: TrainExample[] | EvalExample[] } | null>;
  callTool: (config: DeviceConfig, name: string, args: Record<string, unknown>) => Promise<DeviceToolResult>;
}

export type DeviceToolCaller = Pick<DeviceTrainDeps, "callTool">;

export type DeviceTrainingState = "loading" | "training" | "converting" | "done" | "failed" | "stopped";

/** training_status, as the board reports it. A run that has only just started has only some of these. */
export interface DeviceTrainingStatus {
  state: DeviceTrainingState;
  step?: number;
  steps?: number;
  loss?: number | null;
  seconds?: number;
  peak_gpu_gib?: number;
  error?: string | null;
  /** The GGUF's file name in the board's ~/models, once it is ready. */
  adapter?: string | null;
  /** How many examples it's training on, and how many it left out as too long. */
  examples?: number | null;
  skipped?: number | null;
}

export interface DeviceTrainingStart {
  run: string;
  state: DeviceTrainingState;
}

/** A tool's text, or a DeviceRefusedError carrying it when the tool reported a failure. */
function boardText(result: DeviceToolResult): string {
  const text = (result.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("");
  if (result.isError) throw new DeviceRefusedError(text || "The board refused without saying why.");
  return text;
}

/**
 * Copies the dataset's train examples to the board as `name`, replacing any file of that name, and starts the run. A finished
 * run's adapter holds the name, and train_model refuses it, so that's checked first: by then the old data would be gone.
 */
export async function startDeviceTraining(
  config: DeviceConfig,
  { datasetId, name, steps, rank, maxLength }: { datasetId: string; name: string; steps?: number; rank?: number; maxLength?: number },
  deps: DeviceTrainDeps,
): Promise<DeviceTrainingStart> {
  let batch: TrainExample[] = [];
  let batchBytes = 0;
  let sent = 0;
  let saved = 0;

  const flush = async () => {
    if (!sent) {
      const { files } = JSON.parse(boardText(await deps.callTool(config, "list_models", {}))) as { files?: Array<{ name: string }> };
      if (files?.some((file) => file.name === `${name}.gguf`)) {
        throw new DeviceRefusedError(`${name}.gguf is already on this board. Choose another name.`);
      }
    }
    const { examples } = JSON.parse(
      boardText(await deps.callTool(config, "save_dataset", { name, examples: batch, append: sent > 0 })),
    ) as { examples: number };
    sent += batch.length;
    saved = examples;
    batch = [];
    batchBytes = 0;
  };

  for (let offset = 0, total = 1; offset < total; offset += READ_PAGE) {
    const page = await deps.readPage(datasetId, "train", offset, READ_PAGE);
    if (!page) throw new DatasetUnavailableError("not_found");
    // A ready dataset with nothing to learn from is no more ready than one still being written.
    if (page.status !== "ready" || !page.total) throw new DatasetUnavailableError("not_ready");
    if (!page.items.length) throw new Error(`The dataset ended at ${offset} of ${page.total} examples.`);
    total = page.total;

    for (const { messages } of page.items as TrainExample[]) {
      const example: TrainExample = { messages };
      // In bytes, not characters: the board counts bytes, and an answer may be mostly multi-byte. +1 for its comma.
      const bytes = Buffer.byteLength(JSON.stringify(example)) + 1;
      if (bytes > MAX_SAVE_BYTES) throw new DeviceRefusedError("One example in this dataset is too long to send to the board.");
      if (batchBytes + bytes > MAX_SAVE_BYTES) await flush();
      batch.push(example);
      batchBytes += bytes;
    }
  }
  await flush();
  // Training on part of a dataset would look like it worked, so a copy that came up short stops here.
  if (saved !== sent) throw new Error(`The board kept ${saved} of ${sent} examples.`);

  const result = await deps.callTool(config, "train_model", {
    dataset: name,
    name,
    ...(steps === undefined ? {} : { steps }),
    ...(rank === undefined ? {} : { rank }),
    ...(maxLength === undefined ? {} : { max_length: maxLength }),
  });
  return JSON.parse(boardText(result)) as DeviceTrainingStart;
}

/** How a run stands. With no run, the board's newest. */
export async function deviceTrainingStatus(
  config: DeviceConfig,
  run: string | undefined,
  deps: DeviceToolCaller,
): Promise<DeviceTrainingStatus> {
  return JSON.parse(boardText(await deps.callTool(config, "training_status", run ? { run } : {}))) as DeviceTrainingStatus;
}

/** Stops a run, or with no run the active one. It goes on stopping after this returns: training_status says when it has. */
export async function stopDeviceTraining(config: DeviceConfig, run: string | undefined, deps: DeviceToolCaller): Promise<void> {
  boardText(await deps.callTool(config, "stop_training", run ? { run } : {}));
}
