import { createHash } from "node:crypto";
import { Sandbox } from "@vercel/sandbox";
import { FatalError } from "workflow";
import { env } from "@/lib/env";
import { MCP_FILE, MUSE_FULL_MARKER } from "@/lib/sandbox/muse-config";
import { FIX_SCREENSHOTS_DIR, OUT_DIR, PEEK_DIR, PRODUCT_DIR, RUN_DIR } from "@/lib/sandbox/paths";
import { q, sh } from "@/lib/sandbox/shell";

/**
 * CONTRACT (owned by the sandbox agent). The platform, never the sandbox, talks to Vercel.
 *
 * Plain REST calls to https://api.vercel.com with VERCEL_TOKEN, scoped to VERCEL_TEAM_ID:
 *   POST /v11/projects, GET and PATCH /v9/projects/{id}, POST /v10/projects/{id}/env?upsert=true,
 *   POST /v2/files (SHA-1 digest), POST /v13/deployments, GET /v13/deployments/{id}, GET /v9/projects/{id}/domains.
 */

const API = "https://api.vercel.com";
/**
 * The biggest source file a deployment takes. Vercel's limits page says "the maximum size of the source files that can
 * be uploaded is limited to 100 MB for Hobby and 1 GB for Pro" (vercel.com/docs/limits, read Oct 31, 2026), which may
 * mean each file or all of them together, so the platform holds both to the lower number: no file over this, and no
 * more than deployTotalLimitBytes() in all. A product over either fails the deploy by name (DeployFilesTooBigError).
 * Before wave 3 the limit here was 10 MB and bigger files were left out without a word, which broke products with wasm
 * or model files (unit 1, decision 1). One real API deploy has to confirm the reading (docs/CAPABILITIES.md, 7a).
 */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

/**
 * The most one deployment's files may add up to: TRUST_DEPLOY_TOTAL_MB, 100 by default (Vercel's Hobby number above).
 * It also bounds memory, since the deploy step holds every file at once. Raise it on a Pro team.
 */
export function deployTotalLimitBytes(): number {
  return env.trustDeployTotalMb * 1024 * 1024;
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/**
 * A product with files Vercel won't take: one over MAX_FILE_BYTES, or all of them over deployTotalLimitBytes() (then
 * `total` is set and `files` lists the biggest first). Fatal: retrying the step can't make them smaller.
 */
export class DeployFilesTooBigError extends FatalError {
  constructor(
    readonly files: ReadonlyArray<{ file: string; size: number }>,
    readonly total: { bytes: number; limit: number } | null = null,
  ) {
    const list = files.slice(0, 5).map((f) => `${f.file} (${mb(f.size)})`).join(", ");
    const more = files.length > 5 ? ` and ${files.length - 5} more` : "";
    super(
      total
        ? `The product's files add up to ${mb(total.bytes)}, over the ${mb(total.limit)} one deployment takes, so it wasn't deployed. The biggest: ${list}${more}. ` +
            "Load big files from a public URL at run time, or make them smaller."
        : `The product has ${files.length === 1 ? "a file" : "files"} over Vercel's ${mb(MAX_FILE_BYTES)} limit for one file, so it wasn't deployed: ${list}${more}. ` +
            "Load big files from a public URL at run time, or split them.",
    );
  }
}
/**
 * Never deployed: dependencies, build and test output, the user's inspo, fix-round screenshots, VR peeks, git, Muse Code's own
 * folder (the platform's hooks and its subagents' worktrees, lib/sandbox/muse-config.ts), and any env file.
 */
export const DEPLOY_EXCLUDE_DIRS = [
  "node_modules",
  ".next",
  "test-results",
  "playwright-report",
  "inspo",
  FIX_SCREENSHOTS_DIR,
  PEEK_DIR,
  ".git",
  ".vercel",
  ".muse",
] as const;

export interface StartDeployInput {
  sandboxName: string;
  slug: string;
  productName: string;
  /** Set on the project as encrypted env vars: GATEWAY_URL and PRODUCT_TOKEN (the live token). */
  env: Record<string, string>;
  /** Reuse the product's project on redeploys. */
  projectId?: string | null;
  /** Given the exact files once they're known to deploy (docs/VERSIONS.md). Must not throw. */
  onFiles?: (files: Array<DeployFile & { content: Buffer }>) => Promise<unknown>;
  /**
   * Called with the files before anything is set or deployed. It throws (a FatalError) to stop the deploy, which is how
   * a shared key's value in the product's files stops it (docs/BUILD_KEYS.md).
   */
  checkFiles?: (files: ReadonlyArray<DeployFile & { content: Buffer }>) => void;
  /**
   * BUILD_SHARED_KEYS (docs/BUILD_KEYS.md): the owner's shared keys to set on the project as sensitive vars, and the
   * names to take off it. Absent with the flag off, so the project's env is handled exactly as before.
   */
  sharedEnv?: SharedEnvSync;
}

/** The shared vars a deploy sets, and the shared names it removes when this build may not have them. */
export interface SharedEnvSync {
  set: Readonly<Record<string, string>>;
  remove: readonly string[];
}

/** What a shared var says in the project's env list, so a person reading it there knows where it came from. */
export const SHARED_ENV_COMMENT = "Muse Muse shared account key (docs/BUILD_KEYS.md). Removed by scripts/keys/revoke-shared.ts.";

export class VercelApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly body: unknown,
    what: string,
  ) {
    const message = (body as { error?: { message?: string } } | null)?.error?.message;
    super(`Vercel API ${what} failed (${status}${code ? ` ${code}` : ""})${message ? `: ${message}` : ""}`);
  }
}

