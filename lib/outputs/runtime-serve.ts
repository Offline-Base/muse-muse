/**
 * The runtime outputs' download routes (docs/CAPABILITIES.md, section 16), behind RUNTIME_OUTPUTS:
 *
 *   GET /p/<slug>/get/vscode.zip         the VS Code extension, for anyone, like the CLI
 *   GET /p/<slug>/get/github-action.zip  the GitHub Action, for anyone, like the CLI
 *   GET /p/<slug>/get/selfhost.zip       the self-host kit, for the product's owner only, since it holds the product's
 *                                        whole source: its owner decides whether to share it
 *
 * Each answers 404 with the flag off, with the very answer the native downloads route gave these paths before they
 * existed (lib/native/downloads.ts, an unknown kind), and 404 for a product that isn't live or has no public actions
 * (the kit needs only a live link). Nothing here publishes anything anywhere (decision 9). The kit's files come from
 * the live deployment itself, read back from Vercel (readLiveSource), so they are exactly what runs.
 */
import { createHash } from "node:crypto";
import { publicActions, type OutputProduct } from "@/lib/outputs/generate";
import { githubActionFileName, githubActionZip } from "@/lib/outputs/github-action";
import { KitError, selfHostFileName, selfHostZip, type SourceFile } from "@/lib/outputs/selfhost";
import { vscodeFileName, vscodeZip } from "@/lib/outputs/vscode";

export type RuntimeDownload = "vscode" | "github_action";

export interface RuntimeOutputDeps {
  enabled(): boolean;
  findProduct(slug: string): Promise<OutputProduct | null>;
}

const SLUG = /^[a-z0-9-]{1,80}$/;
const text = (body: string, status: number, headers: Record<string, string> = {}) =>
  new Response(`${body}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers } });
/** With RUNTIME_OUTPUTS off: what /p/<slug>/get/<kind> answered for an unknown kind before these routes existed. */
const noSuchDownload = () => text("There's no download by that name.", 404);
/** As the native downloads route says it for a product with no such package. */
const notAvailable = () => text("This download isn't available.", 404);

function zip(body: Buffer, fileName: string, cache: string): Response {
  return new Response(new Uint8Array(body), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${fileName}"`,
      "x-content-type-options": "nosniff",
      "cache-control": cache,
    },
  });
}

/** The VS Code extension or the GitHub Action, made from the manifest on each request, as the CLI is. */
export async function runtimeOutputResponse(kind: RuntimeDownload, slug: string, deps: RuntimeOutputDeps): Promise<Response> {
  if (!deps.enabled()) return noSuchDownload();
  if (!SLUG.test(slug)) return notAvailable();
  const product = await deps.findProduct(slug);
  if (!product?.liveUrl || !publicActions(product.manifest).length) return notAvailable();
  const cache = "public, max-age=60, s-maxage=60";
  return kind === "vscode" ? zip(vscodeZip(product), vscodeFileName(slug), cache) : zip(githubActionZip(product), githubActionFileName(slug), cache);
}

// ---------------------------------------------------------------------------------------------------------------
// The live deployment's source, read back from Vercel

export interface VercelReadDeps {
  /** GET a Vercel REST path (https://api.vercel.com) with the platform's token and team. Throws on a failed call. */
  api(path: string): Promise<Response>;
}

/** What one kit may read, so a product with a huge tree can't keep the route busy. */
export const SOURCE_LIMITS = { files: 600, bytes: 24 * 1024 * 1024, fileBytes: 10 * 1024 * 1024, parallel: 8 } as const;

interface TreeEntry {
  name?: unknown;
  type?: unknown;
  uid?: unknown;
  children?: unknown;
}

/** The files in a deployment's source tree, as paths and the ids Vercel reads them by. */
export function flattenTree(tree: unknown, prefix = ""): Array<{ path: string; uid: string }> {
  if (!Array.isArray(tree)) return [];
  return (tree as TreeEntry[]).flatMap((e) => {
    if (typeof e?.name !== "string" || !e.name || e.name === "." || e.name === ".." || e.name.includes("/")) return [];
    const p = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.type === "directory") return flattenTree(e.children, p);
    return e.type === "file" && typeof e.uid === "string" && e.uid ? [{ path: p, uid: e.uid }] : [];
  });
}

/**
 * The source tree of a deployment made from uploaded files. Vercel may keep it under a top-level "src" folder; when it
 * does and nothing else at the top has a package.json, that folder is the source.
 */
function sourceFiles(tree: unknown): Array<{ path: string; uid: string }> {
  const files = flattenTree(tree);
  if (files.some((f) => f.path === "package.json")) return files;
  const src = files.filter((f) => f.path.startsWith("src/")).map((f) => ({ ...f, path: f.path.slice(4) }));
  return src.some((f) => f.path === "package.json") ? src : files;
}

