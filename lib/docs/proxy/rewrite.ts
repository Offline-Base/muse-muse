import type { DocsEndpoint } from "@/lib/docs/proxy/endpoints";
import {
  DOCS_FILE_EXPIRES_SECONDS,
  DOCS_IMAGES_MAX_N,
  DOCS_MAX_TOOL_CALLS,
  OUTPUT_TOKEN_CLAMPS,
} from "@/lib/docs/proxy/policy";
import { isBuiltInTool } from "@/lib/gateway/search";
import { contributorSwitchOn, RETIRED_SPARK, SPARK_STANDIN } from "@/lib/meta/spark";

export { isBuiltInTool };

/**
 * What the proxy changes in a request before it goes to Meta, each change said in x-docs-note: Muse Spark 1.3 runs as
 * Spark 1.3 Contributor (it is never called), output tokens are capped per model (and set when missing), images are
 * capped at two per call, built-in tool calls at five, uploads expire after an hour, and a streamed chat completion
 * asks for usage so it can be metered. Requests also get a safety identifier for this visitor when they carry none, so
 * Meta can act on one visitor instead of the whole key.
 *
 * A limit the proxy can't read as a plain number in range (null, a string, Infinity from a number too big for JSON) is
 * replaced rather than left for Meta to refuse: Meta reads null as "the model's own maximum", and JSON.stringify sends
 * Infinity as null, so leaving either would lift the cap the estimate counts on.
 */

export const SWITCH_NOTE = `Ran on ${SPARK_STANDIN}: the live docs run on it for now.`;
export const SPARK_NOTE = `Ran on ${SPARK_STANDIN}: the live docs never call ${RETIRED_SPARK}.`;

export interface Rewrite<T> {
  body: T;
  /** The model the call runs on, after the Spark 1.3 swap, or null when the request names none. */
  model: string | null;
  notes: string[];
  /** False when nothing changed, so a multipart body can be forwarded byte for byte. */
  changed: boolean;
}

/** A number, or a numeric string as lenient parsers read it. NaN for anything else. */
function numeric(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return NaN;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A value as a note can show it: short, and printable in a header. */
function shown(value: unknown): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "a number too large to read";
  if (typeof value === "string") return JSON.stringify(value.length > 24 ? `${value.slice(0, 24)}...` : value);
  if (value === null) return "null";
  return Array.isArray(value) ? "a list" : typeof value === "object" ? "an object" : String(value);
}

/**
 * Output tokens end up a number from 1 to the model's cap, whatever the request sent: set when missing or null (null
 * asks for the model's own maximum), lowered when over, and replaced when it isn't a number at all. A numeric string
 * in range is sent as the number it reads as.
 */
function clampOutputTokens(
  endpoint: DocsEndpoint,
  json: Record<string, unknown>,
  model: string | null,
  notes: string[],
): void {
  const field = endpoint.outputTokens;
  const cap = model ? OUTPUT_TOKEN_CLAMPS[model] : undefined;
  // Muse Image and SAM take no output limit, so only text models are clamped.
  if (!field || !cap || !model) return;
  const most = `the most the live docs allow for ${model}`;
  // Chat Completions still takes the deprecated max_tokens: clamp whichever the request set, and add
  // max_completion_tokens only when it set neither, since sending both can be refused.
  const fields = endpoint.id === "chat.completions" ? ["max_completion_tokens", "max_tokens"] : [field];
  const nulled = fields.filter((f) => json[f] === null);
  for (const f of nulled) delete json[f];
  const set = fields.filter((f) => json[f] !== undefined);
  if (!set.length) {
    const target = nulled[0] ?? field;
    json[target] = cap;
    notes.push(
      nulled.length
        ? `Set ${target} to ${cap}: null asks for the model's own maximum, more than ${most}.`
        : `Set ${field} to ${cap}, ${most}.`,
    );
    return;
  }
  if (nulled.length) notes.push(`Dropped ${nulled.join(" and ")}: null, beside ${set.join(" and ")}.`);
  for (const f of set) {
    const value = json[f];
    const n = numeric(value);
    if (Number.isFinite(n) && n >= 1 && n <= cap) {
      if (typeof value !== "number") {
        json[f] = n;
        notes.push(`Sent ${f} as the number ${n}.`);
      }
      continue;
    }
    json[f] = cap;
    notes.push(
      Number.isFinite(n) && n > cap
        ? `Lowered ${f} from ${n} to ${cap}, ${most}.`
        : `Set ${f} to ${cap}: ${shown(value)} isn't a limit from 1 to ${cap}, ${most}.`,
    );
  }
}