async function vercel<T>(method: string, path: string, opts: { body?: unknown; query?: Record<string, string> } = {}): Promise<T> {
  const url = new URL(path, API);
  if (env.vercelTeamId) url.searchParams.set("teamId", env.vercelTeamId);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${env.vercelToken}`, "Content-Type": "application/json" },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { error: { message: text.slice(0, 300) } };
  }
  if (!res.ok) {
    const code = (json as { error?: { code?: string } } | null)?.error?.code ?? null;
    throw new VercelApiError(res.status, code, json, `${method} ${path}`);
  }
  return json as T;
}

export function projectNameFor(slug: string): string {
  const clean = slug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!clean) throw new Error(`Invalid product slug: ${slug}`);
  return `musemuse-${clean}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Files out of the sandbox

export interface DeployFile {
  file: string;
  sha: string;
  size: number;
}

/**
 * Runs in the sandbox with Node: walks PRODUCT_DIR, skips excluded dirs, env files and symlinks, lists files over
 * MAX_FILE_BYTES as `skipped` (collectDeployFiles fails the deploy naming them), and writes every kept file into one
 * blob plus an index, so the platform reads the whole tree in one request.
 */
export const COLLECT_SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const [root, outDir, maxBytes, ...excludeDirs] = process.argv.slice(2);
const skipDirs = new Set(excludeDirs);
const files = [];
const skipped = [];
function walk(rel) {
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const child = rel ? rel + "/" + e.name : e.name;
    if (e.isDirectory()) { if (!skipDirs.has(e.name)) walk(child); continue; }
    if (!e.isFile()) continue;
    if (e.name.startsWith(".env") || e.name.endsWith(".tsbuildinfo") || e.name === ".DS_Store") continue;
    const size = fs.statSync(path.join(root, child)).size;
    if (size > Number(maxBytes)) { skipped.push({ file: child, size }); continue; }
    files.push(child);
  }
}
walk("");
files.sort();
fs.mkdirSync(outDir, { recursive: true });
const fd = fs.openSync(path.join(outDir, "files.bin"), "w");
const index = [];
for (const file of files) {
  const buf = fs.readFileSync(path.join(root, file));
  fs.writeSync(fd, buf);
  index.push({ file, size: buf.length, sha: crypto.createHash("sha1").update(buf).digest("hex") });
}
fs.closeSync(fd);
fs.writeFileSync(path.join(outDir, "files.json"), JSON.stringify({ files: index, skipped }));
console.log(JSON.stringify({ count: index.length, bytes: index.reduce((s, f) => s + f.size, 0), skipped: skipped.length }));
`;

/**
 * Reads the deployable source out of a product sandbox. Each file's SHA-1 is checked after the transfer. In a sandbox
 * that has the platform's Muse Code config (MUSE_FULL_MARKER), .mcp.json is the platform's, so it goes first: the next
 * start writes it again. A product's own .mcp.json still deploys with MUSE_FULL off. The index is read first, so a
 * product with a file over MAX_FILE_BYTES, or more than deployTotalLimitBytes() in all, fails by name
 * (DeployFilesTooBigError) before its files are read into memory.
 */
export async function collectDeployFiles(sandboxName: string): Promise<{ files: Array<DeployFile & { content: Buffer }> }> {
  const sandbox = await Sandbox.get({ name: sandboxName, resume: true });
  const outDir = `${OUT_DIR}/deploy`;
  const script = `${RUN_DIR}/collect-deploy.cjs`;
  await sandbox.writeFiles([{ path: script, content: COLLECT_SCRIPT }]);
  const collect = `rm -rf ${q(outDir)} && node ${q(script)} ${[PRODUCT_DIR, outDir, String(MAX_FILE_BYTES), ...DEPLOY_EXCLUDE_DIRS].map(q).join(" ")}`;
  await sh(sandbox, `if [ -f ${q(MUSE_FULL_MARKER)} ]; then rm -f -- ${q(`${PRODUCT_DIR}/${MCP_FILE}`)}; fi\n${collect}`, { timeoutMs: 50_000 });
  const indexBuf = await sandbox.readFileToBuffer({ path: `${outDir}/files.json` });
  if (!indexBuf) throw new Error("Could not read the collected files from the sandbox");
  const index = JSON.parse(indexBuf.toString("utf8")) as { files: DeployFile[]; skipped: Array<{ file: string; size: number }> };
  // Every file deploys, or the deploy fails naming the ones that can't: never a product with files silently missing.
  if (index.skipped.length) throw new DeployFilesTooBigError(index.skipped);
  const bytes = index.files.reduce((sum, f) => sum + f.size, 0);
  const limit = deployTotalLimitBytes();
  if (bytes > limit) throw new DeployFilesTooBigError([...index.files].sort((a, b) => b.size - a.size), { bytes, limit });
  const blob = await sandbox.readFileToBuffer({ path: `${outDir}/files.bin` });
  if (!blob) throw new Error("Could not read the collected files from the sandbox");

  let at = 0;
  const files = index.files.map((f) => {
    const content = blob.subarray(at, at + f.size);
    at += f.size;
    const sha = createHash("sha1").update(content).digest("hex");
    if (sha !== f.sha) throw new Error(`File changed in transfer: ${f.file}`);
    return { ...f, content };
  });
  if (at !== blob.length) throw new Error(`Collected ${blob.length} bytes but the index lists ${at}`);
  return { files };
}

async function uploadFiles(files: Array<DeployFile & { content: Buffer }>, only?: Set<string>): Promise<void> {
  const queue = files.filter((f) => !only || only.has(f.sha));
  const seen = new Set<string>();
  const worker = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      if (seen.has(f.sha)) continue;
      seen.add(f.sha);
      const url = new URL("/v2/files", API);
      if (env.vercelTeamId) url.searchParams.set("teamId", env.vercelTeamId);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.vercelToken}`,
          "Content-Type": "application/octet-stream",
          "x-vercel-digest": f.sha,
          "Content-Length": String(f.size),
        },
        // A view of the collected blob, not a copy: up to 8 uploads run at once, and a file may be 100 MB.
        body: new Uint8Array(f.content.buffer as ArrayBuffer, f.content.byteOffset, f.content.byteLength),
      });
      if (!res.ok) throw new VercelApiError(res.status, null, await res.json().catch(() => null), `upload ${f.file}`);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
}

