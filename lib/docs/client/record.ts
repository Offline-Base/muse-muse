import type { Collected } from "@/lib/docs/client/stream";
import { collectReply, protocolOfReply } from "@/lib/docs/client/stream";
import type { FormSpec } from "@/lib/docs/client/form";

/**
 * What a demo records for "Copy prompt for your coding agent" ("Include what I just ran"): the body without the
 * megabytes of base64 a file adds, a one-line description of a multipart body, and the start of the reply. The
 * prompt builder trims again; this keeps the page's state small.
 */

const OUTCOME_MAX = 200;
const STRING_MAX = 600;

function cut(text: string, max = OUTCOME_MAX): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t;
}

/** The body with data URLs, base64 and very long strings shortened, for the record and the prompt. */
export function trimForRecord(body: unknown, depth = 0): unknown {
  if (depth > 30) return "...";
  if (typeof body === "string") {
    const dataUrl = /^data:([^;,]+)(;[^,]*)?;base64,/.exec(body);
    if (dataUrl) return `data:${dataUrl[1]};base64,<${Math.round((body.length * 3) / 4 / 1024)} KB of base64>`;
    if (body.length > 400 && /^[A-Za-z0-9+/=\r\n]+$/.test(body)) return `<${Math.round((body.length * 3) / 4 / 1024)} KB of base64>`;
    return body.length > STRING_MAX ? `${body.slice(0, STRING_MAX)}... (${body.length - STRING_MAX} more characters)` : body;
  }
  if (Array.isArray(body)) {
    const items = body.slice(0, 50).map((x) => trimForRecord(x, depth + 1));
    return body.length > 50 ? [...items, `... ${body.length - 50} more items`] : items;
  }
  if (body && typeof body === "object") {
    return Object.fromEntries(Object.entries(body as Record<string, unknown>).map(([k, v]) => [k, trimForRecord(v, depth + 1)]));
  }
  return body;
}

/** "multipart: purpose=user_data, file=photo.jpg (120 KB)" from FormData or the console's field list. */
export function describeForm(form: FormData | ReadonlyArray<FormSpec>): string {
  const parts: string[] = [];
  const add = (name: string, value: unknown) => {
    if (typeof value === "string") parts.push(`${name}=${cut(value, 120)}`);
    else if (value && typeof value === "object" && "size" in value) {
      const blob = value as Blob & { name?: string };
      parts.push(`${name}=${blob.name || "file"} (${Math.max(1, Math.round(blob.size / 1024))} KB)`);
    }
  };
  if (typeof FormData !== "undefined" && form instanceof FormData) form.forEach((v, k) => add(k, v));
  else for (const f of form as ReadonlyArray<FormSpec>) parts.push(f.file ? `${f.name}=${f.value || "file"}` : `${f.name}=${cut(f.value ?? "", 120)}`);
  return `multipart: ${parts.join(", ")}`;
}

/** The start of a text reply, as the prompt shows it: "output_text: The capital of France is Paris." */
export function outcomeOfCollected(c: Collected): string {
  if (c.error) return cut(`error: ${c.error.message}`);
  const label = c.protocol === "responses" ? "output_text" : c.protocol === "chat" ? "content" : "text";
  const calls = c.toolCalls.map((t) => `${t.name}(${cut(t.arguments, 80)})`).join(", ");
  if (c.text && calls) return cut(`${label}: ${c.text} | tool calls: ${calls}`);
  if (calls) return cut(`tool calls: ${calls}`);
  if (c.images.length) return `images: ${c.images.length} generated`;
  if (c.text) return cut(`${label}: ${c.text}`);
  if (c.refusal) return cut(`refusal: ${c.refusal}`);
  return c.done ? "no text in the reply" : "the reply stopped early";
}

type Json = Record<string, unknown>;

/** The start of any reply, for the record: text for the text protocols, the useful field for the rest. */
export function outcomeOfReply(json: unknown, status?: number, errorMessage?: string): string {
  if (errorMessage) return cut(`error${status ? ` ${status}` : ""}: ${errorMessage}`);
  const protocol = protocolOfReply(json);
  if (protocol) return outcomeOfCollected(collectReply(protocol, json));
  if (!json || typeof json !== "object") return status ? `HTTP ${status}` : "no reply";
  const o = json as Json;
  if (typeof o.transcript === "string") return cut(`transcript: ${o.transcript.replace(/​/g, "")}`);
  if (typeof o.input_tokens === "number" && Object.keys(o).length <= 3) return `input_tokens: ${o.input_tokens}`;
  if (Array.isArray(o.data)) {
    const data = o.data as Json[];
    if (data.some((d) => d && (typeof d.b64_json === "string" || typeof d.url === "string"))) return `data: ${data.length} image${data.length === 1 ? "" : "s"}`;
    const ids = data.map((d) => d && d.id).filter((x): x is string => typeof x === "string");
    return cut(`data: ${data.length} item${data.length === 1 ? "" : "s"}${ids.length ? ` (${ids.slice(0, 6).join(", ")})` : ""}`);
  }
  if (typeof o.id === "string") {
    const details = [o.object, o.filename, o.status, o.deleted === true ? "deleted" : null].filter((x) => typeof x === "string");
    return cut(`${o.id}${details.length ? ` (${details.join(", ")})` : ""}`);
  }
  return cut(JSON.stringify(json));
}
