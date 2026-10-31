import { gatewayError } from "@/lib/gateway/errors";
import { clientIpKey, parseBearer } from "@/lib/gateway/extract";
import { SIM_AUDIO_WAV_BASE64, SIM_PHOTO_JPEG_BASE64 } from "@/lib/gateway/gadget-sim-media";
import type { GatewayToken } from "@/lib/gateway/handler";
import { CLIENT_IP_HEADER } from "@/lib/gateway/policy";
import type { ProductStatus } from "@/lib/types";

/**
 * Gadgets for products (docs/GADGETS.md): GET {GATEWAY_URL}/gadget lists the tools a product may use, and POST
 * {tool, arguments} calls one. A product may call it only when its brief picked `muse-gadget`, which puts that id in
 * its tokens' allowedModels the way a model's id is there.
 *
 * Build tokens always get the simulated gadget: a sandbox never reaches real hardware, and tests see the same photo
 * and recording every time. Live tokens reach the board the platform has connected (DEVICE_MCP_URL, through
 * lib/device/client.ts), or get 503 gadget_offline. Only the tools in PRODUCT_GADGET_TOOLS are served: never a shell.
 */

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
  findToken(token: string): Promise<GatewayToken | null>;
  productStatus(productId: string): Promise<ProductStatus | null>;
  hitRateLimits(keys: string[], windowStart: Date): Promise<Record<string, number>>;
  /** The board live products reach, or null when none is connected. */
  board(): GadgetBoard | null;
  now?(): Date;
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
];

/** The board builds use: fixed media, so a product's tests pass or fail the same way every run. */
export const SIMULATED_BOARD: GadgetBoard = {
  async listTools() {
    return SIM_TOOLS;
  },
  async callTool(name) {
    switch (name) {
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

const isProductTool = (name: string): name is ProductGadgetTool => (PRODUCT_GADGET_TOOLS as readonly string[]).includes(name);

async function authorize(req: Request, deps: GadgetDeps): Promise<GatewayToken | Response> {
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

async function rateLimited(req: Request, token: GatewayToken, deps: GadgetDeps): Promise<Response | null> {
  const now = deps.now?.() ?? new Date();
  const windowStart = new Date(Math.floor(now.getTime() / GADGET_LIMITS.windowMs) * GADGET_LIMITS.windowMs);
  const limits: Record<string, number> = { [`gadget:token:${token.id}`]: GADGET_LIMITS.perTokenPerMinute };
  const ip = clientIpKey(req.headers.get(CLIENT_IP_HEADER));
  if (ip) limits[`gadget:ip:${token.productId}:${ip}`] = GADGET_LIMITS.perIpPerMinute;
  const counts = await deps.hitRateLimits(Object.keys(limits), windowStart);
  const over = Object.entries(limits).find(([key, limit]) => (counts[key] ?? 0) > limit);
  if (!over) return null;
  const retryAfter = Math.max(1, Math.ceil((windowStart.getTime() + GADGET_LIMITS.windowMs - now.getTime()) / 1000));
  return gatewayError(429, "rate_limit_error", "rate_limited", `Too many gadget calls: the limit is ${over[1]} a minute. Try again in ${retryAfter} s.`, {
    headers: { "retry-after": String(retryAfter) },
  });
}

/** The board this token reaches: the simulator for builds, the connected board for live products. */
function boardFor(token: GatewayToken, deps: GadgetDeps): GadgetBoard | Response {
  if (token.scope === "build") return SIMULATED_BOARD;
  const board = deps.board();
  if (board) return board;
  return gatewayError(503, "server_error", "gadget_offline", "No gadget is connected to this product right now. Connect one in Muse Muse, then try again.", {
    retry: false,
  });
}

/** A product gets from describe_device what a build's simulator tells it. A board's hostname, OS and USB list say where it sits. */
function forProduct(tool: ProductGadgetTool, result: GadgetResult): GadgetResult {
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
  const board = boardFor(token, deps);
  if (board instanceof Response) return board;
  try {
    const tools = (await board.listTools()).filter((t) => isProductTool(t.name));
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
  if (typeof body?.tool !== "string" || !isProductTool(body.tool)) {
    return gatewayError(400, "invalid_request_error", "unknown_tool", `Name one of the gadget's tools: ${PRODUCT_GADGET_TOOLS.join(", ")}.`, { retry: false });
  }
  const args = body.arguments ?? {};
  if (typeof args !== "object" || Array.isArray(args) || args === null) {
    return gatewayError(400, "invalid_request_error", "invalid_arguments", "arguments must be an object.", { retry: false });
  }
  const limited = await rateLimited(req, token, deps);
  if (limited) return limited;
  const board = boardFor(token, deps);
  if (board instanceof Response) return board;
  try {
    const result = await board.callTool(body.tool, args as Record<string, unknown>);
    const simulated = board === SIMULATED_BOARD;
    return Response.json({ ...(simulated ? result : forProduct(body.tool, result)), simulated });
  } catch (err) {
    return offline(err);
  }
}
