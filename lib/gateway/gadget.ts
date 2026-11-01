import { gatewayError } from "@/lib/gateway/errors";
import { clientIpKey, parseBearer } from "@/lib/gateway/extract";
import { SIM_AUDIO_WAV_BASE64, SIM_PHOTO_JPEG_BASE64 } from "@/lib/gateway/gadget-sim-media";
import type { GatewayToken } from "@/lib/gateway/handler";
import { CLIENT_IP_HEADER } from "@/lib/gateway/policy";
import { BOARD_TOOLS, hardwareProofKey, SENSOR_NAME_MAX_CHARS, SHOW_TEXT_MAX_CHARS, SHOW_TEXT_PER_MINUTE, type BoardTool } from "@/lib/caps/hardware/limits";
import { capMarker } from "@/lib/caps/ids";
import { resolvePrincipal } from "@/lib/tools/principal";
import type { ProductStatus } from "@/lib/types";

/**
 * Gadgets for products (docs/GADGETS.md): GET {GATEWAY_URL}/gadget lists the tools a product may use, and POST
 * {tool, arguments} calls one. A product may call it only when its brief picked `muse-gadget`, which puts that id in
 * its tokens' allowedModels the way a model's id is there.
 *
 * Build tokens always get the simulated gadget: a sandbox never reaches real hardware, and tests see the same photo
 * and recording every time. Live tokens reach the board the platform has connected (DEVICE_MCP_URL, through
 * lib/device/client.ts), or get 503 gadget_offline. Only the tools in PRODUCT_GADGET_TOOLS are served: never a shell.
 *
 * Wave 3, unit 13 (docs/CAPABILITIES.md, section 19). With HARDWARE_GADGET_OWNER_CHECK, a live token reaches only the board
 * its product's owner linked, and only with a verified owner pass unless the link opens it to visitors. Anything else gets
 * 503 gadget_offline, and DEVICE_MCP_URL's board isn't read at all. With HARDWARE_BOARD_TOOLS, a token whose brief asks for
 * the hardware cap also gets read_sensor and show_text.
 */

/** findToken's row has the build's id, for the hardware proof. */
type GadgetToken = GatewayToken & { buildId?: string | null };

/** The permission id, in the brief's capabilities and in a token's allowedModels. */
export const GADGET_ID = "muse-gadget";

/** Tools a product may call on a board. A board's other tools (run_command) stay with admins. */
export const PRODUCT_GADGET_TOOLS = ["describe_device", "capture_image", "record_audio"] as const;
export type ProductGadgetTool = (typeof PRODUCT_GADGET_TOOLS)[number];

export const GADGET_LIMITS = {
  perTokenPerMinute: 30,
  perIpPerMinute: 10,
  windowMs: 60_000,
} as const;

