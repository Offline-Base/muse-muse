import { randomBytes } from "node:crypto";
import { type CapProduct, type CapToken, dayWindow } from "@/lib/caps/gate";
import { gatewayError } from "@/lib/gateway/errors";
import { clientIpKey, parseBearer } from "@/lib/gateway/extract";
import { CLIENT_IP_HEADER } from "@/lib/gateway/policy";
import { builderTier, tierMayUseBuilderCaps } from "@/lib/trust/tiers";
import type { ModelUsage } from "@/lib/types";
import type { UsageContext } from "@/lib/usage";

/**
 * POST {GATEWAY_URL}/fleet/v1/segment: Meta SAM 3.1 on an office Jetson, for a hosted product (docs/EDGE_PLAN.md, "Direction:
 * SAM 3.1 on the boards"). It takes the body the board's own `sam3` service takes (scripts/edge/sam3/server.py),
 * `{image_b64, prompt, threshold, overlay}`, and answers in that service's shape, so `segmentOrEdge` in a product
 * (template/lib/meta/edge.ts) reads it as the board. Behind FLEET_SAM, off by default.
 *
 * The board sits on the office network, so the photo goes the way scripts/edge/sam3/ui.py sends it: through the fleet control
 * plane's jobs API (BOARD_FLEET_URL and BOARD_FLEET_TOKEN, an admin's jpt_ token, since `exec` is admin only), in pieces of at
 * most 15,000 base64 characters (a command is at most 16,384), then one more job runs /opt/sam3/ask.py on the board, which
 * joins them, asks the service on the board and prints one `SAMRESULT {json}` line. Every command is built here from checked
 * parts: base64 characters, a random hex id, a number, and a prompt of letters, digits and plain punctuation in single quotes.
 * Nothing a caller sends reaches a shell any other way.
 *
 * Who may ask: a product's live token whose models include `sam-3.1`, made by an admin (or by any signed-in builder with
 * FLEET_ALL_PRODUCTS). A build's token gets 503 fleet_sam_build, so builds and drills never reach the board, and the product
 * treats that as the board being down. The photo is never logged or stored here, but the control plane's job history keeps
 * each piece, as the Nov 2 laptop run did.
 */

export const FLEET_SAM_ENDPOINT = "/fleet/v1/segment";
/** What the usage row names. $0: the board is ours. */
export const FLEET_SAM_USAGE_MODEL = "sam-3.1-board";
/** The model a product's token must already be allowed to use. */
export const FLEET_SAM_TOKEN_MODEL = "sam-3.1";

export const FLEET_SAM_LIMITS = {
  /** Each look is about 10 to 25 control-plane requests, and ngrok's free plan allows 20,000 a month across the fleet. */
  perProductPerDay: 40,
  allPerDay: 200,
  perIpPerMinute: 4,
  /** The board answers one look at a time (sam3.service holds a lock). */
  inFlightAll: 1,
  /** A 1024 px JPEG is about 100 to 250 KB, so about 140 to 340 K of base64: 10 to 23 pieces. */
  maxImageB64: 400_000,
  maxPrompt: 200,
  bodyBytes: 450_000,
} as const;

/** Base64 characters per piece: under the control plane's 16,384-character command limit with room for the rest. */
export const PIECE_CHARS = 15_000;
/** Under the route's maxDuration (120 s). The Nov 2 page took 10 to 20 s for a 640 px photo. */
export const FLEET_SAM_TIMEOUT_MS = 100_000;
const CALL_MS = 15_000;
const POLL_MS = 700;
const ASK_JOB_S = 90;
const PIECE_JOB_S = 30;

export interface FleetSamSettings {
  /** https, including /admin. */
  url: string;
  /** A jpt_ token: exec is admin only. */
  token: string;
  /** The board with sam3.service: its fleet id (nd_...) or name. */
  node: string;
}

/** Reads FLEET_SAM_NODE with BOARD_FLEET_URL and BOARD_FLEET_TOKEN. Null when any is missing or odd. */
export function fleetSamSettings(source: Record<string, string | undefined> = process.env): FleetSamSettings | null {
  const raw = source.BOARD_FLEET_URL?.trim().replace(/\/+$/, "") ?? "";
  const token = source.BOARD_FLEET_TOKEN?.trim() ?? "";
  const node = source.FLEET_SAM_NODE?.trim() ?? "";
  if (!URL.canParse(raw) || !/^jpt_\S+$/.test(token) || !/^[A-Za-z0-9._-]{1,64}$/.test(node)) return null;
  const { protocol, username, password, search, hash, pathname } = new URL(raw);
  if (protocol !== "https:" || username || password || search || hash || !pathname.endsWith("/admin")) return null;
  return { url: raw, token, node };
}