// ---------------------------------------------------------------------------------------------------------------
// Project

interface Project {
  id: string;
  name: string;
}

async function getOrCreateProject(name: string, projectId?: string | null): Promise<Project> {
  for (const idOrName of [projectId, name]) {
    if (!idOrName) continue;
    try {
      return await vercel<Project>("GET", `/v9/projects/${encodeURIComponent(idOrName)}`);
    } catch (err) {
      if (!(err instanceof VercelApiError && err.status === 404)) throw err;
    }
  }
  try {
    return await vercel<Project>("POST", "/v11/projects", { body: { name, framework: "nextjs" } });
  } catch (err) {
    // Another attempt created it first.
    if (err instanceof VercelApiError && err.status === 409) return vercel<Project>("GET", `/v9/projects/${encodeURIComponent(name)}`);
    throw err;
  }
}

async function configureProject(project: Project, vars: Record<string, string>, shared?: SharedEnvSync): Promise<void> {
  // Products are public: no Vercel Authentication and no password on any deployment.
  await vercel("PATCH", `/v9/projects/${project.id}`, { body: { framework: "nextjs", ssoProtection: null, passwordProtection: null } });
  const entries = Object.entries(vars);
  if (entries.length) {
    await vercel("POST", `/v10/projects/${project.id}/env`, {
      query: { upsert: "true" },
      body: entries.map(([key, value]) => ({ key, value, type: "encrypted", target: ["production", "preview"] })),
    });
  }
  if (shared) await syncSharedEnv(project.id, shared, vars);
}

