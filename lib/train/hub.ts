/**
 * The platform's Hugging Face Hub client (docs/TRAINING.md "Hugging Face Hub"), over fetch, following the API in
 * docs/HF_EXPORT_RESEARCH.md: repos/create, preupload, the LFS batch call with the "basic" and "multipart" transfers
 * (presigned storage URLs, never "xet"; the same call says which objects the Hub already stores), the NDJSON commit, a
 * repo's visibility (read and set), the tree read that verifies a commit, and whoami. Its base is HF_ENDPOINT
 * (https://huggingface.co), so tests run it against a fake Hub on localhost.
 *
 * HF_TOKEN is read from the environment inside each call that sends it (env.hfToken), so it is never an argument or a
 * result here, and every error has it blanked out. A presigned upload URL is a credential while it lasts: no error
 * names one, and anything that looks like a signed URL is blanked out of error text too. Each call times out
 * (hubTiming.timeoutMs) and is tried again, a bounded number of times, after a 429, a 5xx, a timeout or a network
 * error, waiting longer each time (or as long as Retry-After asks, up to a cap). Server only.
 */
import { createHash } from "node:crypto";
import { env } from "@/lib/env";

/** A model or a dataset repo, by "<namespace>/<name>". */
export type HubRepoType = "model" | "dataset";

export interface HubRepo {
  type: HubRepoType;
  id: string;
}

/**
 * A Hub call that failed: `status` is the HTTP status (0 for a timeout or a network error), `code` a short word for
 * the cases callers tell apart ("conflict", "timeout", "network", "bad_answer", "missing_object"). The message never has
 * the token or an upload URL in it.
 */
export class HubApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "HubApiError";
  }
}

/**
 * How long a call waits, how many times it is tried again and how long it waits in between (doubling from
 * retryBaseMs, at most retryMaxMs). An upload of a part or a whole file gets uploadTimeoutMs. Tests shorten them.
 */
export const hubTiming = { timeoutMs: 30_000, uploadTimeoutMs: 15 * 60_000, retries: 3, retryBaseMs: 1_000, retryMaxMs: 30_000 };

/** The LFS bridge's transfers the platform asks for. "xet" is never one: its uploads need a Hub token on the uploader. */
export const LFS_TRANSFERS = ["basic", "multipart"] as const;

const LFS_TYPE = "application/vnd.git-lfs+json";
/** The most of an error body kept for the message. */
const ERROR_TEXT_MAX = 300;
/** Tree pages read at most, 1,000 entries each. */
const TREE_PAGES_MAX = 10;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** HF_ENDPOINT, read on each call. */
function endpoint(): string {
  return env.hfEndpoint;
}

/** "Bearer <HF_TOKEN>", read from the environment for this call only. Throws when it isn't set. */
function authorization(): string {
  return `Bearer ${env.hfToken}`;
}

/**
 * Blanks out of `text` the HF token (when it is set) and anything that looks like a signed URL (one with a query
 * string), so neither reaches a log, an event or a job's state.
 */