async function fileContent(deps: VercelReadDeps, deploymentId: string, file: { path: string; uid: string }): Promise<Buffer> {
  const res = await deps.api(`/v8/deployments/${encodeURIComponent(deploymentId)}/files/${encodeURIComponent(file.uid)}`);
  const raw = Buffer.from(await res.arrayBuffer());
  // Vercel's docs say the reply is JSON with the file base64-encoded, without naming the field. Both readings are tried.
  const candidates: Buffer[] = [];
  if ((res.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      const json = JSON.parse(raw.toString("utf8")) as unknown;
      const b64 = typeof json === "string" ? json : [(json as { data?: unknown })?.data, (json as { content?: unknown })?.content].find((v) => typeof v === "string");
      if (typeof b64 === "string") candidates.push(Buffer.from(b64, "base64"));
    } catch {
      // Not JSON after all: the bytes themselves.
    }
  }
  candidates.push(raw);
  // An uploaded file's id is its SHA-1, as lib/publish/vercel.ts uploads it: the reading that matches it is the file, so
  // a misread reply never ships.
  if (!/^[0-9a-f]{40}$/.test(file.uid)) return candidates[0]!;
  const match = candidates.find((c) => createHash("sha1").update(c).digest("hex") === file.uid);
  if (!match) throw new Error(`${file.path} didn't match its SHA-1 when it was read back from Vercel`);
  return match;
}

/**
 * Reads the live deployment's source: the deployment its live link points at, which must belong to the product's own
 * project, then each file, at most SOURCE_LIMITS. Throws with a plain reason.
 */
export async function readLiveSource(input: { liveUrl: string; projectId: string }, deps: VercelReadDeps): Promise<{ deploymentId: string; files: SourceFile[] }> {
  const host = new URL(input.liveUrl).hostname;
  const deployment = (await (await deps.api(`/v13/deployments/${encodeURIComponent(host)}`)).json()) as { id?: unknown; projectId?: unknown };
  if (typeof deployment.id !== "string" || deployment.projectId !== input.projectId) {
    throw new Error("the live link doesn't point at this product's own deployment");
  }
  const list = sourceFiles(await (await deps.api(`/v6/deployments/${encodeURIComponent(deployment.id)}/files`)).json());
  if (!list.length) throw new Error("its deployment has no source files to read");
  if (list.length > SOURCE_LIMITS.files) throw new Error(`it has ${list.length} files, more than a kit takes (${SOURCE_LIMITS.files})`);
  const files: SourceFile[] = [];
  let bytes = 0;
  const queue = [...list];
  const worker = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const content = await fileContent(deps, deployment.id as string, f);
      if (content.length > SOURCE_LIMITS.fileBytes) throw new Error(`${f.path} is over ${SOURCE_LIMITS.fileBytes / 1024 / 1024} MB`);
      bytes += content.length;
      if (bytes > SOURCE_LIMITS.bytes) throw new Error(`its files are over ${SOURCE_LIMITS.bytes / 1024 / 1024} MB together`);
      files.push({ path: f.path, content });
    }
  };
  await Promise.all(Array.from({ length: SOURCE_LIMITS.parallel }, worker));
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { deploymentId: deployment.id, files };
}

// ---------------------------------------------------------------------------------------------------------------
// The self-host kit

export interface SelfHostProduct extends OutputProduct {
  id: string;
  ownerId: string;
  vercelProjectId: string | null;
}

/** Which hourly share a kit request ran out of. */
export type SelfHostLimit = "product" | "owner" | "site";

export interface SelfHostDeps {
  enabled(): boolean;
  findProduct(slug: string): Promise<SelfHostProduct | null>;
  /** True when the person asking may act as the product's owner (canActAsOwner in lib/auth.ts). */
  isOwner(product: SelfHostProduct): Promise<boolean>;
  /** Null when this site has no Vercel token to read deployments with. */
  vercel(): VercelReadDeps | null;
  /**
   * Takes one kit build this hour from the owner's share, the product's and the site's, in that order. Null when it got
   * all three (and gives back what it took when one was full); else the share that was full.
   */
  reserve(product: SelfHostProduct): Promise<SelfHostLimit | null>;
  now(): Date;
}

/** Each kit reads every file of the deployment from Vercel with the platform's token, so kits are counted per hour. */
export const SELFHOST_PER_HOUR = 6;
/** All of one owner's products together. */
export const SELFHOST_OWNER_PER_HOUR = 12;
/** The whole site. */
export const SELFHOST_SITE_PER_HOUR = 60;

/** An hourly counter, as lib/gateway/store's reserveCounter and adjustCounter keep them. */
export interface KitCounters {
  /** Takes one under `limit` this hour; false when it is full. */
  take(key: string, limit: number): Promise<boolean>;
  /** Gives one back. */
  giveBack(key: string): Promise<void>;
}

export const kitCounterKeys = {
  owner: (ownerId: string) => `selfhost-owner:${ownerId}`,
  product: (productId: string) => `selfhost:${productId}`,
  site: "selfhost:all",
} as const;

