/**
 * The Files API as the API reference pages lay it out (api-reference/files/*): the five calls of a file's life, the
 * query GET /v1/files takes (purpose, limit, order, after) and the limits on expires_after. Pure, so the console and
 * its tests share one copy.
 */

export type FilesStep = "upload" | "list" | "retrieve" | "content" | "delete";

export interface FilesStepInfo {
  id: FilesStep;
  label: string;
  method: "GET" | "POST" | "DELETE";
  /** As the reference page titles it. */
  route: string;
  /** The API reference page for this call. */
  slug: string;
  /** The schema its reply follows (api-reference/files/schemas), when it's JSON. */
  reply?: string;
}

export const FILES_STEPS: readonly FilesStepInfo[] = [
  { id: "upload", label: "Upload", method: "POST", route: "/files", slug: "api-reference/files/upload-file", reply: "file-object" },
  { id: "list", label: "List", method: "GET", route: "/files", slug: "api-reference/files/list-files", reply: "list-files-response" },
  { id: "retrieve", label: "Retrieve", method: "GET", route: "/files/{file_id}", slug: "api-reference/files/retrieve-file", reply: "file-object" },
  { id: "content", label: "Download content", method: "GET", route: "/files/{file_id}/content", slug: "api-reference/files/retrieve-file-content" },
  { id: "delete", label: "Delete", method: "DELETE", route: "/files/{file_id}", slug: "api-reference/files/delete-file", reply: "delete-file-response" },
];

export function stepInfo(step: FilesStep): FilesStepInfo {
  return FILES_STEPS.find((s) => s.id === step) ?? FILES_STEPS[0];
}

/** expires_after.seconds runs from an hour to 30 days (File Expires After). */
export const EXPIRES_MIN_SECONDS = 3600;
export const EXPIRES_MAX_SECONDS = 2_592_000;

export function expiresProblem(seconds: number): string | null {
  if (!Number.isInteger(seconds)) return "seconds must be a whole number.";
  if (seconds < EXPIRES_MIN_SECONDS) return `seconds must be at least ${EXPIRES_MIN_SECONDS.toLocaleString("en-US")} (1 hour).`;
  if (seconds > EXPIRES_MAX_SECONDS) return `seconds must be at most ${EXPIRES_MAX_SECONDS.toLocaleString("en-US")} (30 days).`;
  return null;
}

export interface ListQuery {
  /** "" lists every purpose. */
  purpose?: string;
  /** 1 to 10,000; null leaves Meta's default (10,000). */
  limit?: number | null;
  /** "" leaves Meta's default order. */
  order?: "asc" | "desc" | "";
  /** A file id: the page starts after it. */
  after?: string;
}

export function limitProblem(limit: number | null | undefined): string | null {
  if (limit === null || limit === undefined) return null;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) return "limit runs from 1 to 10,000.";
  return null;
}

/** GET /v1/files with the query parameters that are set, in the reference page's order. */
export function listPath(q: ListQuery): string {
  const params = new URLSearchParams();
  if (q.purpose) params.set("purpose", q.purpose);
  if (q.limit !== null && q.limit !== undefined && !limitProblem(q.limit)) params.set("limit", String(q.limit));
  if (q.order) params.set("order", q.order);
  if (q.after?.trim()) params.set("after", q.after.trim());
  const query = params.toString();
  return query ? `files?${query}` : "files";
}

/** The path for a call on one file. The id is encoded, as the proxy expects. */
export function filePath(step: Exclude<FilesStep, "upload" | "list">, fileId: string): string {
  const at = `files/${encodeURIComponent(fileId)}`;
  return step === "content" ? `${at}/content` : at;
}

/** Meta's file ids: "file-" and digits (File Object, "Format is file-<numeric>"). */
export function looksLikeFileId(id: string): boolean {
  return /^file-\d+$/.test(id);
}

/** Unix seconds as a local date and time, or "never" for a file that doesn't expire. */
export function when(seconds: unknown): string {
  return typeof seconds === "number" && seconds > 0 ? new Date(seconds * 1000).toLocaleString("en-US") : "never";
}

export interface ListedFile {
  id: string;
  filename?: string;
  bytes?: number;
  created_at?: number;
  expires_at?: number | null;
  purpose?: string;
  status?: string;
}

/** The files in a ListFilesResponse, ignoring anything that isn't one. */
export function filesOfList(reply: unknown): ListedFile[] {
  const data = reply && typeof reply === "object" ? (reply as { data?: unknown }).data : null;
  return Array.isArray(data) ? data.filter((f): f is ListedFile => !!f && typeof f === "object" && typeof (f as { id?: unknown }).id === "string") : [];
}

/** The cursor for the next page, when the list says there's more. */
export function nextCursor(reply: unknown): string | null {
  if (!reply || typeof reply !== "object") return null;
  const r = reply as { has_more?: unknown; last_id?: unknown };
  return r.has_more === true && typeof r.last_id === "string" && r.last_id ? r.last_id : null;
}