export interface GadgetToolInfo {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface GadgetResult {
  content: unknown[];
  isError: boolean;
}

export interface GadgetBoard {
  listTools(): Promise<GadgetToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<GadgetResult>;
}

export interface GadgetDeps {
  findToken(token: string): Promise<GadgetToken | null>;
  productStatus(productId: string): Promise<ProductStatus | null>;
  hitRateLimits(keys: string[], windowStart: Date): Promise<Record<string, number>>;
  /** The board live products reach, or null when none is connected. */
  board(): GadgetBoard | null;
  now?(): Date;
  /** Wave 3, unit 13. Set while HARDWARE_GADGET_OWNER_CHECK is on: the owner check decides, and board() is never called. */
  linkedBoard?(productId: string): Promise<LinkedBoard | null>;
  /** Wave 3, unit 13. HARDWARE_BOARD_TOOLS. */
  boardTools?: boolean;
}

/** The board a product's owner linked, and whether the link lets visitors reach it. */
export interface LinkedBoard {
  board: GadgetBoard;
  visitors: boolean;
}

const DEVICE_PROP = { device: { type: "string", description: "Which camera or microphone, from describe_device. Defaults to the first." } };

/** The simulated board's tools: the same names and arguments as muse-device/server.py. */
const SIM_TOOLS: GadgetToolInfo[] = [
  {
    name: "describe_device",
    description: "Lists this board's hardware: cameras, microphones and buses.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "capture_image",
    description: "Takes one photo with the board's camera and returns it as a JPEG.",
    inputSchema: {
      type: "object",
      properties: { ...DEVICE_PROP, width: { type: "integer", minimum: 160, maximum: 1920, default: 1280 }, height: { type: "integer", minimum: 120, maximum: 1080, default: 720 } },
      additionalProperties: false,
    },
  },
  {
    name: "record_audio",
    description: "Records from the board's microphone and returns 16 kHz mono WAV plus its RMS and peak level.",
    inputSchema: {
      type: "object",
      properties: { ...DEVICE_PROP, seconds: { type: "integer", minimum: 1, maximum: 30, default: 3 } },
      additionalProperties: false,
    },
  },
  // Wave 3, unit 13: served only with HARDWARE_BOARD_TOOLS, to a token with the hardware cap (toolsFor).
  {
    name: "read_sensor",
    description: "Reads the board's sensors. Read only.",
    inputSchema: { type: "object", properties: { sensor: { type: "string", description: "One sensor's name. Defaults to all of them." } }, additionalProperties: false },
  },
  {
    name: "show_text",
    description: `Shows up to ${SHOW_TEXT_MAX_CHARS} characters on the board, ${SHOW_TEXT_PER_MINUTE} times a minute.`,
    inputSchema: { type: "object", properties: { text: { type: "string", minLength: 1, maxLength: SHOW_TEXT_MAX_CHARS } }, required: ["text"], additionalProperties: false },
  },
];

/** The simulated board's one sensor, steady so a product's tests pass or fail the same way every run. */
const SIM_SENSORS = [{ name: "board-temp", kind: "temperature", value: 41.5, unit: "C" }];

/** The board builds use: fixed media, so a product's tests pass or fail the same way every run. */
export const SIMULATED_BOARD: GadgetBoard = {
  async listTools() {
    return SIM_TOOLS;
  },
  async callTool(name, args) {
    switch (name) {
      case "read_sensor":
        return { isError: false, content: [{ type: "text", text: JSON.stringify({ simulated: true, sensors: SIM_SENSORS }) }] };
      case "show_text":
        return { isError: false, content: [{ type: "text", text: JSON.stringify({ simulated: true, shown: args.text }) }] };
      case "describe_device":
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                simulated: true,
                model: "Simulated Muse Muse gadget",
                cameras: [{ device: "/dev/video0", name: "Simulated camera" }],
                microphones: [{ device: "plughw:0,0", name: "Simulated microphone" }],
              }),
            },
          ],
        };
      case "capture_image":
        return { isError: false, content: [{ type: "image", data: SIM_PHOTO_JPEG_BASE64, mimeType: "image/jpeg" }] };
      case "record_audio":
        return {
          isError: false,
          content: [
            { type: "text", text: JSON.stringify({ seconds: 3, sample_rate: 16000, simulated: true }) },
            { type: "audio", data: SIM_AUDIO_WAV_BASE64, mimeType: "audio/wav" },
          ],
        };
      default:
        return { isError: true, content: [{ type: "text", text: `The simulated gadget has no tool "${name}".` }] };
    }
  },
};

/** The tools this token may call: the three every gadget product has, and the board tools for a hardware brief while they're on. */
function toolsFor(token: GadgetToken, deps: GadgetDeps): readonly string[] {
  return deps.boardTools && token.allowedModels.includes(capMarker("hardware")) ? [...PRODUCT_GADGET_TOOLS, ...BOARD_TOOLS] : PRODUCT_GADGET_TOOLS;
}

const isBoardTool = (name: string): name is BoardTool => (BOARD_TOOLS as readonly string[]).includes(name);
const CONTROL = /\p{Cc}/u;