export interface FleetSamDeps {
  on(): boolean;
  allProducts(): boolean;
  settings(): FleetSamSettings | null;
  adminEmails: readonly string[];
  findToken(raw: string): Promise<CapToken | null>;
  product(productId: string): Promise<CapProduct | null>;
  hitRateLimits(keys: string[], windowStart: Date): Promise<Record<string, number>>;
  acquireInFlight(key: string, limit: number, now: Date): Promise<Date | null>;
  releaseInFlight(key: string, bucket: Date): Promise<void>;
  recordUsage(ctx: UsageContext, items: ModelUsage[]): Promise<void>;
  fetch: typeof fetch;
  now?(): Date;
  sleep?(ms: number): Promise<void>;
  /** A request id: 12 hex characters. */
  id?(): string;
}

export interface Look {
  b64: string;
  prompt: string;
  threshold: number;
  overlay: boolean;
}

const bad = (code: string, message: string) => gatewayError(400, "invalid_request_error", code, message, { retry: false });
/** Letters and digits in any script, spaces and a little punctuation: enough for "open door" or "red truck", and nothing a shell reads. */
const PROMPT_OK = /^[\p{L}\p{N} .,'-]+$/u;
const KNOWN_KEYS = new Set(["image_b64", "prompt", "threshold", "overlay"]);

async function readLook(req: Request): Promise<Look | Response> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    return bad("invalid_body", "The request body couldn't be read.");
  }
  if (Buffer.byteLength(text) > FLEET_SAM_LIMITS.bodyBytes) {
    return gatewayError(413, "invalid_request_error", "too_large", "Send a photo of 1024 px or less on its longest side.", { retry: false });
  }
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return bad("invalid_body", "The request body is not a JSON object.");
  }
  const unknown = Object.keys(body).find((k) => !KNOWN_KEYS.has(k));
  if (unknown) return bad("invalid_arguments", `This endpoint doesn't take "${unknown.slice(0, 40)}".`);
  const { image_b64: b64, prompt, threshold = 0.5, overlay = false } = body;
  if (typeof b64 !== "string" || !b64 || b64.length > FLEET_SAM_LIMITS.maxImageB64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    return bad("invalid_image", "image_b64 must be a JPEG or PNG in base64, under 400,000 characters.");
  }
  // A JPEG's base64 starts /9j/ and a PNG's iVBOR.
  if (!b64.startsWith("/9j/") && !b64.startsWith("iVBOR")) return bad("invalid_image", "image_b64 must be a JPEG or PNG.");
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > FLEET_SAM_LIMITS.maxPrompt || !PROMPT_OK.test(prompt)) {
    return bad("invalid_prompt", `prompt must be 1 to ${FLEET_SAM_LIMITS.maxPrompt} characters of letters, digits, spaces and . , ' -`);
  }
  if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) return bad("invalid_arguments", "threshold must be a number from 0 to 1.");
  if (typeof overlay !== "boolean") return bad("invalid_arguments", "overlay must be true or false.");
  return { b64, prompt, threshold, overlay };
}

/** One shell word in single quotes. Only checked prompts get here, but quoting stays right for any text. */
export const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/** The commands one look runs on the board, in order. Exported for the tests. */
export function lookCommands(look: Look, id: string): string[] {
  if (!/^[0-9a-f]{12}$/.test(id)) throw new Error("bad id");
  const dir = `/tmp/sam-ui/${id}`;
  const pieces: string[] = [];
  for (let i = 0; i < look.b64.length; i += PIECE_CHARS) pieces.push(look.b64.slice(i, i + PIECE_CHARS));
  const put = pieces.map((piece, n) => `mkdir -p ${dir} && printf %s '${piece}' > ${dir}/${String(n).padStart(3, "0")}`);
  // ask.py always asks the service for the tinted picture; it's dropped below unless the caller wanted it.
  return [...put, `python3 /opt/sam3/ask.py ${id} ${quote(look.prompt)} ${look.threshold.toFixed(3)}`];
}

class SamFailure extends Error {
  constructor(readonly code: "fleet_unavailable" | "board_error" | "timeout") {
    super(code);
  }
}

interface JobView {
  status?: string;
  output: string;
}

async function controlPlane(settings: FleetSamSettings, deps: FleetSamDeps, path: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
  let res: Response;
  try {
    res = await deps.fetch(`${settings.url}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${settings.token}`, "content-type": "application/json", "ngrok-skip-browser-warning": "1" },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.any([signal, AbortSignal.timeout(CALL_MS)]),
    });
  } catch (err) {
    if (signal.aborted) throw new SamFailure("timeout");
    throw err instanceof SamFailure ? err : new SamFailure("fleet_unavailable");
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new SamFailure("fleet_unavailable");
  }
  try {
    return await res.json();
  } catch {
    throw new SamFailure("fleet_unavailable");
  }
}

