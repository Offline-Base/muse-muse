import { gatewayError } from "@/lib/gateway/errors";
import { clientIpKey, parseBearer } from "@/lib/gateway/extract";
import { SIM_AUDIO_WAV_BASE64, SIM_PHOTO_JPEG_BASE64 } from "@/lib/gateway/gadget-sim-media";
import type { GatewayToken } from "@/lib/gateway/handler";
import { CLIENT_IP_HEADER } from "@/lib/gateway/policy";
import { CONNECT_TOOLS, BOARD_TOOLS, BOARD_TOOLS_MARKER, DRIVE_TOOLS_MARKER, hardwareProofKey, PRODUCT_DRIVE_TOOLS, SENSOR_NAME_MAX_CHARS, SHOW_TEXT_MAX_CHARS, SHOW_TEXT_PER_MINUTE, type BoardTool, type ConnectTool, type ProductDriveTool } from "@/lib/caps/hardware/limits";
import { liveAsk, liveHardStop, liveRobotRequest, liveRobotStatus, offlineAnswer, simulatedCall } from "@/lib/gateway/gadget-connect";
import { capMarker } from "@/lib/caps/ids";
import { ownerSubject, resolvePrincipal } from "@/lib/tools/principal";
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
 * its product's owner linked, and only with an owner pass naming that owner unless the link opens it to visitors. Anything
 * else gets 503 gadget_offline, and DEVICE_MCP_URL's board isn't read at all. With HARDWARE_BOARD_TOOLS, a token whose brief
 * asks for board tools gets read_sensor and show_text, and nothing else unless the brief also picked muse-gadget. Board tools
 * never reach DEVICE_MCP_URL's board: a live token with the owner check off doesn't get them.
 *
 * Drive tools (docs/DRIVE_EXPORT.md, "From a product"). With DRIVE_EXPORT_PRODUCTS and the owner check, a token whose brief asks
 * gets drive_status and export_to_drive, for the verified owner on the linked board only: a link open to visitors changes nothing
 * here. This file decides who gets through. What happens then is lib/device/drive-product.ts.
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
  /** GADGET_CONNECT: one answer from the model running on this board. */
  ask?(request: BoardAsk): Promise<BoardAnswer>;
}

export interface BoardAsk {
  model: string;
  messages: Array<{ role: string; content: string }>;
  maxTokens: number;
}

export type BoardAnswer = { kind: "answer"; text: string } | { kind: "no_model" };

/** Set while GADGET_CONNECT is on. */
export interface GadgetConnect {
  siteUrl: string;
  setStopped(boardId: string): Promise<void>;
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
  /** Set only while DRIVE_EXPORT_PRODUCTS and the owner check are both on. */
  drive?: GadgetDrive;
  /** Set only while GADGET_CONNECT, the owner check and board tools are all on. */
  connect?: GadgetConnect;
}

/** One drive tool call that has passed the checks here: from a build, which gets the simulator, or from the board's verified owner. */
export type GadgetDriveCall = {
  tool: ProductDriveTool;
  /** export_to_drive's argument, its shape already checked: "own" or a training job's id. */
  model: string | null;
  /** The id from a confirmation card. */
  approval: string | null;
  productId: string;
} & ({ kind: "build"; buildId: string | null; tokenId: string } | { kind: "owner"; subject: string; open(): Promise<GadgetBoard | null> });

export interface GadgetDrive {
  call(call: GadgetDriveCall): Promise<Response>;
}

/**
 * The link a product's owner made. Nothing secret is opened until `open`, which is called only for someone the link lets in,
 * so a refused caller costs a row read whether or not there's a link.
 */