/**
 * Images per call end up from 1 to DOCS_IMAGES_MAX_N, or unset (Meta's default of one): null is dropped, a count over
 * the cap lowered, and anything that isn't a count from 1 up becomes 1. Returns the value to send, undefined to drop
 * the field, or null to leave it as it is.
 */
function clampImageCount(value: unknown, notes: string[]): number | string | undefined | null {
  if (value === undefined) return null;
  if (value === null) {
    notes.push("Dropped n: null, so Meta makes its default of one image.");
    return undefined;
  }
  const n = numeric(value);
  if (Number.isFinite(n) && n >= 1 && n <= DOCS_IMAGES_MAX_N) return typeof value === "number" ? null : n;
  if (Number.isFinite(n) && n > DOCS_IMAGES_MAX_N) {
    notes.push(`Lowered n from ${n} to ${DOCS_IMAGES_MAX_N}: live demos make at most ${DOCS_IMAGES_MAX_N} images per call.`);
    return DOCS_IMAGES_MAX_N;
  }
  if (n === Infinity) {
    notes.push(`Lowered n from ${shown(value)} to ${DOCS_IMAGES_MAX_N}: live demos make at most ${DOCS_IMAGES_MAX_N} images per call.`);
    return DOCS_IMAGES_MAX_N;
  }
  notes.push(`Set n to 1: ${shown(value)} isn't a count of images from 1 to ${DOCS_IMAGES_MAX_N}.`);
  return 1;
}

/**
 * Built-in tool calls (web searches, hosted tool search) capped at DOCS_MAX_TOOL_CALLS when the request offers one:
 * Meta has no maximum of its own, and each search is billed and adds input, so this is what makes the estimate's
 * search count a ceiling.
 */
function clampToolCalls(json: Record<string, unknown>, notes: string[]): void {
  if (!Array.isArray(json.tools) || !json.tools.some(isBuiltInTool)) return;
  const value = json.max_tool_calls;
  const n = numeric(value);
  if (typeof value === "number" && Number.isInteger(n) && n >= 1 && n <= DOCS_MAX_TOOL_CALLS) return;
  json.max_tool_calls = DOCS_MAX_TOOL_CALLS;
  notes.push(
    value === undefined || value === null
      ? `Set max_tool_calls to ${DOCS_MAX_TOOL_CALLS}: live demos run at most ${DOCS_MAX_TOOL_CALLS} built-in tool calls, such as searches.`
      : `Set max_tool_calls to ${DOCS_MAX_TOOL_CALLS} (it was ${shown(value)}): live demos run at most ${DOCS_MAX_TOOL_CALLS} built-in tool calls, such as searches.`,
  );
}

function addSafetyIdentifier(endpoint: DocsEndpoint, json: Record<string, unknown>, safetyId: string) {
  switch (endpoint.id) {
    case "responses.create":
    case "chat.completions":
      // The reader's own value wins, including the deprecated `user` it supersedes.
      if (json.safety_identifier == null && json.user == null) json.safety_identifier = safetyId;
      return;
    case "messages.create": {
      // The Messages API's equivalent is metadata.user_id (protocols/messages, "Request fields").
      const metadata = json.metadata;
      if (metadata == null) json.metadata = { user_id: safetyId };
      else if (isObject(metadata) && metadata.user_id == null) json.metadata = { ...metadata, user_id: safetyId };
      return;
    }
    case "images.generations":
    case "images.edits":
      if (json.user == null) json.user = safetyId;
      return;
  }
}

