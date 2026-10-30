import { imageTurnRequest, type ImageToolSettings, type JsonObject, type MediaRef } from "@/lib/docs/media/requests";

/**
 * Requests and checks for the Muse Image cookbook recipes (image-generation-basics, image-editing-with-reasoning,
 * anchored-image-series, search-grounded-image-generation). A recipe is a list of steps, each one Responses turn on
 * muse-image-1.0 that starts a conversation or continues an earlier step. The server can keep the conversation
 * (previous_response_id, the default store: true), or the client carries it (store: false, replaying the prior
 * image_generation_call item). Pure, so the demo, its "Show code" and the tests build the same bodies.
 */

export interface ImageStep {
  id: string;
  label: string;
  /** Where the step sits in a contact sheet: reference anchors, panels, the composed page, or plain turns. */
  group?: "anchor" | "panel" | "page" | "turn" | "compare";
  prompt: string;
  /** The step this one continues, or null for a new conversation. */
  chainFrom?: string | null;
  /** Sample images attached as input_image parts (the reader can swap them). */
  references?: Array<{ sampleId: string; label?: string }>;
  /** Left out of "Run all"; run it on its own. */
  optional?: boolean;
  /** What the step shows, under its title. */
  note?: string;
  /** image_generation tool fields for this step. */
  settings?: Pick<ImageToolSettings, "size" | "reasoningStrength" | "enableWebSearch" | "enableImageSearch">;
}

export type StateMode = "server" | "client";

/** What a continued turn needs from the step it continues. */
export interface Parent {
  responseId: string | null;
  /** The parent's image_generation_call item, for client-side state. */
  item: JsonObject | null;
}

export interface StepRequestInput {
  prompt: string;
  references: MediaRef[];
  parent: Parent | null;
  mode: StateMode;
  settings?: ImageToolSettings;
  /** Replay the prior image as the whole item (as the cookbook does) or its signed id with result null (the image guide). */
  replay?: "id" | "item";
  /** Send content parts as a bare list, without the user message around them: Meta answers HTTP 400 (the recipe's warning). */
  bareList?: boolean;
}

const MODEL = "muse-image-1.0";

/**
 * The body for one step. Server state: imageTurnRequest (a string input, or a user message with input_text and
 * input_image parts, plus previous_response_id). Client state: store: false on every turn, and a continued turn's input
 * starts with the replayed image_generation_call item, then the user message.
 */
export function stepRequest(r: StepRequestInput): { path: string; body: JsonObject } {
  const parts: JsonObject[] = [
    { type: "input_text", text: r.prompt },
    ...r.references.map((ref): JsonObject => ({
      type: "input_image",
      ...("fileId" in ref ? { file_id: ref.fileId } : { image_url: "dataUrl" in ref ? ref.dataUrl : ref.url }),
    })),
  ];
  if (r.bareList && r.references.length) {
    const body: JsonObject = { model: MODEL, input: parts };
    if (r.mode === "server" && r.parent?.responseId) body.previous_response_id = r.parent.responseId;
    if (r.mode === "client") body.store = false;
    return { path: "responses", body };
  }
  if (r.mode === "server") {
    return imageTurnRequest({
      prompt: r.prompt,
      previousResponseId: r.parent?.responseId ?? null,
      references: r.references,
      settings: r.settings,
    });
  }
  const base = imageTurnRequest({ prompt: r.prompt, references: r.references, settings: r.settings }).body;
  const replayed = r.parent?.item ? replayItem(r.parent.item, r.replay ?? "id") : null;
  const body: JsonObject = { model: MODEL, store: false };
  if (replayed) body.input = [replayed, { role: "user", content: parts }];
  else body.input = base.input;
  if (base.tools) body.tools = base.tools;
  return { path: "responses", body };
}

/**
 * The prior image as a next turn's input item. Its id is a signed handle that carries the image, so the image guide
 * replays it with result null; the cookbook replays the whole item, which works too and resends the bytes.
 */
export function replayItem(item: JsonObject, replay: "id" | "item"): JsonObject {
  if (replay === "item") return { ...item };
  return { type: "image_generation_call", id: item.id, status: item.status ?? "completed", result: null };
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);

/** The image_generation_call item and where it sits in output, found by type rather than position. */
export function imageCallOf(reply: unknown): { index: number; item: JsonObject } | null {
  const output = obj(reply)?.output;
  if (!Array.isArray(output)) return null;
  const index = output.findIndex((o) => obj(o)?.type === "image_generation_call" && typeof obj(o)?.result === "string" && (obj(o)?.result as string).length > 0);
  return index < 0 ? null : { index, item: output[index] as JsonObject };
}

export interface ReplyCheck {
  label: string;
  ok: boolean;
  detail?: string;
}

/** The "Check the result" list for a reply: completed, an image_generation_call found by type, the types of the other items. */
export function replyChecks(reply: unknown): ReplyCheck[] {
  const r = obj(reply);
  const status = typeof r?.status === "string" ? r.status : "missing";
  const output = Array.isArray(r?.output) ? (r!.output as unknown[]).map((o) => String(obj(o)?.type ?? "?")) : [];
  const call = imageCallOf(reply);
  const checks: ReplyCheck[] = [
    { label: "status is completed", ok: status === "completed", detail: `status: ${status}` },
    {
      label: "output has an image_generation_call with a result",
      ok: !!call,
      detail: call ? `output[${call.index}] of [${output.join(", ")}]` : `output types: [${output.join(", ") || "none"}]`,
    },
  ];
  return checks;
}

/** "WEBP", "PNG", "JPEG" from the start of the base64, or null. */
export function base64Format(b64: string): string | null {
  if (b64.startsWith("UklGR")) return "WEBP";
  if (b64.startsWith("iVBOR")) return "PNG";
  if (b64.startsWith("/9j/")) return "JPEG";
  return null;
}

export interface TokenCounts {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  total: number;
}

export function tokenCounts(reply: unknown): TokenCounts | null {
  const u = obj(obj(reply)?.usage);
  if (!u) return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const input = n(u.input_tokens);
  const output = n(u.output_tokens);
  return {
    input,
    cached: n(obj(u.input_tokens_details)?.cached_tokens),
    output,
    reasoning: n(obj(u.output_tokens_details)?.reasoning_tokens),
    total: n(u.total_tokens) || input + output,
  };
}

/** Steps in run order for "Run all": every step that isn't optional, each after the step it continues. */
export function runOrder(steps: readonly ImageStep[]): ImageStep[] {
  return steps.filter((s) => !s.optional);
}

/** The ids of steps that continue `id`, directly or through others: their results are stale once `id` reruns. */
export function descendants(steps: readonly ImageStep[], id: string, chains: Readonly<Record<string, string | null>>): string[] {
  const out: string[] = [];
  const walk = (parent: string) => {
    for (const s of steps) {
      if ((chains[s.id] ?? null) === parent && !out.includes(s.id)) {
        out.push(s.id);
        walk(s.id);
      }
    }
  };
  walk(id);
  return out;
}

/** Steps a step may continue: the ones before it. */
export function chainOptions(steps: readonly ImageStep[], id: string): ImageStep[] {
  const at = steps.findIndex((s) => s.id === id);
  return at <= 0 ? [] : steps.slice(0, at);
}

/** The images a recipe run will cost at $0.01 each: every step "Run all" runs. */
export function recipeCost(steps: readonly ImageStep[], perImage = 0.01): { images: number; usd: number } {
  const images = runOrder(steps).length;
  return { images, usd: Math.round(images * perImage * 100) / 100 };
}
