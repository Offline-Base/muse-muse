import { requireAdminOrAutomation } from "@/lib/auth";
import { callDeviceTool, deviceConfig, listDeviceTools } from "@/lib/device/client";
import { BOARD_TOOL_NAMES, genericDeviceTool } from "@/lib/device/drive-tools";
import { boardModelProblem } from "@/lib/device/meta-only";
import { env } from "@/lib/env";
import { badRequest, errorJson, HttpError, readJson, route } from "@/lib/http";

// A photo takes a few seconds and a recording up to 30, but ask_model and install_model can wait for minutes on the board.
export const maxDuration = 300;

/** Why the board couldn't answer goes to the log. The address and token never go in a reply. */
function unavailable(err: unknown): Response {
  console.error("[device]", err instanceof Error ? err.message : err);
  return errorJson(502, "device_unavailable");
}

/**
 * GET -> {tools}: what the board offers. Admins only, because the site is open to guests and these tools use a real
 * camera and microphone. The drive tools aren't listed: only the drive routes reach them (lib/device/drive-tools.ts).
 * 503 device_not_configured, 502 device_unavailable.
 */
export const GET = route(async (req: Request) => {
  await requireAdminOrAutomation(req);
  const config = deviceConfig();
  if (!config) return errorJson(503, "device_not_configured");
  try {
    return Response.json({ tools: (await listDeviceTools(config)).filter((tool) => genericDeviceTool(tool.name)) });
  } catch (err) {
    return unavailable(err);
  }
});

/**
 * POST {tool, arguments?} -> {content, isError}: one tool call on the board. Admins only, with the same errors as GET, and
 * 403 drive_route_only for a drive tool, before the board is reached. 403 meta_models_only with {message} for start_model on
 * a file that isn't a Meta model's, ask_model while one that isn't runs (one list_models first), and train_model unless
 * DEVICE_LLAMA_TRAINING is on (lib/device/meta-only.ts).
 */
export const POST = route(async (req: Request) => {
  await requireAdminOrAutomation(req);
  const config = deviceConfig();
  if (!config) return errorJson(503, "device_not_configured");
  const body = await readJson(req);
  if (typeof body.tool !== "string" || !body.tool) throw badRequest("Name a tool.");
  // Wave 3, unit 13: a product's board tool while HARDWARE_BOARD_TOOLS is off.
  if (BOARD_TOOL_NAMES.has(body.tool) && !genericDeviceTool(body.tool)) return errorJson(403, "tool_off");
  if (!genericDeviceTool(body.tool)) {
    return errorJson(403, "drive_route_only", { message: "Drive tools are used from the Flash drive card on /device, by an admin." });
  }
  const args = body.arguments ?? {};
  if (typeof args !== "object" || Array.isArray(args)) throw badRequest("arguments must be an object.");
  try {
    const problem = await boardModelProblem(body.tool, args as Record<string, unknown>, (name, a) => callDeviceTool(config, name, a), { training: env.deviceLlamaTraining });
    if (problem) return errorJson(403, "meta_models_only", { message: problem });
    return Response.json(await callDeviceTool(config, body.tool, args as Record<string, unknown>));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    return unavailable(err);
  }
});