export function redact(text: string): string {
  const token = process.env.HF_TOKEN?.trim();
  let out = token ? text.split(token).join("[HF token]") : text;
  out = out.replace(/https?:\/\/[^\s"'<>]*\?[^\s"'<>]*/g, "[signed URL]");
  return out;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** "/api/models/<id>" or "/api/datasets/<id>". */
function apiPath(repo: HubRepo): string {
  return `/api/${repo.type}s/${repo.id}`;
}

/** The repo's git path, where the LFS endpoints are: "/<id>.git" or "/datasets/<id>.git". */
function gitPath(repo: HubRepo): string {
  return `${repo.type === "dataset" ? "/datasets" : ""}/${repo.id}.git`;
}

/** The repo's page on the Hub: "<endpoint>/<id>", or "<endpoint>/datasets/<id>". */
export function repoUrl(repo: HubRepo): string {
  return `${endpoint()}${repo.type === "dataset" ? "/datasets" : ""}/${repo.id}`;
}

/** A file's raw content on the Hub, on main. */
export function rawUrl(repo: HubRepo, path: string): string {
  return `${repoUrl(repo)}/raw/main/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** The git blob id of `content` (SHA-1 of "blob <size>\0" and the bytes), which the Hub reports for a regular file. */
export function gitOid(content: Buffer): string {
  return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

/** The lowercase hex SHA-256 of `content`: an LFS oid. */
export function sha256Hex(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** How long to wait before try `attempt` + 1: Retry-After when the Hub sent one (capped), else a doubling backoff. */
function backoff(attempt: number, retryAfter: string | null): number {
  const asked = retryAfter !== null ? Number(retryAfter) : NaN;
  if (Number.isFinite(asked) && asked >= 0) return Math.min(asked * 1000, hubTiming.retryMaxMs);
  return Math.min(hubTiming.retryBaseMs * 2 ** attempt, hubTiming.retryMaxMs);
}

const retryable = (status: number) => status === 429 || status >= 500;

/** The start of an error body: its "error" field when it is JSON with one, else its text. Redacted. */
async function errorText(res: Response): Promise<string> {
  let text = "";
  try {
    text = await res.text();
  } catch {
    return "";
  }
  let said = text;
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown };
    const field = typeof body?.error === "string" ? body.error : typeof body?.message === "string" ? body.message : null;
    if (field) said = field;
  } catch {
    // Not JSON.
  }
  return redact(said.replace(/\s+/g, " ").trim()).slice(0, ERROR_TEXT_MAX);
}

interface CallOptions {
  /** What the call does, for the error message: "creating the repo". */
  what: string;
  method?: string;
  /** A path on HF_ENDPOINT, or an absolute URL (an upload). */
  url: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Sends Authorization: Bearer <HF_TOKEN>. False only for the presigned uploads, which take no Hub credential. */
  auth?: boolean;
  /** Statuses the caller handles itself, returned rather than thrown. */
  accept?: number[];
  timeoutMs?: number;
}

/**
 * One call with its retries: a 429, a 5xx, a timeout or a network error is tried again up to hubTiming.retries times.
 * Returns the response when it is 2xx or one of `accept`; anything else throws HubApiError with a redacted message.
 * An upload's URL never goes into the message.
 */
async function call(opts: CallOptions): Promise<Response> {
  const absolute = /^https?:\/\//.test(opts.url);
  const url = absolute ? opts.url : `${endpoint()}${opts.url}`;
  const where = absolute ? "" : ` (${opts.method ?? "GET"} ${opts.url.split("?")[0]})`;
  for (let attempt = 0; ; attempt++) {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.auth !== false) headers.authorization = authorization();
    let res: Response;
    try {
      res = await fetch(url, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body as BodyInit | undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(opts.timeoutMs ?? hubTiming.timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      if (attempt < hubTiming.retries) {
        await wait(backoff(attempt, null));
        continue;
      }
      const why = timedOut ? "it timed out" : `the network failed (${redact(messageOf(err)).slice(0, ERROR_TEXT_MAX)})`;
      throw new HubApiError(0, timedOut ? "timeout" : "network", `Hugging Face: ${opts.what} failed${where}: ${why}.`);
    }
    if (res.ok || opts.accept?.includes(res.status)) return res;
    if (retryable(res.status) && attempt < hubTiming.retries) {
      await res.body?.cancel().catch(() => undefined);
      await wait(backoff(attempt, res.headers.get("retry-after")));
      continue;
    }
    const said = await errorText(res);
    throw new HubApiError(res.status, null, `Hugging Face: ${opts.what} failed${where}: HTTP ${res.status}${said ? `, ${said}` : ""}.`);
  }
}

/** A JSON answer, or HubApiError("bad_answer") when it isn't JSON. */
async function jsonOf<T>(res: Response, what: string): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new HubApiError(res.status, "bad_answer", `Hugging Face: ${what} answered something that isn't JSON.`);
  }
}

function jsonCall(what: string, method: string, url: string, body: unknown, extra: Partial<CallOptions> = {}): Promise<Response> {
  return call({ what, method, url, headers: { "content-type": "application/json", ...extra.headers }, body: JSON.stringify(body), ...extra });
}

/** "<namespace>/<name>" split in two. */
function parts(id: string): [string, string] {
  const at = id.indexOf("/");
  return [id.slice(0, at), id.slice(at + 1)];
}

// ---------------------------------------------------------------------------------------------------------------
// Account and repos

/** Who the token is, and the organizations it belongs to (GET /api/whoami-v2). */
export async function whoami(): Promise<{ name: string; orgs: string[] }> {
  const res = await call({ what: "checking the token", url: "/api/whoami-v2" });
  const body = await jsonOf<{ name?: unknown; orgs?: unknown }>(res, "whoami");
  const orgs = Array.isArray(body.orgs)
    ? body.orgs.map((o) => (o && typeof o === "object" ? (o as { name?: unknown }).name : null)).filter((n): n is string => typeof n === "string")
    : [];
  return { name: typeof body.name === "string" ? body.name : "", orgs };
}

/**
 * Makes the repo, private, with the given license. A 409 that says it exists is fine (`created` false); a 409 for a
 * conflicting operation in progress (repos made at the same moment in one namespace) is tried again, a few times.
 */
export async function createRepo(repo: HubRepo, opts: { license?: string } = {}): Promise<{ created: boolean; url: string }> {
  const [organization, name] = parts(repo.id);
  for (let attempt = 0; ; attempt++) {
    const res = await jsonCall(
      "creating the repo",
      "POST",
      "/api/repos/create",
      { type: repo.type, name, organization, visibility: "private", ...(opts.license ? { license: opts.license } : {}) },
      { accept: [409] },
    );
    if (res.status !== 409) {
      const body = await jsonOf<{ url?: unknown }>(res, "creating the repo");
      return { created: true, url: typeof body.url === "string" ? body.url : repoUrl(repo) };
    }
    const said = await errorText(res.clone());
    const body = await res.json().catch(() => ({}) as { url?: unknown });
    if (/conflicting operation/i.test(said)) {
      if (attempt < hubTiming.retries) {
        await wait(backoff(attempt, res.headers.get("retry-after")));
        continue;
      }
      throw new HubApiError(409, "conflict", `Hugging Face: creating ${repo.id} failed: another operation on it is still in progress.`);
    }
    return { created: false, url: typeof body.url === "string" ? body.url : repoUrl(repo) };
  }
}

/** A repo's visibility on the Hub. */
export type HubVisibility = "public" | "private";

/** Sets a repo public or private (PUT .../settings {visibility}). */
export async function setVisibility(repo: HubRepo, visibility: HubVisibility): Promise<void> {
  await jsonCall(`making ${repo.id} ${visibility}`, "PUT", `${apiPath(repo)}/settings`, { visibility });
}

/** Whether a repo is public or private on the Hub now (GET /api/models/<id> or /api/datasets/<id>, its "private"). */
export async function repoVisibility(repo: HubRepo): Promise<HubVisibility> {
  const res = await call({ what: `reading ${repo.id}`, url: apiPath(repo) });
  const body = await jsonOf<{ private?: unknown }>(res, "the repo's info");
  if (typeof body.private !== "boolean") {
    throw new HubApiError(res.status, "bad_answer", `Hugging Face: ${repo.id}'s info doesn't say whether it is private.`);
  }
  return body.private ? "private" : "public";
}

// ---------------------------------------------------------------------------------------------------------------
// Uploads

/** What the Hub's preupload says about one file: stored as LFS or as a regular file, ignored, and its oid when it has it. */
export interface PreuploadAnswer {
  path: string;
  uploadMode: "lfs" | "regular";
  shouldIgnore: boolean;
  /** The blob it already has at that path: the git oid of a regular file, the LFS oid of an LFS one. */
  oid: string | null;
}

/**
 * Asks how each file is to be uploaded (POST .../preupload/main): `sample` is the base64 of its first 512 bytes. Files
 * the Hub doesn't answer for count as LFS.
 */
export async function preupload(repo: HubRepo, files: Array<{ path: string; size: number; sample: string }>): Promise<PreuploadAnswer[]> {
  if (!files.length) return [];
  const res = await jsonCall("checking how to upload the files", "POST", `${apiPath(repo)}/preupload/main`, { files });
  const body = await jsonOf<{ files?: unknown }>(res, "preupload");
  const answers = new Map<string, PreuploadAnswer>();
  for (const raw of Array.isArray(body.files) ? body.files : []) {
    const f = raw as { path?: unknown; uploadMode?: unknown; shouldIgnore?: unknown; oid?: unknown };
    if (typeof f.path !== "string") continue;
    answers.set(f.path, {
      path: f.path,
      uploadMode: f.uploadMode === "regular" ? "regular" : "lfs",
      shouldIgnore: f.shouldIgnore === true,
      oid: typeof f.oid === "string" ? f.oid : null,
    });
  }
  return files.map((f) => answers.get(f.path) ?? { path: f.path, uploadMode: "lfs", shouldIgnore: false, oid: null });
}

/**
 * How one object is to be uploaded, from the LFS batch answer: "none" when the Hub already has it; "basic", one PUT of
 * the whole file to `href` with `header`; "multipart", a PUT of each chunk of `chunkSize` bytes to its part's URL,
 * then a POST to `completionUrl`; or the error the Hub gave for it. The URLs are presigned: never log or store them.
 */
export type LfsAction =
  | { oid: string; size: number; kind: "none" }
  | { oid: string; size: number; kind: "basic"; href: string; header: Record<string, string> }
  | { oid: string; size: number; kind: "multipart"; chunkSize: number; parts: Array<{ partNumber: number; url: string }>; completionUrl: string }
  | { oid: string; size: number; kind: "error"; error: string };

/** Header names the upload actions may carry on to the uploader. A Hub credential never does. */
function plainHeaders(header: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(header)) {
    if (typeof v !== "string" || k === "chunk_size" || /^\d+$/.test(k) || /^(authorization|cookie)$/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** One object of the batch answer as an LfsAction. */
function lfsActionOf(raw: unknown, asked: Map<string, number>): LfsAction | null {
  const o = raw as { oid?: unknown; size?: unknown; actions?: unknown; error?: unknown } | null;
  if (!o || typeof o.oid !== "string" || !asked.has(o.oid)) return null;
  const size = asked.get(o.oid)!;
  if (o.error) {
    const e = o.error as { message?: unknown; code?: unknown };
    const said = typeof e.message === "string" ? e.message : "the Hub refused it";
    return { oid: o.oid, size, kind: "error", error: redact(said).slice(0, ERROR_TEXT_MAX) };
  }
  const upload = (o.actions as { upload?: unknown } | undefined)?.upload as { href?: unknown; header?: unknown } | undefined;
  if (!upload) return { oid: o.oid, size, kind: "none" };
  if (typeof upload.href !== "string" || !/^https?:\/\//.test(upload.href)) {
    return { oid: o.oid, size, kind: "error", error: "The Hub gave no upload URL for it." };
  }
  const header = upload.header && typeof upload.header === "object" ? (upload.header as Record<string, unknown>) : {};
  if (header.chunk_size === undefined) return { oid: o.oid, size, kind: "basic", href: upload.href, header: plainHeaders(header) };
  const chunkSize = Number(header.chunk_size);
  const urls = Object.entries(header)
    .filter(([k, v]) => /^\d+$/.test(k) && typeof v === "string")
    .map(([k, v]) => ({ partNumber: Number.parseInt(k, 10), url: v as string }))
    .sort((a, b) => a.partNumber - b.partNumber);
  const wanted = chunkSize > 0 ? Math.ceil(size / chunkSize) : NaN;
  if (!Number.isInteger(chunkSize) || chunkSize <= 0 || urls.length !== wanted || urls.some((p, i) => p.partNumber !== i + 1)) {
    return { oid: o.oid, size, kind: "error", error: "The Hub's multipart plan doesn't cover the file." };
  }
  return { oid: o.oid, size, kind: "multipart", chunkSize, parts: urls, completionUrl: upload.href };
}

/**
 * Asks the LFS bridge how to upload these objects (POST <repo>.git/info/lfs/objects/batch), with the transfers
 * ["basic", "multipart"] only, so every upload goes to a presigned URL that takes no Hub credential. The repo must
 * exist. One action per object asked for, in that order. An object the Hub already stores comes back "none": this is
 * how the platform checks, before it commits, that the objects a GPU uploaded are there (git-lfs reads it the same way).
 */
export async function lfsBatch(repo: HubRepo, objects: Array<{ oid: string; size: number }>): Promise<LfsAction[]> {
  if (!objects.length) return [];
  const res = await call({
    what: "asking where to upload the files",
    method: "POST",
    url: `${gitPath(repo)}/info/lfs/objects/batch`,
    headers: { accept: LFS_TYPE, "content-type": LFS_TYPE },
    body: JSON.stringify({ operation: "upload", transfers: [...LFS_TRANSFERS], hash_algo: "sha256", ref: { name: "main" }, objects }),
  });
  const body = await jsonOf<{ objects?: unknown }>(res, "the LFS batch");
  const asked = new Map(objects.map((o) => [o.oid, o.size]));
  const actions = new Map<string, LfsAction>();
  for (const raw of Array.isArray(body.objects) ? body.objects : []) {
    const action = lfsActionOf(raw, asked);
    if (action) actions.set(action.oid, action);
  }
  return objects.map(
    (o) => actions.get(o.oid) ?? { oid: o.oid, size: o.size, kind: "error", error: "The Hub's answer left this file out." },
  );
}

/**
 * Uploads bytes the platform holds itself (a dataset file, or a small file the Hub stores as LFS) along an action from
 * lfsBatch: nothing for "none", one PUT for "basic", each part then the completion for "multipart". None of these
 * calls carry the HF token. Throws HubApiError for an "error" action or a failed upload, never naming the URL.
 */
export async function uploadLfs(action: LfsAction, content: Buffer): Promise<void> {
  if (action.kind === "none") return;
  if (action.kind === "error") throw new HubApiError(0, "refused", `Hugging Face refused the upload: ${action.error}`);
  if (content.length !== action.size) throw new HubApiError(0, "bad_answer", "The upload's size doesn't match the file.");
  if (action.kind === "basic") {
    await call({
      what: "uploading a file",
      method: "PUT",
      url: action.href,
      headers: action.header,
      body: content,
      auth: false,
      timeoutMs: hubTiming.uploadTimeoutMs,
    });
    return;
  }
  const etags: Array<{ partNumber: number; etag: string }> = [];
  for (const part of action.parts) {
    const res = await call({
      what: `uploading part ${part.partNumber} of a file`,
      method: "PUT",
      url: part.url,
      body: content.subarray((part.partNumber - 1) * action.chunkSize, part.partNumber * action.chunkSize),
      auth: false,
      timeoutMs: hubTiming.uploadTimeoutMs,
    });
    const etag = res.headers.get("etag");
    await res.body?.cancel().catch(() => undefined);
    if (!etag) throw new HubApiError(res.status, "bad_answer", `Hugging Face: part ${part.partNumber} of a file came back with no ETag.`);
    etags.push({ partNumber: part.partNumber, etag });
  }
  await call({
    what: "completing a multipart upload",
    method: "POST",
    url: action.completionUrl,
    headers: { accept: LFS_TYPE, "content-type": LFS_TYPE },
    body: JSON.stringify({ oid: action.oid, parts: etags }),
    auth: false,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Commits and reads

/** A commit's operations: files written whole, and LFS objects already in the repo's storage, by oid. */
export interface CommitInput {
  summary: string;
  description?: string;
  files: Array<{ path: string; content: Buffer }>;
  lfsFiles: Array<{ path: string; oid: string; size: number }>;
}

/** The NDJSON body of a commit: a header line, then a "file" line for each file and an "lfsFile" line for each object. */
export function commitBody(input: CommitInput): string {
  const lines: unknown[] = [{ key: "header", value: { summary: input.summary, description: input.description ?? "" } }];
  for (const f of input.files) {
    lines.push({ key: "file", value: { path: f.path, content: f.content.toString("base64"), encoding: "base64" } });
  }
  for (const f of input.lfsFiles) {
    lines.push({ key: "lfsFile", value: { path: f.path, algo: "sha256", oid: f.oid, size: f.size } });
  }
  return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

/**
 * Commits to main (POST .../commit/main, NDJSON) and returns the commit's oid and page. The Hub adds the LFS paths to
 * .gitattributes itself. Keep a commit to about 100 files: the Hub gives up on one after 60 s.
 */
export async function commit(repo: HubRepo, input: CommitInput): Promise<{ commitOid: string; commitUrl: string | null }> {
  const res = await call({
    what: `committing to ${repo.id}`,
    method: "POST",
    url: `${apiPath(repo)}/commit/main`,
    headers: { "content-type": "application/x-ndjson" },
    body: commitBody(input),
    timeoutMs: Math.max(hubTiming.timeoutMs, 90_000),
  });
  const body = await jsonOf<{ success?: unknown; commitOid?: unknown; commitUrl?: unknown }>(res, "the commit");
  if (body.success === false || typeof body.commitOid !== "string") {
    throw new HubApiError(res.status, "bad_answer", `Hugging Face: the commit to ${repo.id} didn't say it succeeded.`);
  }
  return { commitOid: body.commitOid, commitUrl: typeof body.commitUrl === "string" ? body.commitUrl : null };
}

/** A file on main, as the tree read lists it: the git oid, the size, and the LFS oid of an LFS file. */
export interface HubTreeFile {
  path: string;
  size: number;
  oid: string;
  lfsOid: string | null;
}

/** The URL of the next page from a Link header, when there is one on the Hub. */
function nextPage(link: string | null): string | null {
  const m = link?.match(/<([^>]+)>\s*;\s*rel="?next"?/);
  if (!m) return null;
  try {
    const u = new URL(m[1]!, endpoint());
    return u.origin === new URL(endpoint()).origin ? `${u.pathname}${u.search}` : null;
  } catch {
    return null;
  }
}

/** Every file on the repo's main branch (GET .../tree/main?recursive=true, following the pages). */
export async function listFiles(repo: HubRepo): Promise<HubTreeFile[]> {
  const out: HubTreeFile[] = [];
  let url: string | null = `${apiPath(repo)}/tree/main?recursive=true`;
  for (let page = 0; url && page < TREE_PAGES_MAX; page++) {
    const res = await call({ what: `reading ${repo.id}`, url });
    const body = await jsonOf<unknown>(res, "the tree");
    for (const raw of Array.isArray(body) ? body : []) {
      const e = raw as { type?: unknown; path?: unknown; size?: unknown; oid?: unknown; lfs?: { oid?: unknown } | null };
      if (e.type !== "file" || typeof e.path !== "string") continue;
      out.push({
        path: e.path,
        size: typeof e.size === "number" ? e.size : -1,
        oid: typeof e.oid === "string" ? e.oid : "",
        lfsOid: typeof e.lfs?.oid === "string" ? e.lfs.oid : null,
      });
    }
    url = nextPage(res.headers.get("link"));
  }
  return out;
}

/** What a commit should have left on main: a file's size, and its LFS oid or its git oid. */
export interface ExpectedFile {
  path: string;
  size: number;
  lfsOid?: string;
  gitOid?: string;
}

/**
 * Reads the repo's tree and checks that every expected file is there with its size, and the LFS oid (or git oid) it was
 * committed with. Returns what doesn't match, as plain sentences, or an empty list.
 */
export async function verifyFiles(repo: HubRepo, expected: ExpectedFile[]): Promise<string[]> {
  const files = new Map((await listFiles(repo)).map((f) => [f.path, f]));
  const problems: string[] = [];
  for (const want of expected) {
    const got = files.get(want.path);
    if (!got) {
      problems.push(`${want.path} isn't in ${repo.id}.`);
      continue;
    }
    if (got.size !== want.size) problems.push(`${want.path} in ${repo.id} is ${got.size} bytes, not ${want.size}.`);
    if (want.lfsOid && got.lfsOid !== want.lfsOid) problems.push(`${want.path} in ${repo.id} isn't the LFS object that was uploaded.`);
    if (want.gitOid && !want.lfsOid && got.oid !== want.gitOid && got.lfsOid === null) {
      problems.push(`${want.path} in ${repo.id} isn't the file that was committed.`);
    }
  }
  return problems;
}

/**
 * The text of a public file on the Hub, such as the base model's LICENSE, read without the HF token. At most
 * `maxBytes`; anything larger, or an error, throws.
 */
export async function fetchPublicText(url: string, maxBytes = 256 * 1024): Promise<string> {
  const res = await call({ what: "reading a public file", url, auth: false });
  const text = await res.text();
  if (Buffer.byteLength(text) > maxBytes) throw new HubApiError(res.status, "bad_answer", "Hugging Face: that public file is too large.");
  return text;
}