/**
 * Sets the shared keys as sensitive vars, which nobody can read back from Vercel, and deletes every shared name this
 * build may not have, so a change that lost a key, or was asked for by someone who may not use them, takes it out of the
 * live product. A platform var of the same name always wins. Only names travel in errors, never a value.
 */
export async function syncSharedEnv(projectId: string, shared: SharedEnvSync, platformVars: Readonly<Record<string, string>> = {}): Promise<void> {
  const set = Object.entries(shared.set).filter(([k]) => !(k in platformVars));
  if (set.length) {
    await vercel("POST", `/v10/projects/${projectId}/env`, {
      query: { upsert: "true" },
      body: set.map(([key, value]) => ({ key, value, type: "sensitive", target: ["production", "preview"], comment: SHARED_ENV_COMMENT })),
    });
  }
  const remove = new Set(shared.remove.filter((k) => !(k in shared.set) && !(k in platformVars)));
  if (!remove.size) return;
  const listed = await vercel<{ envs?: Array<{ id: string; key: string }> }>("GET", `/v9/projects/${projectId}/env`);
  for (const e of listed.envs ?? []) {
    if (remove.has(e.key)) await vercel("DELETE", `/v9/projects/${projectId}/env/${encodeURIComponent(e.id)}`);
  }
}

/** The project's stable production URL: its .vercel.app domain, or the name-based default. */
async function productionUrl(projectId: string, fallbackName: string): Promise<string> {
  try {
    const res = await vercel<{ domains?: Array<{ name: string }> }>("GET", `/v9/projects/${projectId}/domains`, { query: { production: "true" } });
    const names = (res.domains ?? []).map((d) => d.name);
    const pick = names.filter((n) => n.endsWith(".vercel.app")).sort((a, b) => a.length - b.length)[0] ?? names[0];
    if (pick) return `https://${pick}`;
  } catch {
    // Fall through to the default.
  }
  return `https://${fallbackName}.vercel.app`;
}

/**
 * Reads the product's source out of the sandbox (no node_modules, .next, test-results, inspo or .env files), creates
 * or reuses the Vercel project `musemuse-<slug>` (framework nextjs, no deployment protection on production), sets the
 * env vars, and creates a production deployment from the files so Vercel builds it. Returns immediately.
 */