function jobView(raw: unknown): JobView {
  const job = (raw ?? {}) as { status?: unknown; tasks?: unknown; boards?: unknown };
  const tasks = Array.isArray(job.tasks) ? job.tasks : Array.isArray(job.boards) ? job.boards : [];
  const task = (tasks[0] ?? {}) as { output?: unknown; result?: { output?: unknown } | null };
  const output = typeof task.output === "string" && task.output ? task.output : typeof task.result?.output === "string" ? task.result.output : "";
  return { status: typeof job.status === "string" ? job.status : undefined, output };
}

/** Runs one command on the SAM board and waits for it. Throws unless it succeeded. */
async function runOnBoard(settings: FleetSamSettings, deps: FleetSamDeps, command: string, timeoutS: number, signal: AbortSignal): Promise<string> {
  const created = (await controlPlane(settings, deps, "/api/jobs", { method: "POST", body: JSON.stringify({ node_ids: [settings.node], action: "exec", params: { command }, timeout_s: timeoutS }) }, signal)) as {
    job_id?: unknown;
    id?: unknown;
  } | null;
  const id = typeof created?.job_id === "string" ? created.job_id : typeof created?.id === "string" ? created.id : null;
  if (!id || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new SamFailure("fleet_unavailable");
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (;;) {
    if (signal.aborted) throw new SamFailure("timeout");
    const view = jobView(await controlPlane(settings, deps, `/api/jobs/${id}`, { method: "GET" }, signal));
    if (view.status === "succeeded") return view.output;
    if (view.status && !["queued", "pending", "running", "dispatched"].includes(view.status)) throw new SamFailure("board_error");
    await sleep(POLL_MS);
  }
}

/** The board's answer, held to the service's shape: what segmentOrEdge checks again on its side. */
function boardReply(output: string, look: Look): Record<string, unknown> {
  const line = output.split("\n").find((l) => l.startsWith("SAMRESULT "));
  if (!line) throw new SamFailure("board_error");
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(line.slice("SAMRESULT ".length)) as Record<string, unknown>;
  } catch {
    throw new SamFailure("board_error");
  }
  if (!json || typeof json !== "object" || "error" in json || !Array.isArray(json.objects) || typeof json.count !== "number" || !Array.isArray(json.image_size)) {
    throw new SamFailure("board_error");
  }
  const reply: Record<string, unknown> = { prompt: json.prompt, count: json.count, objects: json.objects, ms: json.ms, image_size: json.image_size };
  if (look.overlay && typeof json.overlay_jpeg_b64 === "string") reply.overlay_jpeg_b64 = json.overlay_jpeg_b64;
  return reply;
}

/**
 * One look on the SAM board: the photo goes up in pieces, then ask.py answers. The reply in the service's shape. Throws
 * SamFailure. Callers hold the in-flight slot and check limits first. Shared with the e-ink rover view (lib/fleet/rover-view.ts).
 */
export async function samLook(settings: FleetSamSettings, deps: Pick<FleetSamDeps, "fetch" | "sleep" | "id">, look: Look, signal: AbortSignal): Promise<Record<string, unknown>> {
  const id = deps.id?.() ?? randomBytes(6).toString("hex");
  const commands = lookCommands(look, id);
  let output = "";
  for (const [n, command] of commands.entries()) output = await runOnBoard(settings, deps as FleetSamDeps, command, n === commands.length - 1 ? ASK_JOB_S : PIECE_JOB_S, signal);
  return boardReply(output, look);
}

async function overLimits(req: Request, token: CapToken, deps: FleetSamDeps, now: Date): Promise<Response | null> {
  const ip = clientIpKey(req.headers.get(CLIENT_IP_HEADER));
  if (ip) {
    const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    const key = `fleetsam:ip:${token.productId}:${ip}`;
    const counts = await deps.hitRateLimits([key], minute);
    if ((counts[key] ?? 0) > FLEET_SAM_LIMITS.perIpPerMinute) {
      return gatewayError(429, "rate_limit_error", "rate_limited", `Too many looks: the limit is ${FLEET_SAM_LIMITS.perIpPerMinute} a minute.`, { headers: { "retry-after": "60" } });
    }
  }
  const day = dayWindow(now);
  const productKey = `fleetsam:product:${token.productId}`;
  const allKey = "fleetsam:all";
  const counts = await deps.hitRateLimits([productKey, allKey], day);
  if ((counts[productKey] ?? 0) > FLEET_SAM_LIMITS.perProductPerDay || (counts[allKey] ?? 0) > FLEET_SAM_LIMITS.allPerDay) {
    const retry = Math.max(1, Math.ceil((day.getTime() - now.getTime()) / 1000));
    return gatewayError(429, "rate_limit_error", "rate_limited", "The office board has done all its looks for today.", { headers: { "retry-after": String(retry) }, retry: false });
  }
  return null;
}

