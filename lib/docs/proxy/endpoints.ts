import type { DocsModelGroup } from "@/lib/docs/proxy/policy";
import type { GatewayEndpoint } from "@/lib/types";

/**
 * The endpoints the docs proxy mirrors (docs/DOCS_MIRROR.md, "Proxy"), and nothing else. Each entry says how its body
 * is read, which models it takes, which id in the path must be the visitor's, how its reply is metered, and what it
 * creates that the visitor then owns.
 */

export type DocsMethod = "GET" | "POST" | "DELETE";
export type DocsObjectKind = "file" | "response";

export type DocsEndpointId =
  | "status"
  | "models.list"
  | "models.retrieve"
  | "responses.create"
  | "responses.retrieve"
  | "responses.delete"
  | "responses.cancel"
  | "responses.input_tokens"
  | "chat.completions"
  | "messages.create"
  | "messages.count_tokens"
  | "files.create"
  | "files.list"
  | "files.retrieve"
  | "files.delete"
  | "files.content"
  | "images.generations"
  | "images.edits"
  | "asr.transcribe";

/** How a reply is metered: like the gateway's endpoint of that name, or the docs' own chat and messages meters. */
export type DocsMeterKind = "responses" | "chat" | "messages" | "images" | "asr";

export interface DocsEndpoint {
  id: DocsEndpointId;
  method: DocsMethod;
  /** Meta's path after /v1/, ids filled in and encoded. */
  upstreamPath: string;
  /** "json_or_multipart" is images/edits, which takes either. */
  body: "none" | "json" | "multipart" | "json_or_multipart";
  /** The models the endpoint takes, or null when it takes none. */
  models: DocsModelGroup | null;
  /** The file or response named in the path, which must be one this visitor created. */
  owned?: { kind: DocsObjectKind; id: string };
  /** Query parameters passed on to Meta. Everything else is dropped. */
  query: readonly string[];
  /** GET /v1/status needs no key, so none is sent. */
  noKey?: boolean;
  meter: DocsMeterKind | null;
  /** The gateway's name for the endpoint, for its estimate and meter helpers. */
  gateway?: GatewayEndpoint;
  /** What a successful reply creates for this visitor. */
  creates?: DocsObjectKind;
  /** Output-token field the proxy clamps (set when missing). */
  outputTokens?: "max_output_tokens" | "max_completion_tokens" | "max_tokens";
}

/** Meta's file and response ids (file-123, resp_abc). Anything else in a path is refused before it reaches a URL. */
const OBJECT_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Model ids such as muse-spark-1.3. */
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

type Entry = Omit<DocsEndpoint, "method" | "upstreamPath" | "owned" | "query"> & { query?: readonly string[] };

const FIXED: Record<string, Entry> = {
  "GET status": { id: "status", body: "none", models: null, noKey: true, meter: null },
  "GET models": { id: "models.list", body: "none", models: null, meter: null, query: ["client"] },
  "POST responses": {
    id: "responses.create",
    body: "json",
    models: "responses",
    meter: "responses",
    gateway: "responses",
    creates: "response",
    outputTokens: "max_output_tokens",
  },
  "POST responses/input_tokens": { id: "responses.input_tokens", body: "json", models: "text", meter: null },
  "POST chat/completions": {
    id: "chat.completions",
    body: "json",
    models: "text",
    meter: "chat",
    outputTokens: "max_completion_tokens",
  },
  "POST messages": {
    id: "messages.create",
    body: "json",
    models: "text",
    meter: "messages",
    outputTokens: "max_tokens",
  },
  "POST messages/count_tokens": { id: "messages.count_tokens", body: "json", models: "text", meter: null },
  "POST files": { id: "files.create", body: "multipart", models: null, meter: null, creates: "file" },
  "GET files": {
    id: "files.list",
    body: "none",
    models: null,
    meter: null,
    query: ["purpose", "limit", "order", "after"],
  },
  "POST images/generations": {
    id: "images.generations",
    body: "json",
    models: "images",
    meter: "images",
    gateway: "images/generations",
  },
  "POST images/edits": {
    id: "images.edits",
    body: "json_or_multipart",
    models: "images",
    meter: "images",
    gateway: "images/edits",
  },
  "POST asr/transcribe": {
    id: "asr.transcribe",
    body: "multipart",
    models: "voice",
    meter: "asr",
    gateway: "asr/transcribe",
    query: ["sessionId"],
  },
};

function fixed(method: DocsMethod, path: string): DocsEndpoint | null {
  const entry = FIXED[`${method} ${path}`];
  return entry ? { ...entry, query: entry.query ?? [], method, upstreamPath: path } : null;
}

function withId(
  method: DocsMethod,
  id: DocsEndpointId,
  upstreamPath: string,
  owned: DocsEndpoint["owned"],
  query: readonly string[] = [],
): DocsEndpoint {
  return { id, method, upstreamPath, owned, query, body: "none", models: null, meter: null };
}

/** The mirrored endpoint for a method and a /v1/<path>, or null when the docs don't run it (404 unknown_endpoint). */
export function matchEndpoint(method: string, path: readonly string[]): DocsEndpoint | null {
  if (method !== "GET" && method !== "POST" && method !== "DELETE") return null;
  if (!path.length || path.some((p) => !p)) return null;
  const exact = fixed(method, path.join("/"));
  if (exact) return exact;

  const [head, id, tail, ...rest] = path;
  if (rest.length || !id) return null;
  if (head === "models" && !tail && method === "GET" && MODEL_ID.test(id)) {
    return withId("GET", "models.retrieve", `models/${encodeURIComponent(id)}`, undefined);
  }
  if (!OBJECT_ID.test(id)) return null;
  if (head === "responses") {
    const owned = { kind: "response" as const, id };
    const at = `responses/${encodeURIComponent(id)}`;
    if (!tail && method === "GET") {
      return withId("GET", "responses.retrieve", at, owned, ["stream", "starting_after", "include", "include[]"]);
    }
    if (!tail && method === "DELETE") return withId("DELETE", "responses.delete", at, owned);
    if (tail === "cancel" && method === "POST") return withId("POST", "responses.cancel", `${at}/cancel`, owned);
    return null;
  }
  if (head === "files") {
    const owned = { kind: "file" as const, id };
    const at = `files/${encodeURIComponent(id)}`;
    if (!tail && method === "GET") return withId("GET", "files.retrieve", at, owned);
    if (!tail && method === "DELETE") return withId("DELETE", "files.delete", at, owned);
    if (tail === "content" && method === "GET") return withId("GET", "files.content", `${at}/content`, owned);
  }
  return null;
}

/** Every method and path the proxy runs, for the unknown_endpoint message and the docs. */
export const DOCS_ENDPOINT_LIST = [
  "GET /v1/status",
  "GET /v1/models",
  "GET /v1/models/{model}",
  "POST /v1/responses",
  "GET /v1/responses/{id}",
  "DELETE /v1/responses/{id}",
  "POST /v1/responses/{id}/cancel",
  "POST /v1/responses/input_tokens",
  "POST /v1/chat/completions",
  "POST /v1/messages",
  "POST /v1/messages/count_tokens",
  "POST /v1/files",
  "GET /v1/files",
  "GET /v1/files/{id}",
  "DELETE /v1/files/{id}",
  "GET /v1/files/{id}/content",
  "POST /v1/images/generations",
  "POST /v1/images/edits",
  "POST /v1/asr/transcribe",
] as const;
