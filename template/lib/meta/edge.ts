import OpenAI from "openai";
import type { ChatCompletionContentPart, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { z } from "zod";
import { metaClient, testModelFor } from "./client";
import { NO_EM_DASHES, parseJsonText, respondJson, type RespondJsonOptions, toStrictSchema } from "./json";
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
 * answer, so the edge isn't asked. 408 is a timeout, so it still falls back.
 */
function cloudDeclined(reason: EdgeFailureReason): boolean {
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

function reasonOf(err: unknown): EdgeFailureReason {
  if (err instanceof SideFailure) return err.reason;
  if (err instanceof OpenAI.APIConnectionTimeoutError) return { kind: "timeout", detail: "No answer in time." };
  if (err instanceof OpenAI.APIConnectionError) return { kind: "refused", detail: "The connection was refused or dropped." };
  if (err instanceof OpenAI.APIError && typeof err.status === "number") return { kind: "http", status: err.status, detail: `HTTP ${err.status}.` };
  if (err instanceof Error && err.name === "RespondJsonError") return { kind: "schema", detail: err.message };
  if (err instanceof Error && /abort|timed? ?out/i.test(`${err.name} ${err.message}`)) return { kind: "timeout", detail: "No answer in time." };
  return { kind: "refused", detail: err instanceof Error ? err.message.slice(0, 200) : "Unknown error." };
}