/** Rewrites a JSON body. The input is not changed. */
export function rewriteJson(
  endpoint: DocsEndpoint,
  input: Record<string, unknown>,
  safetyId?: string,
): Rewrite<Record<string, unknown>> {
  const json: Record<string, unknown> = { ...input };
  const notes: string[] = [];
  let model = typeof json.model === "string" ? json.model : null;
  if (model === RETIRED_SPARK) {
    json.model = SPARK_STANDIN;
    model = SPARK_STANDIN;
    notes.push(SPARK_NOTE);
  }
  // BUILDS_ON_CONTRIBUTOR: every demo that names Muse Wonder goes through here, whatever its playground's default.
  if (model === "muse-wonder-1.0" && contributorSwitchOn()) {
    json.model = SPARK_STANDIN;
    model = SPARK_STANDIN;
    notes.push(SWITCH_NOTE);
  }
  clampOutputTokens(endpoint, json, model, notes);
  if (endpoint.id === "responses.create") clampToolCalls(json, notes);
  if (endpoint.id === "images.generations" || endpoint.id === "images.edits") {
    const n = clampImageCount(json.n, notes);
    if (n === undefined) delete json.n;
    else if (n !== null) json.n = n;
  }
  if (endpoint.id === "chat.completions" && json.stream === true) {
    const options = isObject(json.stream_options) ? json.stream_options : {};
    if (options.include_usage !== true) {
      json.stream_options = { ...options, include_usage: true };
      notes.push("Turned on stream_options.include_usage so the run can be metered: the last chunk carries usage and no choices.");
    }
  }
  if (safetyId) addSafetyIdentifier(endpoint, json, safetyId);
  return { body: json, model, notes, changed: true };
}

/** Reads a multipart field that may arrive as a string or as a file part (asr/transcribe's `request` JSON). */
export async function formText(value: FormDataEntryValue | null): Promise<string | null> {
  if (value === null) return null;
  return typeof value === "string" ? value : await value.text();
}

export class FormRewriteError extends Error {}

/**
 * Multipart fields the proxy reads and checks. Each may come once: form.get reads the first copy, and a parser at Meta
 * that keeps the last would otherwise run a value the proxy never checked (a second n, model or purpose).
 */
const SINGLE_FIELDS = new Set(["model", "n", "request", "purpose", "file", "audio"]);

function repeatedFields(form: FormData): string[] {
  const names = new Set(form.keys());
  return [...names].filter((name) => (SINGLE_FIELDS.has(name) || name.startsWith("expires_after")) && form.getAll(name).length > 1);
}

/**
 * An upload as the docs send it: purpose user_data, an hour's expiry (Meta deletes it then even if the hourly cleanup
 * can't), and the file last, which file-handling ("Upload a file") says lets Meta start forwarding it sooner.
 */
function uploadForm(form: FormData, notes: string[]): FormData {
  const file = form.get("file");
  if (!(file instanceof File)) throw new FormRewriteError('Upload the file in a "file" part.');
  if (form.get("purpose") !== "user_data") {
    throw new FormRewriteError('Live demos upload files with purpose "user_data", the purpose requests reference.');
  }
  const expiry = [...form.keys()].filter((name) => name.startsWith("expires_after"));
  const seconds = String(DOCS_FILE_EXPIRES_SECONDS);
  const asked =
    expiry.length === 2 && form.get("expires_after[anchor]") === "created_at" && form.get("expires_after[seconds]") === seconds;
  const out = new FormData();
  out.set("purpose", "user_data");
  out.set("expires_after[anchor]", "created_at");
  out.set("expires_after[seconds]", seconds);
  for (const [name, value] of form.entries()) {
    if (name !== "purpose" && name !== "file" && !name.startsWith("expires_after")) out.append(name, value);
  }
  out.set("file", file);
  if (!asked) {
    notes.push(
      expiry.length
        ? `Set expires_after to ${seconds} s from created_at: live demo uploads last an hour.`
        : `Added expires_after, ${seconds} s from created_at: live demo uploads last an hour.`,
    );
  }
  return out;
}

/**
 * Rewrites a multipart body: the `model` field (images/edits), the model inside asr/transcribe's `request` JSON part,
 * images/edits' `n`, and an upload's purpose and expiry. Throws FormRewriteError for a `request` part that isn't a
 * JSON object, a field the proxy checks sent twice, or an upload that isn't a user_data file.
 */
