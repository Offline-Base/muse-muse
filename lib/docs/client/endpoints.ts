import type { ModelKind } from "@/lib/docs/client/models";

/**
 * The endpoints the docs proxy forwards (docs/DOCS_MIRROR.md, "Proxy"), so the console can say up front when a path
 * won't run instead of waiting for a 404, and the facts the console needs about each: whether it streams, which
 * model menu fits it, whether its reply is a file.
 */

export type Method = "GET" | "POST" | "DELETE";

/** Path patterns per method; "{id}" stands for one path segment. */
const ALLOWED: Record<Method, readonly string[]> = {
  GET: ["status", "models", "models/{id}", "responses/{id}", "files", "files/{id}", "files/{id}/content"],
  POST: [
    "responses",
    "responses/{id}/cancel",
    "responses/input_tokens",
    "chat/completions",
    "messages",
    "messages/count_tokens",
    "files",
    "images/generations",
    "images/edits",
    "asr/transcribe",
  ],
  DELETE: ["responses/{id}", "files/{id}"],
};

/** "responses/resp_1?stream=true" becomes "responses/resp_1". */
export function cleanPath(path: string): string {
  return path
    .trim()
    .replace(/^\/+/, "")
    .replace(/^v1\//, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
}

function matches(pattern: string, path: string): boolean {
  const a = pattern.split("/");
  const b = path.split("/");
  return a.length === b.length && a.every((seg, i) => (seg === "{id}" ? !!b[i] && b[i] !== "input_tokens" : seg === b[i]));
}

/** True when the proxy forwards this method and path. */
export function isAllowedEndpoint(method: Method, path: string): boolean {
  const p = cleanPath(path);
  return ALLOWED[method].some((pattern) => matches(pattern, p));
}

/** The allowed paths for a method, for hints. */
export function allowedPaths(method: Method): readonly string[] {
  return ALLOWED[method];
}

/** Endpoints that answer with server-sent events when the body says `stream: true`. */
export function isStreamable(path: string): boolean {
  return ["responses", "chat/completions", "messages", "images/generations", "images/edits"].includes(cleanPath(path));
}

/** Endpoints whose reply is the file itself rather than JSON. */
export function isBinaryReply(path: string): boolean {
  return /^files\/[^/]+\/content$/.test(cleanPath(path));
}

/** The model menu that fits a request, or null when it takes no model. */
export function modelKindFor(path: string, model?: string | null): ModelKind | null {
  const p = cleanPath(path);
  if (p === "images/generations" || p === "images/edits") return "image";
  if (p === "asr/transcribe") return "voice";
  if (p === "responses") {
    if (model === "muse-image-1.0") return "image";
    if (model === "sam-3.1") return "sam";
    return "text";
  }
  if (["responses/input_tokens", "chat/completions", "messages", "messages/count_tokens"].includes(p)) return "text";
  return null;
}

/** The ids the proxy hands out, by the prefix Meta gives them. */
export type IdKind = "response" | "file" | "message" | "chat";

export function idKindOf(id: string): IdKind | null {
  if (/^resp_[A-Za-z0-9_-]+$/.test(id)) return "response";
  if (/^file[-_][A-Za-z0-9_-]+$/.test(id)) return "file";
  if (/^msg_[A-Za-z0-9_-]+$/.test(id)) return "message";
  if (/^chatcmpl-[A-Za-z0-9_-]+$/.test(id)) return "chat";
  return null;
}

/** Meta's example ids and {placeholders} in a path, which a reader replaces with an id of their own. */
export const EXAMPLE_ID = /\{[a-z_]+\}|\bresp_abc123\b|\bfile[-_]abc123\b/;

/** Which kind of id a path's placeholder wants: files/{id}... wants a file, responses/{id}... a response. */
export function placeholderKind(path: string): IdKind | null {
  const p = cleanPath(path);
  if (!EXAMPLE_ID.test(p)) return null;
  if (p.startsWith("files/")) return "file";
  if (p.startsWith("responses/")) return "response";
  return null;
}
