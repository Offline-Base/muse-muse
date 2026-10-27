import { createHash } from "node:crypto";
import { Sandbox } from "@vercel/sandbox";
import { env } from "@/lib/env";
import { OUT_DIR, PRODUCT_DIR, RUN_DIR } from "@/lib/sandbox/paths";
import { q, sh } from "@/lib/sandbox/shell";

/**
 * CONTRACT (owned by the sandbox agent). The platform, never the sandbox, talks to Vercel.
 *
 * Plain REST calls to https://api.vercel.com with VERCEL_TOKEN, scoped to VERCEL_TEAM_ID:
 *   POST /v11/projects, GET and PATCH /v9/projects/{id}, POST /v10/projects/{id}/env?upsert=true,
 *   POST /v2/files (SHA-1 digest), POST /v13/deployments, GET /v13/deployments/{id}, GET /v9/projects/{id}/domains.
 */

const API = "https://api.vercel.com";
const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Never deployed: dependencies, build and test output, the user's inspo, git, and any env file. */
export const DEPLOY_EXCLUDE_DIRS = ["node_modules", ".next", "test-results", "playwright-report", "inspo", ".git", ".vercel"] as const;

export interface StartDeployInput {
  sandboxName: string;
  slug: string;
  productName: string;
  /** Set on the project as encrypted env vars: GATEWAY_URL and PRODUCT_TOKEN (the live token). */
  env: Record<string, string>;
  /** Reuse the product's project on redeploys. */
  projectId?: string | null;
}

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
 * Runs in the sandbox with Node: walks PRODUCT_DIR, skips excluded dirs, env files, symlinks and big files, and
 * writes every kept file into one blob plus an index, so the platform reads the whole tree in one request.
 */
const COLLECT_SCRIPT = `
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

/** Reads the deployable source out of a product sandbox. Each file's SHA-1 is checked after the transfer. */
export async function collectDeployFiles(
  sandboxName: string,
): Promise<{ files: Array<DeployFile & { content: Buffer }>; skipped: Array<{ file: string; size: number }> }> {
  const sandbox = await Sandbox.get({ name: sandboxName, resume: true });
  const outDir = `${OUT_DIR}/deploy`;
  const script = `${RUN_DIR}/collect-deploy.cjs`;
  await sandbox.writeFiles([{ path: script, content: COLLECT_SCRIPT }]);
  await sh(sandbox, `rm -rf ${q(outDir)} && node ${q(script)} ${[PRODUCT_DIR, outDir, String(MAX_FILE_BYTES), ...DEPLOY_EXCLUDE_DIRS].map(q).join(" ")}`, {
    timeoutMs: 50_000,
  });
  const [indexBuf, blob] = await Promise.all([
    sandbox.readFileToBuffer({ path: `${outDir}/files.json` }),
    sandbox.readFileToBuffer({ path: `${outDir}/files.bin` }),
  ]);
  if (!indexBuf || !blob) throw new Error("Could not read the collected files from the sandbox");
  const index = JSON.parse(indexBuf.toString("utf8")) as { files: DeployFile[]; skipped: Array<{ file: string; size: number }> };

  let at = 0;
  const files = index.files.map((f) => {
    const content = blob.subarray(at, at + f.size);
    at += f.size;
    const sha = createHash("sha1").update(content).digest("hex");
    if (sha !== f.sha) throw new Error(`File changed in transfer: ${f.file}`);
    return { ...f, content };
  });
  if (at !== blob.length) throw new Error(`Collected ${blob.length} bytes but the index lists ${at}`);
  return { files, skipped: index.skipped };
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
        body: new Uint8Array(f.content),
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

async function configureProject(project: Project, vars: Record<string, string>): Promise<void> {
  // Products are public: no Vercel Authentication and no password on any deployment.
  await vercel("PATCH", `/v9/projects/${project.id}`, { body: { framework: "nextjs", ssoProtection: null, passwordProtection: null } });
  const entries = Object.entries(vars);
  if (!entries.length) return;
  await vercel("POST", `/v10/projects/${project.id}/env`, {
    query: { upsert: "true" },
    body: entries.map(([key, value]) => ({ key, value, type: "encrypted", target: ["production", "preview"] })),
  });
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
  const [{ files }, project] = await Promise.all([collectDeployFiles(input.sandboxName), getOrCreateProject(name, input.projectId)]);
  if (!files.some((f) => f.file === "package.json")) throw new Error("The product has no package.json to deploy");
  await configureProject(project, input.env);

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