function failure(err: unknown): Response {
  const code = err instanceof SamFailure ? err.code : "fleet_unavailable";
  // Only the code: never the photo, the prompt, the fleet's address or its words.
  console.error("[fleet-sam]", code);
  if (code === "timeout") return gatewayError(504, "server_error", "timeout", "The office board didn't look in time. Try again.", { retry: false });
  return gatewayError(502, "server_error", code, "The office board didn't answer. Try again in a moment.", { retry: false });
}

/**
 * Who may reach the office board: the checks every fleet SAM route makes on the caller's token and product, in order.
 * The token, or the gateway error to answer with. Shared with the board status route (lib/edge/fleet-status.ts).
 */
export async function fleetSamCaller(req: Request, deps: Pick<FleetSamDeps, "findToken" | "product" | "adminEmails" | "allProducts">): Promise<CapToken | Response> {
  const raw = parseBearer(req.headers.get("authorization"));
  const token = raw ? await deps.findToken(raw) : null;
  if (!token) return gatewayError(401, "authentication_error", "invalid_token", 'Send the product\'s token as "Authorization: Bearer <PRODUCT_TOKEN>".', { retry: false });
  const product = await deps.product(token.productId);
  if (!product || product.status === "disabled" || product.status === "failed" || product.takenDownAt || product.ownerBannedAt) {
    return gatewayError(403, "permission_error", "product_disabled", "This product is turned off on Muse Muse.", { retry: false });
  }
  if (!token.allowedModels.includes(FLEET_SAM_TOKEN_MODEL)) return gatewayError(403, "permission_error", "sam_not_allowed", "This product's brief doesn't use Meta SAM 3.1.", { retry: false });
  // Builds and their drills never reach the board: to the product this is the board being down.
  if (token.scope === "build") return gatewayError(503, "server_error", "fleet_sam_build", "Test builds don't reach the office board.", { retry: false });
  if (token.scope !== "live") return gatewayError(403, "permission_error", "cap_not_allowed", "Only a product's own token can use this.", { retry: false });
  const tier = builderTier({ email: product.ownerEmail, isAdmin: product.ownerIsAdmin && deps.adminEmails.includes(product.ownerEmail), bannedAt: product.ownerBannedAt });
  if (!tierMayUseBuilderCaps(tier)) return gatewayError(403, "permission_error", "sign_in_required", "The office board needs a product made by someone signed in to Muse Muse.", { retry: false });
  if (tier !== "admin" && !deps.allProducts()) return gatewayError(403, "permission_error", "sam_not_allowed", "The office board is open only to the platform's own products for now.", { retry: false });
  return token;
}

export async function handleFleetSegment(req: Request, deps: FleetSamDeps): Promise<Response> {
  if (!deps.on()) return gatewayError(404, "not_found_error", "unknown_endpoint", `The gateway does not serve ${FLEET_SAM_ENDPOINT}.`, { retry: false });
  if (req.method !== "POST") return gatewayError(405, "invalid_request_error", "method_not_allowed", `Use POST for ${FLEET_SAM_ENDPOINT}.`, { retry: false, headers: { allow: "POST" } });
  try {
    const token = await fleetSamCaller(req, deps);
    if (token instanceof Response) return token;

    const look = await readLook(req);
    if (look instanceof Response) return look;
    const settings = deps.settings();
    if (!settings) return gatewayError(503, "server_error", "fleet_closed", "The office board isn't open to products right now.", { retry: false });
    const now = deps.now?.() ?? new Date();
    const over = await overLimits(req, token, deps, now);
    if (over) return over;

    const slot = await deps.acquireInFlight("fleetsam:flight:all", FLEET_SAM_LIMITS.inFlightAll, now);
    if (!slot) return gatewayError(409, "rate_limit_error", "busy", "The office board is looking at another photo. Try again in a moment.", { headers: { "retry-after": "20" }, retry: false });
    try {
      const signal = AbortSignal.any([req.signal, AbortSignal.timeout(FLEET_SAM_TIMEOUT_MS)]);
      const reply = await samLook(settings, deps, look, signal);
      const ctx: UsageContext = { source: "fleet", endpoint: FLEET_SAM_ENDPOINT, productId: token.productId, tokenId: token.id, buildId: token.buildId };
      await deps
        .recordUsage(ctx, [{ model: FLEET_SAM_USAGE_MODEL, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, units: 1, costUsd: 0 }])
        .catch(() => console.error("[fleet-sam] metering failed"));
      return Response.json(reply, { headers: { "cache-control": "no-store" } });
    } finally {
      await deps.releaseInFlight("fleetsam:flight:all", slot).catch(() => undefined);
    }
  } catch (err) {
    return failure(err);
  }
}