export async function rewriteForm(endpoint: DocsEndpoint, form: FormData): Promise<Rewrite<FormData>> {
  const notes: string[] = [];
  let changed = false;
  let model: string | null = null;

  const repeated = repeatedFields(form);
  if (repeated.length) {
    throw new FormRewriteError(`Send ${repeated.join(", ")} once: the live docs check each of these fields, so a second copy is refused.`);
  }

  if (endpoint.id === "asr.transcribe") {
    const raw = await formText(form.get("request"));
    if (raw !== null) {
      let request: unknown;
      try {
        request = JSON.parse(raw);
      } catch {
        throw new FormRewriteError(
          'The "request" part must be a JSON object, such as {"model":"muse-voice-transcribe-1.0","audioEncoding":"WAV"}.',
        );
      }
      if (!isObject(request)) throw new FormRewriteError('The "request" part must be a JSON object.');
      model = typeof request.model === "string" ? request.model : null;
      if (model === RETIRED_SPARK) {
        model = SPARK_STANDIN;
        form.set("request", JSON.stringify({ ...request, model }));
        notes.push(SPARK_NOTE);
        changed = true;
      }
    }
  }
  if (model === null) {
    const field = form.get("model");
    model = typeof field === "string" ? field : null;
    if (model === RETIRED_SPARK) {
      model = SPARK_STANDIN;
      form.set("model", model);
      notes.push(SPARK_NOTE);
      changed = true;
    }
  }
  if (endpoint.id === "images.edits") {
    const raw = form.has("n") ? form.get("n") : undefined;
    const n = clampImageCount(raw, notes);
    if (n === undefined) {
      form.delete("n");
      changed = true;
    } else if (n !== null && String(n) !== raw) {
      form.set("n", String(n));
      changed = true;
    }
  }
  if (endpoint.id === "files.create") return { body: uploadForm(form, notes), model, notes, changed: true };
  return { body: form, model, notes, changed };
}

/**
 * Ids a multipart body points at. No documented multipart field takes one, but Meta reads bracketed names
 * (expires_after[anchor]), so a field such as images[0][file_id] is checked like a JSON body's file_id.
 */
export function formReferences(form: FormData): BodyReferences {
  const fileIds = new Set<string>();
  for (const [name, value] of form.entries()) {
    if (name.includes("file_id") && typeof value === "string" && value) fileIds.add(value);
  }
  return { fileIds: [...fileIds], responseIds: [], refused: null };
}

/** Ids a JSON body points at that must be this visitor's, and a field the docs refuse to forward. */
export interface BodyReferences {
  fileIds: string[];
  responseIds: string[];
  /** Why the body can't run here, for a field that points at account objects the proxy can't attribute. */
  refused: string | null;
}

const MAX_DEPTH = 64;

/**
 * Finds what a body points at by id: every `file_id` (Responses, Chat Completions, Messages and images/edits all name
 * uploads that way) and the Responses `previous_response_id`, which pulls in a stored conversation. Each must be one
 * this visitor created, or a demo could read another account user's files or chats through Muse Muse's key. Stored
 * prompts, conversations and item references point at objects the proxy never records, so they are refused.
 */
export function bodyReferences(endpoint: DocsEndpoint, json: Record<string, unknown>): BodyReferences {
  const fileIds = new Set<string>();
  let itemReference = false;
  const responsesApi = endpoint.id === "responses.create" || endpoint.id === "responses.input_tokens";
  const walk = (value: unknown, depth: number) => {
    if (depth > MAX_DEPTH || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const v of value) walk(v, depth + 1);
      return;
    }
    const obj = value as Record<string, unknown>;
    if (typeof obj.file_id === "string" && obj.file_id) fileIds.add(obj.file_id);
    if (obj.type === "item_reference") itemReference = true;
    for (const v of Object.values(obj)) walk(v, depth + 1);
  };
  walk(json, 0);

  const previous = responsesApi && typeof json.previous_response_id === "string" ? json.previous_response_id : "";
  const responseIds = previous ? [previous] : [];
  let refused: string | null = null;
  if (responsesApi) {
    if (json.conversation != null) {
      refused = "Live demos don't run stored conversations. Chain turns with previous_response_id instead.";
    } else if (json.prompt != null) {
      refused = "Live demos don't run stored prompt templates. Put the instructions and input in the request.";
    } else if (itemReference) {
      refused = "Live demos don't run item references. Send the items themselves, or chain turns with previous_response_id.";
    }
  }
  return { fileIds: [...fileIds], responseIds, refused };
}