/** A board tool's arguments are checked here as well as on the board: only known keys, and show_text's limit. */
function boardToolProblem(tool: BoardTool, args: Record<string, unknown>): string | null {
  const keys = Object.keys(args);
  if (tool === "read_sensor") {
    if (keys.some((k) => k !== "sensor")) return "read_sensor takes only sensor.";
    const sensor = args.sensor;
    if (sensor !== undefined && (typeof sensor !== "string" || !sensor || sensor.length > SENSOR_NAME_MAX_CHARS)) return `sensor must be a name of up to ${SENSOR_NAME_MAX_CHARS} characters.`;
    return null;
  }
  if (keys.some((k) => k !== "text")) return "show_text takes only text.";
  const text = args.text;
  if (typeof text !== "string" || !text.trim() || text.length > SHOW_TEXT_MAX_CHARS) return `text must be 1 to ${SHOW_TEXT_MAX_CHARS} characters.`;
  return CONTROL.test(text) ? "text must be one plain line." : null;
}

async function authorize(req: Request, deps: GadgetDeps): Promise<GadgetToken | Response> {
  const bearer = parseBearer(req.headers.get("authorization"));
  const token = bearer ? await deps.findToken(bearer) : null;
  if (!token) return gatewayError(401, "authentication_error", "invalid_token", "Send the product's token as \"Authorization: Bearer <PRODUCT_TOKEN>\".", { retry: false });
  const status = await deps.productStatus(token.productId);
  if (!status || status === "disabled" || status === "failed") {
    return gatewayError(403, "permission_error", "product_disabled", "This product is turned off on Muse Muse.", { retry: false });
  }
  if (!token.allowedModels.includes(GADGET_ID)) {
    return gatewayError(403, "permission_error", "gadget_not_allowed", "This product's brief doesn't use a gadget, so it can't call one.", { retry: false });
  }
  return token;
}

async function rateLimited(req: Request, token: GadgetToken, deps: GadgetDeps, tool?: string): Promise<Response | null> {
  const now = deps.now?.() ?? new Date();
  const windowStart = new Date(Math.floor(now.getTime() / GADGET_LIMITS.windowMs) * GADGET_LIMITS.windowMs);
  const limits: Record<string, number> = { [`gadget:token:${token.id}`]: GADGET_LIMITS.perTokenPerMinute };
  const ip = clientIpKey(req.headers.get(CLIENT_IP_HEADER));
  if (ip) limits[`gadget:ip:${token.productId}:${ip}`] = GADGET_LIMITS.perIpPerMinute;
  if (tool === "show_text") limits[`gadget:show:${token.productId}`] = SHOW_TEXT_PER_MINUTE;
  const counts = await deps.hitRateLimits(Object.keys(limits), windowStart);
  const over = Object.entries(limits).find(([key, limit]) => (counts[key] ?? 0) > limit);
  if (!over) return null;
  const retryAfter = Math.max(1, Math.ceil((windowStart.getTime() + GADGET_LIMITS.windowMs - now.getTime()) / 1000));
  return gatewayError(429, "rate_limit_error", "rate_limited", `Too many gadget calls: the limit is ${over[1]} a minute. Try again in ${retryAfter} s.`, {
    headers: { "retry-after": String(retryAfter) },
  });
}

/** A verified owner pass for this product. A cookie alone, or a pass that doesn't verify, is nobody. */
function isOwnerCall(req: Request, token: GadgetToken, now: Date): boolean {
  try {
    return resolvePrincipal(req, token, now).kind === "owner";
  } catch {
    return false;
  }
}

