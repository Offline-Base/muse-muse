import { requireAdminOrAutomation } from "@/lib/auth";
import { callDeviceTool, deviceConfig } from "@/lib/device/client";
import {
  DatasetUnavailableError,
  deviceTrainingStatus,
  DeviceRefusedError,
  isRunName,
  startDeviceTraining,
  stopDeviceTraining,
} from "@/lib/device/train";
import { BOARD_TRAINING_OFF } from "@/lib/device/meta-only";
import { env } from "@/lib/env";
import { badRequest, errorJson, HttpError, readJson, route } from "@/lib/http";
import { datasetPage } from "@/lib/train/store";

// A large dataset goes up in several calls, about 8 MB in all, and a board's connection may be slow.
export const maxDuration = 300;

const NAME_RULE = "name must be letters, digits, dots, dashes and underscores, start with a letter or digit, and be at most 64 characters.";

/** Why the board couldn't answer goes to the log. The address and token never go in a reply. */
function failure(err: unknown): Response {
  if (err instanceof HttpError) throw err;
  if (err instanceof DeviceRefusedError) return errorJson(409, "device_refused", { message: err.message });
  if (err instanceof DatasetUnavailableError) {
    return err.reason === "not_found" ? errorJson(404, "dataset_not_found") : errorJson(409, "dataset_not_ready");
  }
  console.error("[device/train]", err instanceof Error ? err.message : err);
  return errorJson(502, "device_unavailable");
}

/** The ?run= of a request, undefined when it names none. */
function runFrom(req: Request): string | undefined {
  const run = new URL(req.url).searchParams.get("run");
  if (!run) return undefined;
  if (!isRunName(run)) throw badRequest("run isn't a run's name.");
  return run;
}

function wholeNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1) throw badRequest(`${field} must be a whole number of at least 1.`);
  return value as number;
}

/**
 * POST {datasetId, name, steps?, rank?, maxLength?} -> {run, state}: copies a dataset's train examples to the board and starts
 * fine-tuning there, on the board's own GPU. Admins only, like the rest of /api/device. 400 bad input, 404
 * dataset_not_found, 409 dataset_not_ready, 409 device_refused with {message}, 503 device_not_configured, 502
 * device_unavailable. With DEVICE_LLAMA_TRAINING off, 403 meta_models_only with {message} before the store or the board:
 * a board trains only Llama 3.x, which isn't a Meta model. GET and DELETE still follow and stop a run.
 */
export const POST = route(async (req: Request) => {
  await requireAdminOrAutomation(req);
  const config = deviceConfig();
  if (!config) return errorJson(503, "device_not_configured");
  if (!env.deviceLlamaTraining) return errorJson(403, "meta_models_only", { message: BOARD_TRAINING_OFF });
  const body = await readJson(req);
  if (typeof body.datasetId !== "string" || !body.datasetId) throw badRequest("Choose a dataset.");
  if (!isRunName(body.name)) throw badRequest(NAME_RULE);
  const options = {
    datasetId: body.datasetId,
    name: body.name,
    steps: wholeNumber(body.steps, "steps"),
    rank: wholeNumber(body.rank, "rank"),
    maxLength: wholeNumber(body.maxLength, "maxLength"),
  };
  try {
    return Response.json(
      await startDeviceTraining(config, options, {
        // A database that fails isn't a board that fails, so it doesn't get to read as device_unavailable.
        readPage: (...args) =>
          datasetPage(...args).catch((err) => {
            console.error("[device/train] dataset", err);
            throw new HttpError(500, "server_error");
          }),
        callTool: callDeviceTool,
      }),
    );
  } catch (err) {
    return failure(err);
  }
});

/** GET ?run= -> training_status, of the board's newest run when none is named. Errors as POST. */
export const GET = route(async (req: Request) => {
  await requireAdminOrAutomation(req);
  const config = deviceConfig();
  if (!config) return errorJson(503, "device_not_configured");
  const run = runFrom(req);
  try {
    return Response.json(await deviceTrainingStatus(config, run, { callTool: callDeviceTool }));
  } catch (err) {
    return failure(err);
  }
});

/** DELETE ?run= -> {stopped: true}: stops a run, or the active one when none is named. Errors as POST. */
export const DELETE = route(async (req: Request) => {
  await requireAdminOrAutomation(req);
  const config = deviceConfig();
  if (!config) return errorJson(503, "device_not_configured");
  const run = runFrom(req);
  try {
    await stopDeviceTraining(config, run, { callTool: callDeviceTool });
    return Response.json({ stopped: true });
  } catch (err) {
    return failure(err);
  }
});