export async function startDeployFromSandbox(
  input: StartDeployInput,
): Promise<{ projectId: string; deploymentId: string; url: string }> {
  const name = projectNameFor(input.slug);
  // collectDeployFiles fails the deploy by name when a file, or all of them together, is too big (DeployFilesTooBigError).
  const [{ files }, project] = await Promise.all([collectDeployFiles(input.sandboxName), getOrCreateProject(name, input.projectId)]);
  if (!files.some((f) => f.file === "package.json")) throw new Error("The product has no package.json to deploy");
  input.checkFiles?.(files);
  await configureProject(project, input.env, input.sharedEnv);
  await input.onFiles?.(files);

  const body = {
    name: project.name,
    project: project.id,
    target: "production",
    files: files.map(({ file, sha, size }) => ({ file, sha, size })),
    projectSettings: { framework: "nextjs" },
    meta: { musemuseSlug: input.slug, musemuseProduct: input.productName.slice(0, 200) },
  };
  const create = () =>
    vercel<{ id: string; url: string }>("POST", "/v13/deployments", { body, query: { skipAutoDetectionConfirmation: "1" } });
  let deployment: { id: string; url: string };
  try {
    deployment = await create();
  } catch (err) {
    // Vercel answers missing_files with the digests it doesn't have yet. Upload those (or everything) and retry once.
    if (!(err instanceof VercelApiError && err.code === "missing_files")) throw err;
    const missing = (err.body as { error?: { missing?: string[] } } | null)?.error?.missing;
    await uploadFiles(files, missing?.length ? new Set(missing) : undefined);
    deployment = await create();
  }
  return { projectId: project.id, deploymentId: deployment.id, url: await productionUrl(project.id, project.name) };
}

export interface DeployPoll {
  state: "QUEUED" | "BUILDING" | "INITIALIZING" | "READY" | "ERROR" | "CANCELED";
  /** The stable production URL (https://musemuse-<slug>.vercel.app or the project's production alias). */
  url: string;
  errorMessage?: string;
}

const STATES = new Set<DeployPoll["state"]>(["QUEUED", "BUILDING", "INITIALIZING", "READY", "ERROR", "CANCELED"]);

interface Deployment {
  id: string;
  url: string;
  name: string;
  projectId?: string;
  readyState?: string;
  alias?: string[];
  errorMessage?: string | null;
  errorCode?: string | null;
}

/** The last lines of the build log, for a failed deployment's error message. */
async function buildLogTail(deploymentId: string): Promise<string> {
  try {
    const events = await vercel<Array<{ type?: string; text?: string; payload?: { text?: string } }>>(
      "GET",
      `/v3/deployments/${deploymentId}/events`,
      { query: { direction: "backward", limit: "40" } },
    );
    return (Array.isArray(events) ? events : [])
      .map((e) => e.text ?? e.payload?.text ?? "")
      .filter(Boolean)
      .reverse()
      .join("\n")
      .slice(-3000);
  } catch {
    return "";
  }
}

export async function pollDeploy(deploymentId: string): Promise<DeployPoll> {
  const d = await vercel<Deployment>("GET", `/v13/deployments/${deploymentId}`);
  const raw = (d.readyState ?? "QUEUED").toUpperCase() as DeployPoll["state"];
  const state: DeployPoll["state"] = STATES.has(raw) ? raw : "BUILDING";
  const aliases = (d.alias ?? []).filter((a) => a.endsWith(".vercel.app")).sort((a, b) => a.length - b.length);
  const url = aliases[0] ? `https://${aliases[0]}` : d.projectId ? await productionUrl(d.projectId, d.name) : `https://${d.url}`;
  if (state !== "ERROR" && state !== "CANCELED") return { state, url };
  const log = state === "ERROR" ? await buildLogTail(deploymentId) : "";
  const base = d.errorMessage || d.errorCode || (state === "CANCELED" ? "The deployment was canceled" : "The deployment failed");
  return { state, url, errorMessage: log ? `${base}\n${log}` : base };
}
