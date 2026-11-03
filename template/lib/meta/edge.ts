import { parseImageStream, ResponsesStreamAbortedError, ResponsesStreamError, ResponsesStreamRefusalError, ResponsesStreamSourceError, type SegmentationRecord } from "@meta-sam/parser";
import OpenAI from "openai";
import type { ChatCompletionContentPart, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { z } from "zod";
import { metaClient, testModelFor, type RequestLike } from "./client";
import { NO_EM_DASHES, parseJsonText, respondJson, type RespondJsonOptions, toStrictSchema } from "./json";
import { imagePart } from "./parts";
import { plainDeep } from "./text";

/**
 * A backup model on an edge board: any OpenAI-compatible chat server (llama.cpp's llama-server, Ollama, vLLM) the
 * product's server can reach, such as http://127.0.0.1:11435/v1 when the product and the model run on one board.
 * Null unless EDGE_URL is set. It never goes through the gateway, so it works with GATEWAY_URL unset.
 *
 *   EDGE_URL         the server's /v1 base URL
 *   EDGE_MODEL       the served model's name (default "edge")
 *   EDGE_API_KEY     only when the server asks for one
 *   EDGE_BOARD       the board's name for the label, like "jetson-02" (default "the edge board")
 *   EDGE_MODEL_NAME  the model's name for the label, like "Muse Glimmer one-bit (tuned)" (default EDGE_MODEL)
 *   EDGE_TIMEOUT_MS  the longest one edge answer may take (default 60000)
 *   EDGE_CLOUD_TIMEOUT_MS  the longest the cloud gets before the edge answers (default 10000)
 *   EDGE_FIRST=1     ask the edge model first and the cloud second
 */
export function edgeClient(): { client: OpenAI; model: string; board: string; modelName: string } | null {
  const baseURL = process.env.EDGE_URL?.trim().replace(/\/+$/, "");
  if (!baseURL) return null;
  const model = process.env.EDGE_MODEL?.trim() || "edge";
  // The SDK refuses an empty key, and keyless servers ignore whatever is sent.
  const client = new OpenAI({ baseURL, apiKey: process.env.EDGE_API_KEY || "none", timeout: edgeTimeoutMs(), maxRetries: 0 });
  return { client, model, board: process.env.EDGE_BOARD?.trim() || "the edge board", modelName: process.env.EDGE_MODEL_NAME?.trim() || model };
}

/**
 * How long the cloud gets before the edge model answers instead, unless EDGE_CLOUD_TIMEOUT_MS says otherwise. Short on
 * purpose: the gateway itself waits minutes.
 */
export const CLOUD_TIMEOUT_MS = 10_000;
const DEFAULT_EDGE_TIMEOUT_MS = 60_000;

function ms(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const edgeTimeoutMs = () => ms("EDGE_TIMEOUT_MS", DEFAULT_EDGE_TIMEOUT_MS);
const cloudTimeoutMs = () => ms("EDGE_CLOUD_TIMEOUT_MS", CLOUD_TIMEOUT_MS);

/** Why one side didn't answer. */
export type EdgeFailureKind =
  /** Not set up here: no GATEWAY_URL for the cloud, no EDGE_URL for the edge. */
  | "not_set"
  /** The connection was refused or dropped. */
  | "refused"
  /** No answer in time. */
  | "timeout"
  /** An HTTP error status. */
  | "http"
  /** The reply wasn't JSON. */
  | "garbage"
  /** JSON that didn't match the schema, even after one retry. A tampered reply lands here. */
  | "schema"
  /**
   * The cloud was reached but isn't set up for this call: a 404 model_not_found, which the gateway gives when the
   * product's token doesn't list the model. A setup error, not the cloud turning the request down, so the board answers.
   */
  | "setup"
  /** The cloud was reached and declined, inside a reply that had already started. Treated like a 4xx. */
  | "declined"
  /** Not asked: what the product passed in can't be sent (a photo that isn't a JPEG or PNG, an empty prompt). */
  | "input"
  /** Not asked: the cloud was reached and turned the request down, so the backup model isn't used to get around it. */
  | "skipped";

export interface EdgeFailureReason {
  kind: EdgeFailureKind;
  status?: number;
  detail: string;
}

export type EdgeAnswer<T> =
  | {
      ok: true;
      data: T;
      /** Who answered. */
      by: "cloud" | "edge";
      /** One fixed line to show next to the answer, never written by a model. */
      label: string;
      /** Why the side asked first didn't answer, when the second one did. */
      fellBack: EdgeFailureReason | null;
    }
  | {
      ok: false;
      by: null;
      /** A plain line the page can show as it is. */
      message: string;
      reasons: { cloud: EdgeFailureReason; edge: EdgeFailureReason };
    };

/** What a page shows when neither side answered. */
export const BOTH_DOWN_MESSAGE = "Neither the cloud model nor the backup model answered just now. Try again in a minute.";

/** What a page shows when the cloud was reached and turned the request down (a limit, a refusal, a stopped product). */
export const CLOUD_DECLINED_MESSAGE = "The cloud model turned this request down just now. Try again later, or change what you asked.";

/**
 * True when the cloud was reached and said no with a 4xx (a refused prompt, a visitor's or the product's limit, a token
 * that was turned off). The backup model is for a cloud that can't be reached, never a way around the cloud's own
 * answer, so the edge isn't asked. 408 is a timeout, so it still falls back. A 404 model_not_found is a setup error
 * (kind "setup", see reasonOf), not a 4xx here, so it falls back too.
 */
function cloudDeclined(reason: EdgeFailureReason): boolean {
  if (reason.kind === "declined") return true;
  return reason.kind === "http" && typeof reason.status === "number" && reason.status >= 400 && reason.status < 500 && reason.status !== 408;
}

const DISPLAY: Record<string, string> = {
  "muse-wonder-1.0": "Muse Wonder",
  "muse-spark-1.3-contributor": "Muse Spark 1.3 Contributor",
};

/** The cloud answer's label. A test build names the model it really ran on. */
export function cloudLabel(): string {
  const model = testModelFor("muse-wonder-1.0");
  return `Answered in the cloud, ${DISPLAY[model] ?? model}`;
}

/** The edge answer's label: "Answered on <board>, <model>". */
export function edgeLabel(edge: { board: string; modelName: string }): string {
  return `Answered on ${edge.board}, ${edge.modelName}`;
}

/** True when EDGE_FIRST asks for the edge model before the cloud. */
export function edgeFirst(): boolean {
  return ["1", "true", "yes", "on"].includes((process.env.EDGE_FIRST ?? "").trim().toLowerCase());
}

/**
 * Structured JSON from the cloud (respondJson through the gateway, at most CLOUD_TIMEOUT_MS), else from the edge model
 * (chat.completions with a json_schema response format, checked with zod). EDGE_FIRST=1 flips the order. Server only.
 *
 * It never throws for a model failure: read `ok`. When both fail it returns `message`, a plain line to show as it is.
 * A reply that doesn't match the schema is never returned, from either side, so a tampered edge reply is rejected.
 * The edge answers only when the cloud can't be reached (refused, timed out, a 5xx, not set) or its JSON didn't match.
 * When the cloud was reached and turned the request down (a 4xx), that is the answer: the edge isn't asked after it.
 */
export async function respondJsonOrEdge<T>(opts: RespondJsonOptions<T>): Promise<EdgeAnswer<T>> {
  const edge = edgeClient();
  const order: Array<"cloud" | "edge"> = edgeFirst() ? ["edge", "cloud"] : ["cloud", "edge"];
  const reasons: Partial<Record<"cloud" | "edge", EdgeFailureReason>> = {};
  for (const side of order) {
    try {
      if (side === "cloud") {
        const data = await askCloud(opts);
        return { ok: true, data, by: "cloud", label: cloudLabel(), fellBack: reasons.edge ?? null };
      }
      if (!edge) throw new SideFailure({ kind: "not_set", detail: "EDGE_URL is not set." });
      const data = await askEdge(opts, edge);
      return { ok: true, data, by: "edge", label: edgeLabel(edge), fellBack: reasons.cloud ?? null };
    } catch (err) {
      reasons[side] = reasonOf(err);
      if (side === "cloud" && cloudDeclined(reasons.cloud!)) {
        reasons.edge ??= { kind: "skipped", detail: "The cloud turned the request down, so the backup model was not asked." };
        return { ok: false, by: null, message: CLOUD_DECLINED_MESSAGE, reasons: { cloud: reasons.cloud!, edge: reasons.edge } };
      }
    }
  }
  return { ok: false, by: null, message: BOTH_DOWN_MESSAGE, reasons: { cloud: reasons.cloud!, edge: reasons.edge! } };
}

class SideFailure extends Error {
  constructor(readonly reason: EdgeFailureReason) {
    super(reason.detail);
    this.name = "SideFailure";
  }
}

async function askCloud<T>(opts: RespondJsonOptions<T>): Promise<T> {
  if (!process.env.GATEWAY_URL?.trim() || !process.env.PRODUCT_TOKEN?.trim()) {
    throw new SideFailure({ kind: "not_set", detail: "GATEWAY_URL or PRODUCT_TOKEN is not set." });
  }
  const timeout = cloudTimeoutMs();
  const client = (opts.client ?? metaClient(opts.request)).withOptions({ timeout, maxRetries: 0 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  // respondJson may make more than one call (a schema retry), so the whole cloud try is held to one deadline too.
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SideFailure({ kind: "timeout", detail: `The cloud took longer than ${timeout / 1000} s.` })), timeout);
  });
  try {
    return await Promise.race([respondJson({ ...opts, client }), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

type Json = Record<string, unknown>;

async function askEdge<T>(opts: RespondJsonOptions<T>, edge: NonNullable<ReturnType<typeof edgeClient>>): Promise<T> {
  const generated = z.toJSONSchema(opts.schema, { unrepresentable: "any", io: "output" }) as Json;
  delete generated.$schema;
  const wrapped = generated.type !== "object" && !(typeof generated.properties === "object" && generated.properties);
  const { $defs, ...inner } = generated;
  const plain: Json = wrapped
    ? { type: "object", properties: { value: inner }, required: ["value"], additionalProperties: false, ...($defs ? { $defs } : {}) }
    : generated;
  const strict = toStrictSchema(plain);
  const unwrap = (v: unknown) => (wrapped && v && typeof v === "object" && "value" in v ? (v as Json).value : v);

  const system = [opts.instructions, NO_EM_DASHES, "Reply with only one JSON object that matches this JSON Schema. No prose, no code fences.\n" + JSON.stringify(plain)]
    .filter(Boolean)
    .join("\n\n");
  const messages: ChatCompletionMessageParam[] = [{ role: "system", content: system }, ...toChatMessages(opts.input)];
  let last: EdgeFailureReason = { kind: "garbage", detail: "No reply." };

  for (let attempt = 0; attempt < 2; attempt++) {
    // No enable_thinking or other chat_template_kwargs: llama.cpp drops the schema when thinking is on.
    const res = await edge.client.chat.completions.create({
      model: edge.model,
      messages,
      temperature: 0,
      ...(opts.maxOutputTokens ? { max_tokens: opts.maxOutputTokens } : {}),
      response_format: {
        type: "json_schema",
        json_schema: { name: opts.schemaName, strict: strict.ok, schema: strict.ok ? strict.schema : plain },
      },
    });
    const raw = res.choices?.[0]?.message?.content ?? "";
    const parsed = parseJsonText(raw);
    if (parsed === undefined) {
      last = { kind: "garbage", detail: "The edge reply was not JSON." };
    } else {
      const result = opts.schema.safeParse(unwrap(strict.repair(parsed)));
      if (result.success) return plainDeep(result.data);
      last = { kind: "schema", detail: `The edge reply did not match "${opts.schemaName}": ${z.prettifyError(result.error)}` };
    }
    messages.push(
      { role: "assistant", content: raw || "(empty reply)" },
      { role: "user", content: `That reply did not match the JSON schema:\n${last.detail}\nReply again with only the corrected JSON.` },
    );
  }
  throw new SideFailure(last);
}

/** Responses API input (a string or message items) as chat messages. Text and images carry over; other parts are dropped. */
function toChatMessages(input: RespondJsonOptions<unknown>["input"]): ChatCompletionMessageParam[] {
  if (typeof input === "string") return [{ role: "user", content: input }];
  const out: ChatCompletionMessageParam[] = [];
  for (const item of input as Array<{ role?: string; content?: unknown }>) {
    if (!item || typeof item !== "object" || !item.role) continue;
    const role = item.role === "assistant" ? "assistant" : item.role === "system" || item.role === "developer" ? "system" : "user";
    if (typeof item.content === "string") {
      out.push({ role, content: item.content } as ChatCompletionMessageParam);
      continue;
    }
    const parts: ChatCompletionContentPart[] = [];
    for (const p of Array.isArray(item.content) ? (item.content as Array<Record<string, unknown>>) : []) {
      if ((p.type === "input_text" || p.type === "output_text") && typeof p.text === "string") parts.push({ type: "text", text: p.text });
      else if (p.type === "input_image" && typeof p.image_url === "string" && role === "user") parts.push({ type: "image_url", image_url: { url: p.image_url } });
    }
    if (!parts.length) continue;
    if (role === "user") out.push({ role, content: parts });
    else out.push({ role, content: parts.map((p) => (p.type === "text" ? p.text : "")).join("\n") } as ChatCompletionMessageParam);
  }
  return out;
}

/** True for the gateway's answer to a model this product's token doesn't list: 404 with code model_not_found. */
function isModelNotFound(err: InstanceType<typeof OpenAI.APIError>): boolean {
  const inner = (err.error as { code?: unknown; error?: { code?: unknown } } | undefined) ?? {};
  return err.status === 404 && [err.code, inner.code, inner.error?.code].includes("model_not_found");
}

function reasonOf(err: unknown): EdgeFailureReason {
  if (err instanceof SideFailure) return err.reason;
  if (err instanceof OpenAI.APIConnectionTimeoutError) return { kind: "timeout", detail: "No answer in time." };
  if (err instanceof OpenAI.APIConnectionError) return { kind: "refused", detail: "The connection was refused or dropped." };
  if (err instanceof OpenAI.APIError && typeof err.status === "number" && isModelNotFound(err)) {
    return { kind: "setup", status: 404, detail: "The cloud has no such model for this product (404 model_not_found): its token doesn't list the model. A setup error, not a refusal." };
  }
  if (err instanceof OpenAI.APIError && typeof err.status === "number") return { kind: "http", status: err.status, detail: `HTTP ${err.status}.` };
  if (err instanceof ResponsesStreamRefusalError) return { kind: "declined", detail: "The cloud declined to look at this photo." };
  if (err instanceof ResponsesStreamAbortedError) return { kind: "timeout", detail: "No answer in time." };
  if (err instanceof ResponsesStreamSourceError) return { kind: "refused", detail: "The cloud's reply was cut off." };
  if (err instanceof ResponsesStreamError) return { kind: "garbage", detail: `The cloud's reply couldn't be read (${err.code}).` };
  if (err instanceof Error && err.name === "RespondJsonError") return { kind: "schema", detail: err.message };
  if (err instanceof Error && /abort|timed? ?out/i.test(`${err.name} ${err.message}`)) return { kind: "timeout", detail: "No answer in time." };
  return { kind: "refused", detail: err instanceof Error ? err.message.slice(0, 200) : "Unknown error." };
}

// ---------- Meta SAM 3.1: the cloud first, then sam3.service on a board ----------

/** The gateway's SAM model. */
export const SAM_MODEL = "sam-3.1";
const SAM_NAME = "Meta SAM 3.1";

/** What a page shows when neither the cloud nor the board could look at the photo. */
export const SAM_DOWN_MESSAGE = "Can't see right now: neither the cloud nor the board could look at this photo. Try again in a minute.";
/** What a page shows for a photo that can't be sent: not a JPEG or PNG, or too big. Nothing was asked. */
export const SAM_BAD_PHOTO_MESSAGE = "That photo couldn't be read. Try a JPEG or PNG photo.";
/** What a page shows for an empty or overlong prompt. Nothing was asked. */
export const SAM_BAD_PROMPT_MESSAGE = 'Name one thing to look for, in a few words, like "open door".';

const DEFAULT_SAM_TIMEOUT_MS = 30_000;
/** The lowest confidence that counts unless the call says otherwise: sam3.service's own default. */
export const DEFAULT_SAM_THRESHOLD = 0.5;
/** sam3.service keeps at most this many characters of a prompt, so a longer one is refused before anything is asked. */
const MAX_SAM_PROMPT = 200;
/** About 6 MB of photo. The board takes 12 MB a request and a Vercel function 4.5 MB, so resize first anyway. */
const MAX_PHOTO_B64 = 8 * 1024 * 1024;
const MAX_BOARD_REPLY_CHARS = 8 * 1024 * 1024;

/**
 * Meta SAM 3.1 on a board: the `sam3` service (scripts/edge/sam3/server.py in the Muse Muse repo) at EDGE_SAM_URL, for
 * example http://127.0.0.1:8790 when the product runs on that board. Null unless EDGE_SAM_URL is an http or https URL.
 * It never goes through the gateway, so it works with GATEWAY_URL unset.
 *
 *   EDGE_SAM_URL         the service's base URL. /segment is added unless the URL already ends with it
 *   EDGE_SAM_API_KEY     only when something in front of the service asks for a bearer token
 *   EDGE_SAM_BOARD       the board's name for the label (default EDGE_BOARD, else "the board")
 *   EDGE_SAM_MODEL_NAME  the model's name for the label (default "Meta SAM 3.1")
 *   EDGE_SAM_TIMEOUT_MS  the longest one board answer may take (default 30000; the first after a restart takes 7 to 14 s)
 *
 * EDGE_CLOUD_TIMEOUT_MS and EDGE_FIRST work as they do for respondJsonOrEdge.
 *
 * A hosted product has no EDGE_SAM_URL: the board is on an office network it can't reach. With EDGE_SAM_URL unset and
 * GATEWAY_URL set, the board side is Muse Muse's {GATEWAY_URL}/fleet/v1/segment, with PRODUCT_TOKEN as the bearer, which takes
 * the photo to the office Jetson's `sam3` service through the fleet control plane and answers in that service's shape. It's
 * slower (10 to 25 s), so its timeout is 60 s unless EDGE_SAM_TIMEOUT_MS says otherwise, and its label names "an office
 * Jetson" unless EDGE_SAM_BOARD names it. While Muse Muse has that route off it answers 404, which is the board being down.
 * EDGE_SAM_VIA_GATEWAY=0 turns this off.
 */
export function samBoard(): { url: string; apiKey: string | null; board: string; modelName: string; viaGateway?: boolean } | null {
  const raw = process.env.EDGE_SAM_URL?.trim().replace(/\/+$/, "");
  if (!raw) return samViaGateway();
  let url: URL;
  try {
    url = new URL(/\/segment$/.test(raw) ? raw : `${raw}/segment`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return {
    url: url.href,
    apiKey: process.env.EDGE_SAM_API_KEY?.trim() || null,
    board: process.env.EDGE_SAM_BOARD?.trim() || process.env.EDGE_BOARD?.trim() || "the board",
    modelName: process.env.EDGE_SAM_MODEL_NAME?.trim() || SAM_NAME,
  };
}

/** The board side for a hosted product: Muse Muse's fleet route (see samBoard). Null without GATEWAY_URL. */
function samViaGateway(): { url: string; apiKey: string | null; board: string; modelName: string; viaGateway: true } | null {
  if (process.env.EDGE_SAM_VIA_GATEWAY?.trim() === "0") return null;
  const gateway = process.env.GATEWAY_URL?.trim().replace(/\/+$/, "");
  if (!gateway) return null;
  let url: URL;
  try {
    url = new URL(`${gateway}/fleet/v1/segment`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return {
    url: url.href,
    apiKey: process.env.PRODUCT_TOKEN?.trim() || null,
    board: process.env.EDGE_SAM_BOARD?.trim() || "an office Jetson",
    modelName: process.env.EDGE_SAM_MODEL_NAME?.trim() || SAM_NAME,
    viaGateway: true,
  };
}

/** How long the gateway's way to the office board may take by default: the photo goes up in pieces through the control plane. */
const DEFAULT_SAM_GATEWAY_TIMEOUT_MS = 60_000;

/** The cloud look's label. */
export function samCloudLabel(): string {
  return `Seen in the cloud by ${SAM_NAME}`;
}

/** The board look's label: "Seen on <board> by <model>". */
export function samBoardLabel(board: { board: string; modelName: string }): string {
  return `Seen on ${board.board} by ${board.modelName}`;
}

/** A box as fractions of the photo's width and height, 0 to 1, measured from its top left corner. */
export interface SeenBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface SeenObject {
  box: SeenBox;
  /** SAM's confidence, 0 to 1, or null when the cloud gave none. */
  score: number | null;
}

export type SamAnswer =
  | {
      ok: true;
      /** Who looked. */
      by: "cloud" | "board";
      /** One fixed line to show next to the result, never written by a model. */
      label: string;
      /** The prompt as it was sent, trimmed. */
      prompt: string;
      /** How many things matched at or above the threshold: always objects.length. */
      count: number;
      objects: SeenObject[];
      /** The photo's size as the side that looked saw it (the board shrinks anything over 1600 px). */
      imageSize: { width: number; height: number };
      /** The board's picture with the matches tinted, as a JPEG data URL, when `overlay` was asked for. Null from the cloud. */
      overlay: string | null;
      /** Why the side asked first didn't answer, when the second one did. */
      fellBack: EdgeFailureReason | null;
    }
  | {
      ok: false;
      by: null;
      /** A plain line the page can show as it is. */
      message: string;
      reasons: { cloud: EdgeFailureReason; board: EdgeFailureReason };
    };

export interface SegmentOrEdgeOptions {
  /** The photo: a JPEG or PNG data URL (resizeImage, then blobToDataUrl, in the browser), or its bare base64. */
  image: string;
  /** One short noun phrase, like "open door". Lists, questions and commands find nothing. */
  prompt: string;
  /** The lowest confidence that counts, 0 to 1, the same on both sides. Default 0.5. */
  threshold?: number;
  /** Ask the board for its picture with the matches tinted. The cloud sends none, so `overlay` is null from it. */
  overlay?: boolean;
  /** The incoming request, or `await headers()` in a server action, so the gateway can rate limit each visitor. */
  request?: RequestLike | null;
  /** Defaults to metaClient(request), the gateway client. */
  client?: OpenAI;
}

/**
 * Finds what `prompt` names in a photo with Meta SAM 3.1: in the cloud first (`sam-3.1` through the gateway, as the
 * meta-sam skill calls it), else on the board at EDGE_SAM_URL. EDGE_FIRST=1 flips the order. Server only.
 *
 * It never throws for a model failure: read `ok`. The board answers only when the cloud can't be reached (refused, timed
 * out, a 5xx, a broken stream, not set), or isn't set up for SAM (404 model_not_found). When the cloud was reached and
 * turned the photo down (a 4xx), that is the answer. A board reply that isn't JSON, doesn't match the service's reply
 * shape, or doesn't add up (a count that isn't its number of boxes, a box outside the photo, another prompt, a score
 * under the threshold) is the board being down: nothing from it is returned, and the page gets SAM_DOWN_MESSAGE.
 * The cloud gets EDGE_CLOUD_TIMEOUT_MS only when a board waits behind it; with no board it gets its full time.
 */
export async function segmentOrEdge(opts: SegmentOrEdgeOptions): Promise<SamAnswer> {
  const prompt = typeof opts.prompt === "string" ? opts.prompt.trim() : "";
  const photo = readPhoto(opts.image);
  if (!photo || !prompt || prompt.length > MAX_SAM_PROMPT) {
    const reason: EdgeFailureReason = { kind: "input", detail: !photo ? "The photo is not a readable JPEG or PNG." : "The prompt is empty or longer than 200 characters." };
    return { ok: false, by: null, message: photo ? SAM_BAD_PROMPT_MESSAGE : SAM_BAD_PHOTO_MESSAGE, reasons: { cloud: reason, board: reason } };
  }
  const threshold = typeof opts.threshold === "number" && opts.threshold >= 0 && opts.threshold <= 1 ? opts.threshold : DEFAULT_SAM_THRESHOLD;
  const board = samBoard();
  const order: Array<"cloud" | "board"> = edgeFirst() ? ["board", "cloud"] : ["cloud", "board"];
  const reasons: Partial<Record<"cloud" | "board", EdgeFailureReason>> = {};
  for (const side of order) {
    try {
      if (side === "cloud") {
        // The gateway's way to the office board only stands in when the cloud fails, so the cloud keeps its own pace there.
        const deadline = board && !board.viaGateway && order[0] === "cloud" ? cloudTimeoutMs() : null;
        const seen = await seeInCloud(opts, photo, prompt, threshold, deadline);
        return { ok: true, by: "cloud", label: samCloudLabel(), prompt, ...seen, fellBack: reasons.board ?? null };
      }
      if (!board) {
        throw new SideFailure({ kind: "not_set", detail: process.env.EDGE_SAM_URL?.trim() ? "EDGE_SAM_URL is not an http or https URL." : "EDGE_SAM_URL is not set." });
      }
      const seen = await seeOnBoard(board, photo, prompt, threshold, opts.overlay === true);
      return { ok: true, by: "board", label: samBoardLabel(board), prompt, ...seen, fellBack: reasons.cloud ?? null };
    } catch (err) {
      reasons[side] = reasonOf(err);
      if (side === "cloud" && cloudDeclined(reasons.cloud!)) {
        reasons.board ??= { kind: "skipped", detail: "The cloud turned the request down, so the board was not asked." };
        return { ok: false, by: null, message: CLOUD_DECLINED_MESSAGE, reasons: { cloud: reasons.cloud!, board: reasons.board } };
      }
    }
  }
  return { ok: false, by: null, message: SAM_DOWN_MESSAGE, reasons: { cloud: reasons.cloud!, board: reasons.board! } };
}

interface Photo {
  b64: string;
  dataUrl: string;
  width: number;
  height: number;
}

type Seen = Pick<Extract<SamAnswer, { ok: true }>, "count" | "objects" | "imageSize" | "overlay">;

/** The photo's base64 and pixel size, or null when it isn't a JPEG or PNG this can read. */
function readPhoto(image: unknown): Photo | null {
  if (typeof image !== "string") return null;
  const m = /^data:image\/[a-z0-9.+-]+;base64,/i.exec(image.trim());
  const b64 = (m ? image.trim().slice(m[0].length) : image).replace(/\s+/g, "");
  if (!b64 || b64.length > MAX_PHOTO_B64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const size = imageSize(Buffer.from(b64, "base64"));
  return size ? { b64, dataUrl: `data:${size.mime};base64,${b64}`, width: size.width, height: size.height } : null;
}

/** Width and height from a PNG's IHDR or a JPEG's first frame header. */
function imageSize(b: Buffer): { width: number; height: number; mime: string } | null {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a && b.toString("latin1", 12, 16) === "IHDR") {
    const width = b.readUInt32BE(16);
    const height = b.readUInt32BE(20);
    return width && height ? { width, height, mime: "image/png" } : null;
  }
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = b.readUInt16BE(i + 2);
    if (length < 2) return null;
    // Start of frame: C0 to CF, except C4 (Huffman tables), C8 (reserved) and CC (arithmetic coding).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = b.readUInt16BE(i + 5);
      const width = b.readUInt16BE(i + 7);
      return width && height ? { width, height, mime: "image/jpeg" } : null;
    }
    i += 2 + length;
  }
  return null;
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const fraction = (n: number, of: number) => round4(Math.min(1, Math.max(0, n / of)));

function boxOf(b: { left: number; top: number; right: number; bottom: number }, width: number, height: number): SeenBox {
  return { left: fraction(b.left, width), top: fraction(b.top, height), right: fraction(b.right, width), bottom: fraction(b.bottom, height) };
}

async function seeInCloud(opts: SegmentOrEdgeOptions, photo: Photo, prompt: string, threshold: number, deadlineMs: number | null): Promise<Seen> {
  if (!process.env.GATEWAY_URL?.trim() || !process.env.PRODUCT_TOKEN?.trim()) {
    throw new SideFailure({ kind: "not_set", detail: "GATEWAY_URL or PRODUCT_TOKEN is not set." });
  }
  const base = opts.client ?? metaClient(opts.request);
  const client = deadlineMs ? base.withOptions({ timeout: deadlineMs, maxRetries: 0 }) : base;
  const abort = new AbortController();
  const work = (async () => {
    const events = await client.responses.create(
      {
        model: SAM_MODEL,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: prompt }, imagePart(photo.dataUrl)] }],
        stream: true,
        metadata: { mask_encoding: "one_bit", include_confidence: "true" },
      },
      { signal: abort.signal },
    );
    const result = await parseImageStream(events).finalResult;
    if (result.outcome.status !== "completed") throw new SideFailure({ kind: "garbage", detail: "The cloud's look at the photo ended early." });
    // A record the parser couldn't read means the count can't be trusted, so it isn't an answer.
    if (result.diagnostics.some((d) => d.severity === "error")) throw new SideFailure({ kind: "garbage", detail: "The cloud's look had records that couldn't be read." });
    return fromCloud(result.records, photo, threshold);
  })();
  if (!deadlineMs) return work;
  // The SDK's timeout covers the request, not the stream after it, so the whole look is held to one deadline too.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new SideFailure({ kind: "timeout", detail: `The cloud took longer than ${deadlineMs / 1000} s.` }));
    }, deadlineMs);
  });
  work.catch(() => {});
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** One object per SAM object id: its box record (or its mask's bounds) and confidence, at or above the threshold. */
function fromCloud(records: readonly SegmentationRecord[], photo: Photo, threshold: number): Seen {
  const byId = new Map<string, { bounds: SeenBox; fromBox: boolean; score?: number }>();
  for (const r of records) {
    if (r.kind === "text") continue;
    const bounds = r.kind === "box" ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : r.bounds;
    const had = byId.get(r.objectId);
    if (!had || (r.kind === "box" && !had.fromBox)) byId.set(r.objectId, { bounds, fromBox: r.kind === "box", score: r.confidence ?? had?.score });
    else if (had.score === undefined && r.confidence !== undefined) had.score = r.confidence;
  }
  const objects: SeenObject[] = [];
  for (const o of byId.values()) {
    if (o.score !== undefined && o.score < threshold) continue;
    objects.push({ box: boxOf(o.bounds, photo.width, photo.height), score: o.score ?? null });
  }
  return { count: objects.length, objects, imageSize: { width: photo.width, height: photo.height }, overlay: null };
}

/** sam3.service's reply to POST /segment (scripts/edge/sam3/server.py). Boxes are pixels of `image_size`. */
const BoardReply = z.object({
  prompt: z.string(),
  count: z.number().int().min(0),
  objects: z
    .array(
      z.object({
        box: z.tuple([z.number(), z.number(), z.number(), z.number()]),
        score: z.number().min(0).max(1),
        area_px: z.number().min(0).optional(),
      }),
    )
    .max(256),
  ms: z.number().min(0).optional(),
  image_size: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  overlay_jpeg_b64: z.string().max(MAX_BOARD_REPLY_CHARS).optional(),
});

async function seeOnBoard(board: NonNullable<ReturnType<typeof samBoard>>, photo: Photo, prompt: string, threshold: number, overlay: boolean): Promise<Seen> {
  const timeout = ms("EDGE_SAM_TIMEOUT_MS", board.viaGateway ? DEFAULT_SAM_GATEWAY_TIMEOUT_MS : DEFAULT_SAM_TIMEOUT_MS);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeout);
  let text: string;
  try {
    const res = await fetch(board.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(board.apiKey ? { authorization: `Bearer ${board.apiKey}` } : {}) },
      body: JSON.stringify({ image_b64: photo.b64, prompt, threshold, overlay }),
      signal: abort.signal,
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new SideFailure({ kind: "http", status: res.status, detail: `The board answered HTTP ${res.status}.` });
    }
    if (Number(res.headers.get("content-length")) > MAX_BOARD_REPLY_CHARS) throw new SideFailure({ kind: "garbage", detail: "The board's reply was too big." });
    text = await res.text();
  } catch (err) {
    if (err instanceof SideFailure) throw err;
    if (abort.signal.aborted) throw new SideFailure({ kind: "timeout", detail: `The board took longer than ${timeout / 1000} s.` });
    throw new SideFailure({ kind: "refused", detail: "The board's connection was refused or dropped." });
  } finally {
    clearTimeout(timer);
  }
  if (text.length > MAX_BOARD_REPLY_CHARS) throw new SideFailure({ kind: "garbage", detail: "The board's reply was too big." });
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SideFailure({ kind: "garbage", detail: "The board's reply was not JSON." });
  }
  const parsed = BoardReply.safeParse(json);
  if (!parsed.success) throw new SideFailure({ kind: "schema", detail: `The board's reply did not match the SAM service's shape: ${z.prettifyError(parsed.error)}` });
  const reply = parsed.data;
  const [width, height] = reply.image_size;
  const wrong = (detail: string) => new SideFailure({ kind: "schema", detail: `The board's reply doesn't add up: ${detail}` });
  if (reply.prompt !== prompt) throw wrong("it answered another prompt.");
  if (reply.count !== reply.objects.length) throw wrong(`its count (${reply.count}) isn't its number of boxes (${reply.objects.length}).`);
  // The service shrinks a photo over 1600 px and never enlarges one, so its size keeps the photo's shape.
  if (width > photo.width || height > photo.height || Math.abs(width / height - photo.width / photo.height) > 0.02 * (photo.width / photo.height)) {
    throw wrong(`its photo size (${width} x ${height}) doesn't fit the photo sent (${photo.width} x ${photo.height}).`);
  }
  for (const o of reply.objects) {
    const [x0, y0, x1, y1] = o.box;
    if (x0 < 0 || y0 < 0 || x0 > x1 || y0 > y1 || x1 > width + 1 || y1 > height + 1) throw wrong("a box is outside the photo.");
    if (o.score < threshold - 0.001) throw wrong("a match is under the threshold.");
  }
  let picture: string | null = null;
  if (overlay && reply.overlay_jpeg_b64 !== undefined) {
    if (!/^\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(reply.overlay_jpeg_b64)) throw wrong("its picture isn't a JPEG.");
    picture = `data:image/jpeg;base64,${reply.overlay_jpeg_b64}`;
  }
  const objects = reply.objects.map((o) => ({ box: boxOf({ left: o.box[0], top: o.box[1], right: o.box[2], bottom: o.box[3] }, width, height), score: o.score }));
  return { count: objects.length, objects, imageSize: { width, height }, overlay: picture };
}