/** The board this token reaches: the simulator for builds, the connected board for live products. */
async function boardFor(req: Request, token: GadgetToken, deps: GadgetDeps): Promise<GadgetBoard | Response> {
  if (token.scope === "build") return SIMULATED_BOARD;
  // Wave 3, unit 13: the owner check. The same answer whatever the reason, so a caller can't tell a link from no link.
  let board: GadgetBoard | null;
  if (deps.linkedBoard) {
    const linked = await deps.linkedBoard(token.productId);
    board = linked && (linked.visitors || isOwnerCall(req, token, deps.now?.() ?? new Date())) ? linked.board : null;
  } else {
    board = deps.board();
  }
  if (board) return board;
  return gatewayError(503, "server_error", "gadget_offline", "No gadget is connected to this product right now. Connect one in Muse Muse, then try again.", {
    retry: false,
  });
}

/** A product gets from describe_device what a build's simulator tells it. A board's hostname, OS and USB list say where it sits. */
function forProduct(tool: string, result: GadgetResult): GadgetResult {
  if (tool !== "describe_device" || result.isError) return result;
  const content = (result.content as Array<{ type?: string; text?: string }>).map((part) => {
    if (part.type !== "text") return part;
    try {
      const { model, cameras, microphones } = JSON.parse(part.text ?? "{}") as Record<string, unknown>;
      return { type: "text", text: JSON.stringify({ model, cameras, microphones }) };
    } catch {
      return { type: "text", text: "{}" };
    }
  });
  return { ...result, content };
}

function offline(err: unknown): Response {
  console.error("[gadget]", err instanceof Error ? err.message : err);
  return gatewayError(502, "server_error", "gadget_unavailable", "The gadget didn't answer. Check that it's on and connected, then try again.");
}

/** GET: the tools this product may call, with whether they're simulated. */
export async function handleGadgetTools(req: Request, deps: GadgetDeps): Promise<Response> {
  const token = await authorize(req, deps);
  if (token instanceof Response) return token;
  const board = await boardFor(req, token, deps);
  if (board instanceof Response) return board;
  const allowed = toolsFor(token, deps);
  try {
    const tools = (await board.listTools()).filter((t) => allowed.includes(t.name));
    return Response.json({ tools, simulated: board === SIMULATED_BOARD });
  } catch (err) {
    return offline(err);
  }
}

/** POST {tool, arguments?}: one call on the board. */
export async function handleGadgetCall(req: Request, deps: GadgetDeps): Promise<Response> {
  const token = await authorize(req, deps);
  if (token instanceof Response) return token;
  let body: { tool?: unknown; arguments?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return gatewayError(400, "invalid_request_error", "invalid_body", "The request body is not valid JSON.");
  }
  const allowed = toolsFor(token, deps);
  if (typeof body?.tool !== "string" || !allowed.includes(body.tool)) {
    return gatewayError(400, "invalid_request_error", "unknown_tool", `Name one of the gadget's tools: ${allowed.join(", ")}.`, { retry: false });
  }
  const args = body.arguments ?? {};
  if (typeof args !== "object" || Array.isArray(args) || args === null) {
    return gatewayError(400, "invalid_request_error", "invalid_arguments", "arguments must be an object.", { retry: false });
  }
  const tool = body.tool;
  if (isBoardTool(tool)) {
    const problem = boardToolProblem(tool, args as Record<string, unknown>);
    if (problem) return gatewayError(400, "invalid_request_error", "invalid_arguments", problem, { retry: false });
  }
  const limited = await rateLimited(req, token, deps, tool);
  if (limited) return limited;
  const board = await boardFor(req, token, deps);
  if (board instanceof Response) return board;
  try {
    const result = await board.callTool(tool, args as Record<string, unknown>);
    const simulated = board === SIMULATED_BOARD;
    // Wave 3, unit 13: the gateway's own record of a board tool reaching the simulator, for verify (/caps/proof).
    if (simulated && isBoardTool(tool) && token.buildId) await deps.hitRateLimits([hardwareProofKey(tool, token.buildId)], deps.now?.() ?? new Date());
    return Response.json({ ...(simulated ? result : forProduct(tool, result)), simulated });
  } catch (err) {
    return offline(err);
  }
}
