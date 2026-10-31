import { requireAdminOrAutomation } from "@/lib/auth";
import { callDeviceTool, deviceConfig, listDeviceTools } from "@/lib/device/client";
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
 * camera and microphone. 503 device_not_configured, 502 device_unavailable.
 */
export const GET = route(async (req: Request) => {
  await requireAdminOrAutomation(req);
  const config = deviceConfig();
  if (!config) return errorJson(503, "device_not_configured");
  try {
    return Response.json({ tools: await listDeviceTools(config) });
  } catch (err) {
    return unavailable(err);
  }
});

/** POST {tool, arguments?} -> {content, isError}: one tool call on the board. Admins only, with the same errors as GET. */
export const POST = route(async (req: Request) => {
  await requireAdminOrAutomation(req);
  const config = deviceConfig();
  if (!config) return errorJson(503, "device_not_configured");
  const body = await readJson(req);
  if (typeof body.tool !== "string" || !body.tool) throw badRequest("Name a tool.");
  const args = body.arguments ?? {};
  if (typeof args !== "object" || Array.isArray(args)) throw badRequest("arguments must be an object.");
  try {
    return Response.json(await callDeviceTool(config, body.tool, args as Record<string, unknown>));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    return unavailable(err);
  }
});