/** SelfHostDeps.reserve over hourly counters: the owner's share, then the product's, then the site's. */
export async function reserveKit(product: Pick<SelfHostProduct, "id" | "ownerId">, counters: KitCounters): Promise<SelfHostLimit | null> {
  const shares: Array<[string, number, SelfHostLimit]> = [
    [kitCounterKeys.owner(product.ownerId), SELFHOST_OWNER_PER_HOUR, "owner"],
    [kitCounterKeys.product(product.id), SELFHOST_PER_HOUR, "product"],
    [kitCounterKeys.site, SELFHOST_SITE_PER_HOUR, "site"],
  ];
  const taken: string[] = [];
  for (const [key, limit, which] of shares) {
    if (!(await counters.take(key, limit))) {
      // Nothing is made, so the shares already taken go back.
      for (const k of taken) await counters.giveBack(k).catch((err: unknown) => console.error("[selfhost] couldn't give back a kit:", err instanceof Error ? err.message : err));
      return which;
    }
    taken.push(key);
  }
  return null;
}

/** The request's own say about where it came from: the browser's Sec-Fetch-Site, when it sent one. */
export interface KitRequest {
  fetchSite: string | null;
}

/**
 * A kit is made on a GET that rides the owner's session cookie, so a page on another site could start one in the
 * owner's name and use up their kits. Browsers say where a request came from: only the platform's own pages and a link
 * the owner opened themselves (or a client that doesn't say, which then has no cookie of a browser's to ride) get one.
 */
function crossSite(request: KitRequest): boolean {
  return request.fetchSite !== null && request.fetchSite !== "same-origin" && request.fetchSite !== "none";
}

const LIMIT_SAYS: Record<SelfHostLimit, string> = {
  product: `A product's owner can make ${SELFHOST_PER_HOUR} kits of it an hour. Try again later.`,
  owner: `You can make ${SELFHOST_OWNER_PER_HOUR} self-host kits an hour across your products. Try again later.`,
  site: "This site has made all the self-host kits it makes in an hour. Try again later.",
};

const untilNextHour = (now: Date) => String(Math.max(1, Math.ceil((3_600_000 - (now.getTime() % 3_600_000)) / 1000)));

/** The checks before anything is counted or read: the answer to give, or the product when the request may go on. */
async function selfHostRefusal(slug: string, deps: SelfHostDeps, request: KitRequest): Promise<{ answer: Response } | { product: SelfHostProduct }> {
  if (!deps.enabled()) return { answer: noSuchDownload() };
  if (!SLUG.test(slug)) return { answer: notAvailable() };
  if (crossSite(request)) return { answer: text("Open the self-host kit from the product's own page.", 403) };
  const product = await deps.findProduct(slug);
  if (!product?.liveUrl) return { answer: notAvailable() };
  if (!(await deps.isOwner(product))) return { answer: text("Only this product's owner can download its self-host kit.", 403) };
  return { product };
}

/** HEAD: whether the kit is there for this person, without counting a kit or reading a file. */
export async function selfHostHead(slug: string, deps: SelfHostDeps, request: KitRequest = { fetchSite: null }): Promise<Response> {
  const checked = await selfHostRefusal(slug, deps, request);
  if ("answer" in checked) return new Response(null, { status: checked.answer.status, headers: checked.answer.headers });
  return new Response(null, { status: 200, headers: { "content-type": "application/zip", "cache-control": "private, no-store" } });
}

export async function selfHostResponse(slug: string, deps: SelfHostDeps, request: KitRequest = { fetchSite: null }): Promise<Response> {
  const checked = await selfHostRefusal(slug, deps, request);
  if ("answer" in checked) return checked.answer;
  const { product } = checked;
  const vercel = deps.vercel();
  if (!vercel || !product.vercelProjectId || !product.liveUrl) return text("This site can't read the live product's files, so it can't make a self-host kit.", 503);
  const full = await deps.reserve(product);
  if (full) return text(LIMIT_SAYS[full], 429, { "retry-after": untilNextHour(deps.now()) });
  let source: { deploymentId: string; files: SourceFile[] };
  try {
    source = await readLiveSource({ liveUrl: product.liveUrl, projectId: product.vercelProjectId }, vercel);
  } catch (err) {
    console.error(`[selfhost] reading ${slug}'s live files:`, err instanceof Error ? err.message : err);
    return text(`The live product's files couldn't be read: ${err instanceof Error ? err.message : "try again"}.`, 502);
  }
  try {
    const { zip: body } = selfHostZip({ product: { ...product, liveUrl: product.liveUrl }, deployment: source.deploymentId, files: source.files, madeAt: deps.now() });
    return zip(body, selfHostFileName(slug), "private, no-store");
  } catch (err) {
    if (err instanceof KitError) return text(err.message, err.code === "too_big" ? 413 : 422);
    throw err;
  }
}