export interface LinkedBoard {
  /** The board's owner, who is the product's owner: an owner pass must name them. */
  ownerUserId: string;
  visitors: boolean;
  /** The board, or null when it can't be reached safely right now. */
  open(): Promise<GadgetBoard | null>;
  boardId?: string;
  /** What pairing learned. Null for a board added by hand. */
  facts?: { target: string; targetLabel: string; simulated: boolean; robot: boolean; stopped: boolean } | null;
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

/** GADGET_CONNECT's tools, as GET lists them for a product with board tools. */
const CONNECT_TOOL_INFO: GadgetToolInfo[] = [
  {
    name: "ask_board",
    description: "One answer from the model running on the owner's board. Which model depends on the board.",
    inputSchema: { type: "object", properties: { messages: { type: "array" }, max_tokens: { type: "integer", minimum: 1, maximum: 512 } }, required: ["messages"], additionalProperties: false },
  },
  { name: "robot_status", description: "A simulated board's sensors, actuators and hard stop. Read only.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  {
    name: "robot_action",
    description: "Asks to do one allow-listed action on a simulated board. The owner confirms each one.",
    inputSchema: { type: "object", properties: { action: { type: "string" }, args: { type: "object" } }, required: ["action", "args"], additionalProperties: false },
  },
  { name: "hard_stop", description: "Stops everything on a simulated board, and it stays stopped until the owner clears it. Needs no confirmation.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
];

/** What GET lists for the drive tools: a board's own drive_status takes the same no arguments but answers more than a product sees. */
const DRIVE_TOOL_INFO: GadgetToolInfo[] = [
  {
    name: "drive_status",
    description: "The drive in the owner's board and how the export is going. Read only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "export_to_drive",
    description: "Puts this product's own tuned model on the drive plugged into the owner's board. The owner confirms each export on a card. It never erases a drive.",
    inputSchema: {
      type: "object",
      properties: { model: { type: "string", description: 'This product\'s own model: "own".' } },
      required: ["model"],
      additionalProperties: false,
    },
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

/** The brief asked for board tools, its manifest left the cap in, and they're switched on. */
const asksForBoardTools = (token: GadgetToken, deps: GadgetDeps): boolean => Boolean(deps.boardTools) && token.allowedModels.includes(BOARD_TOOLS_MARKER) && token.allowedModels.includes(capMarker("hardware"));

/** The brief asked for the drive tools, its manifest left the cap in, and both switches are on. Never without the owner check. */
const asksForDriveTools = (token: GadgetToken, deps: GadgetDeps): boolean => Boolean(deps.drive && deps.linkedBoard) && token.allowedModels.includes(DRIVE_TOOLS_MARKER) && token.allowedModels.includes(capMarker("hardware"));

/**
 * The tools this token may call: the three a brief gets by picking muse-gadget, and the board tools for a brief that asked
 * for those. A live token gets board tools only with the owner check on, so they never reach DEVICE_MCP_URL's board. The drive
 * tools are added last, for a brief that asked. Who may actually use them is decided for each call (driveCall).
 */
function toolsFor(token: GadgetToken, deps: GadgetDeps): readonly string[] {
  const media = token.allowedModels.includes(GADGET_ID) ? PRODUCT_GADGET_TOOLS : [];
  const tools = asksForBoardTools(token, deps) && (token.scope === "build" || deps.linkedBoard) ? [...media, ...BOARD_TOOLS] : media;
  const withDrive = asksForDriveTools(token, deps) ? [...tools, ...PRODUCT_DRIVE_TOOLS] : tools;
  return connectOn(token, deps) ? [...withDrive, ...CONNECT_TOOLS] : withDrive;
}

/** GADGET_CONNECT's tools go with board tools, for the same briefs. A live token also needs the owner check, which connect requires. */
const connectOn = (token: GadgetToken, deps: GadgetDeps): boolean => Boolean(deps.connect) && asksForBoardTools(token, deps);
const isConnectTool = (name: string): name is ConnectTool => (CONNECT_TOOLS as readonly string[]).includes(name);

/**
 * A GADGET_CONNECT call, in the owner check's order. Builds get the simulator. Live: a hard stop passes with no budget for anyone the
 * link lets in, since stopping is always allowed. robot_action needs the owner themselves, even with visitors open. Refused callers
 * get the same offline answer as no link at all.
 */
async function connectCall(req: Request, token: GadgetToken, tool: ConnectTool, args: Record<string, unknown>, approval: unknown, deps: GadgetDeps): Promise<Response> {
  const now = deps.now?.() ?? new Date();
  if (token.scope === "build") {
    if (tool !== "hard_stop") {
      const limited = await rateLimited(req, token, deps, tool);
      if (limited) return limited;
    }
    return simulatedCall({
      tool,
      args,
      approval,
      tokenId: token.id,
      productId: token.productId,
      now,
      // The window is the approval's expiry, so every try counts on one row.
      spend: async (nonce, exp) => ((await deps.hitRateLimits([`tool-approval:${nonce}`], exp))[`tool-approval:${nonce}`] ?? 1) <= 1,
    });
  }
  if (tool !== "hard_stop") {
    const limitedIp = await rateLimited(req, token, deps, tool, "ip");
    if (limitedIp) return limitedIp;
  }
  const link = await deps.linkedBoard!(token.productId);
  const owner = Boolean(link) && isOwnerCall(req, token, link!.ownerUserId, now);
  if (!link || !(link.visitors || owner) || (tool === "robot_action" && !owner)) return offlineAnswer();
  if (tool === "hard_stop") return liveHardStop(link, deps.connect!.setStopped);
  const limited = await rateLimited(req, token, deps, tool, "granted");
  if (limited) return limited;
  if (tool === "ask_board") return liveAsk(args, link);
  if (tool === "robot_status") return liveRobotStatus(link);
  return liveRobotRequest(args, link, token.productId, deps.connect!.siteUrl, now);
}

const isBoardTool = (name: string): name is BoardTool => (BOARD_TOOLS as readonly string[]).includes(name);
const isDriveTool = (name: string): name is ProductDriveTool => (PRODUCT_DRIVE_TOOLS as readonly string[]).includes(name);
/** "own", or the id of a training job. Never a link, a board run, a lab source or a path. */
const DRIVE_MODEL = /^(own|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
/** Line and paragraph separators, bidi and other format controls, and half of a surrogate pair. ZWNJ and ZWJ stay: emoji and several scripts need them. */
const NOT_PLAIN = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]|(?![\u200c\u200d])\p{Cf}/u;

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
  return NOT_PLAIN.test(text) ? "text must be one plain line." : null;
}

/** A drive tool's arguments: only known keys, so no plan, link or drive can be handed in. */
function driveToolProblem(tool: ProductDriveTool, args: Record<string, unknown>): string | null {
  const keys = Object.keys(args);
  if (tool === "drive_status") return keys.length ? "drive_status takes no arguments." : null;
  if (keys.some((k) => k !== "model")) return "export_to_drive takes only model.";
  return typeof args.model === "string" && DRIVE_MODEL.test(args.model) ? null : 'model must be "own", this product\'s own tuned model.';
}

async function authorize(req: Request, deps: GadgetDeps): Promise<GadgetToken | Response> {
  const bearer = parseBearer(req.headers.get("authorization"));
  const token = bearer ? await deps.findToken(bearer) : null;
  if (!token) return gatewayError(401, "authentication_error", "invalid_token", "Send the product's token as \"Authorization: Bearer <PRODUCT_TOKEN>\".", { retry: false });
  const status = await deps.productStatus(token.productId);
  if (!status || status === "disabled" || status === "failed") {
    return gatewayError(403, "permission_error", "product_disabled", "This product is turned off on Muse Muse.", { retry: false });
  }
  if (!token.allowedModels.includes(GADGET_ID) && !asksForBoardTools(token, deps) && !asksForDriveTools(token, deps)) {
    return gatewayError(403, "permission_error", "gadget_not_allowed", "This product's brief doesn't use a gadget, so it can't call one.", { retry: false });
  }
  return token;
}

/** `ip` counts the caller's address, `granted` the budgets a call uses up once it's let in, and with no owner check, all of them at once. */
async function rateLimited(req: Request, token: GadgetToken, deps: GadgetDeps, tool?: string, part: "all" | "ip" | "granted" = "all"): Promise<Response | null> {
  const now = deps.now?.() ?? new Date();
  const windowStart = new Date(Math.floor(now.getTime() / GADGET_LIMITS.windowMs) * GADGET_LIMITS.windowMs);
  const limits: Record<string, number> = part === "ip" ? {} : { [`gadget:token:${token.id}`]: GADGET_LIMITS.perTokenPerMinute };
  const ip = part === "granted" ? null : clientIpKey(req.headers.get(CLIENT_IP_HEADER));
  if (ip) limits[`gadget:ip:${token.productId}:${ip}`] = GADGET_LIMITS.perIpPerMinute;
  if (part !== "ip" && tool === "show_text") limits[`gadget:show:${token.productId}`] = SHOW_TEXT_PER_MINUTE;
  if (!Object.keys(limits).length) return null;
  const counts = await deps.hitRateLimits(Object.keys(limits), windowStart);
  const over = Object.entries(limits).find(([key, limit]) => (counts[key] ?? 0) > limit);
  if (!over) return null;
  const retryAfter = Math.max(1, Math.ceil((windowStart.getTime() + GADGET_LIMITS.windowMs - now.getTime()) / 1000));
  return gatewayError(429, "rate_limit_error", "rate_limited", `Too many gadget calls: the limit is ${over[1]} a minute. Try again in ${retryAfter} s.`, {
    headers: { "retry-after": String(retryAfter) },
  });
}

/** A verified owner pass for this product that names this person. A cookie alone, a pass that doesn't verify, or an admin's own pass is nobody. */
function isOwnerCall(req: Request, token: GadgetToken, ownerUserId: string, now: Date): boolean {
  try {
    const principal = resolvePrincipal(req, token, now);
    return principal.kind === "owner" && principal.subject === ownerSubject(ownerUserId);
  } catch {
    return false;
  }
}

/** The same answer whatever the reason, so a caller can't tell a link from no link. */
export const noBoard = (): Response =>
  gatewayError(503, "server_error", "gadget_offline", "No gadget is connected to this product right now. Connect one in Muse Muse, then try again.", {
    retry: false,
  });

/** Wave 3, unit 13: the owner check. The link, if this caller may use it. */
async function grantedLink(req: Request, token: GadgetToken, deps: GadgetDeps): Promise<LinkedBoard | null> {
  const link = await deps.linkedBoard!(token.productId);
  return link && (link.visitors || isOwnerCall(req, token, link.ownerUserId, deps.now?.() ?? new Date())) ? link : null;
}

/** The board this token reaches: the simulator for builds, the connected board for live products. */
async function boardFor(req: Request, token: GadgetToken, deps: GadgetDeps): Promise<GadgetBoard | Response> {
  if (token.scope === "build") return SIMULATED_BOARD;
  const board = deps.linkedBoard ? ((await (await grantedLink(req, token, deps))?.open()) ?? null) : deps.board();
  return board ?? noBoard();
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

/** The drive tools this caller sees on GET: a build, or the linked board's verified owner. Nobody else, even with visitors open. */
async function listedDriveTools(req: Request, token: GadgetToken, allowed: readonly string[], deps: GadgetDeps): Promise<GadgetToolInfo[]> {
  if (!allowed.some(isDriveTool)) return [];
  if (token.scope === "build") return DRIVE_TOOL_INFO;
  const link = await deps.linkedBoard!(token.productId);
  return link && isOwnerCall(req, token, link.ownerUserId, deps.now?.() ?? new Date()) ? DRIVE_TOOL_INFO : [];
}

/**
 * A drive tool, checked in the owner check's order: the address's limit, the row read and the principal, then the token's budget.
 * Only the owner: no `visitors`, so a link opened to visitors opens nothing here, and every refusal is the same 503 as no link at all.
 * The board's secrets open only inside the call, for that owner.
 */
async function driveCall(req: Request, token: GadgetToken, tool: ProductDriveTool, args: Record<string, unknown>, approval: unknown, deps: GadgetDeps): Promise<Response> {
  const problem = driveToolProblem(tool, args);
  if (problem) return gatewayError(400, "invalid_request_error", "invalid_arguments", problem, { retry: false });
  if (approval !== undefined && approval !== null && typeof approval !== "string") return gatewayError(400, "invalid_request_error", "invalid_arguments", "approval must be the id from the confirmation.", { retry: false });
  const common = { tool, model: tool === "export_to_drive" ? (args.model as string) : null, approval: typeof approval === "string" ? approval : null, productId: token.productId };
  try {
    if (token.scope === "build") {
      const limited = await rateLimited(req, token, deps, tool);
      if (limited) return limited;
      return await deps.drive!.call({ ...common, kind: "build", buildId: token.buildId ?? null, tokenId: token.id });
    }
    const limitedIp = await rateLimited(req, token, deps, tool, "ip");
    if (limitedIp) return limitedIp;
    const link = await deps.linkedBoard!(token.productId);
    if (!link || !isOwnerCall(req, token, link.ownerUserId, deps.now?.() ?? new Date())) return noBoard();
    const limited = await rateLimited(req, token, deps, tool, "granted");
    if (limited) return limited;
    return await deps.drive!.call({ ...common, kind: "owner", subject: ownerSubject(link.ownerUserId), open: () => link.open() });
  } catch {
    // No message: a board's client errors can carry its address.
    console.error("[gadget] a drive tool failed");
    return gatewayError(502, "server_error", "gadget_unavailable", "The gadget didn't answer. Check that it's on and connected, then try again.");
  }
}

/** GET: the tools this product may call, with whether they're simulated. */
export async function handleGadgetTools(req: Request, deps: GadgetDeps): Promise<Response> {
  const token = await authorize(req, deps);
  if (token instanceof Response) return token;
  const allowed = toolsFor(token, deps);
  if (!allowed.length) return noBoard();
  const driveTools = [...(await listedDriveTools(req, token, allowed, deps)), ...(connectOn(token, deps) ? CONNECT_TOOL_INFO : [])];
  const onBoard = allowed.filter((t) => !isDriveTool(t) && !isConnectTool(t));
  if (!onBoard.length) return driveTools.length ? Response.json({ tools: driveTools, simulated: token.scope === "build" }) : noBoard();
  const board = await boardFor(req, token, deps);
  if (board instanceof Response) return board;
  try {
    const tools = [...(await board.listTools()).filter((t) => onBoard.includes(t.name)), ...driveTools];
    return Response.json({ tools, simulated: board === SIMULATED_BOARD });
  } catch (err) {
    return offline(err);
  }
}

/** POST {tool, arguments?}: one call on the board. */
export async function handleGadgetCall(req: Request, deps: GadgetDeps): Promise<Response> {
  const token = await authorize(req, deps);
  if (token instanceof Response) return token;
  const allowed = toolsFor(token, deps);
  if (!allowed.length) return noBoard();
  let body: { tool?: unknown; arguments?: unknown; approval?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return gatewayError(400, "invalid_request_error", "invalid_body", "The request body is not valid JSON.");
  }
  if (typeof body?.tool !== "string" || !allowed.includes(body.tool)) {
    return gatewayError(400, "invalid_request_error", "unknown_tool", `Name one of the gadget's tools: ${allowed.join(", ")}.`, { retry: false });
  }
  const args = body.arguments ?? {};
  if (typeof args !== "object" || Array.isArray(args) || args === null) {
    return gatewayError(400, "invalid_request_error", "invalid_arguments", "arguments must be an object.", { retry: false });
  }
  const tool = body.tool;
  if (isDriveTool(tool)) return driveCall(req, token, tool, args as Record<string, unknown>, body.approval, deps);
  if (isConnectTool(tool)) return connectCall(req, token, tool, args as Record<string, unknown>, body.approval, deps);
  if (isBoardTool(tool)) {
    const problem = boardToolProblem(tool, args as Record<string, unknown>);
    if (problem) return gatewayError(400, "invalid_request_error", "invalid_arguments", problem, { retry: false });
  }
  let board: GadgetBoard | Response;
  if (token.scope !== "build" && deps.linkedBoard) {
    // The owner check: someone refused uses up only their own address's limit, never the owner's budgets.
    const limitedIp = await rateLimited(req, token, deps, tool, "ip");
    if (limitedIp) return limitedIp;
    const link = await grantedLink(req, token, deps);
    if (!link) return noBoard();
    const limited = await rateLimited(req, token, deps, tool, "granted");
    if (limited) return limited;
    board = (await link.open()) ?? noBoard();
  } else {
    const limited = await rateLimited(req, token, deps, tool);
    if (limited) return limited;
    board = await boardFor(req, token, deps);
  }
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
