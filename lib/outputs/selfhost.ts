/**
 * The self-host kit (docs/CAPABILITIES.md, section 16): a live product's own source, as it is deployed, ready to run on
 * someone's own Meta key. Cloud mode only: it calls Meta's Model API with the self-hoster's key, on Vercel or any Node
 * server. Its manifest's `mode` field is "cloud"; "offline" is kept for the offline install (General's tg-offline,
 * docs/OFFLINE.md), which comes after Nov 4, and this generator refuses it.
 *
 * Pure. The kit never carries a product token, the gateway's address, the platform's Meta key or Muse Code's binary
 * (Meta's terms 3.1 bar sharing a key): env files are never deployed, a file that holds anything shaped like a Muse Muse
 * token stops the kit, and executables are left out. The platform's build files (brief.md, the skills, the tests and
 * their fixtures, which can hold a person's own sample files) are left out too.
 */
import { createHash } from "node:crypto";
import { NOT_OFFICIAL, type OutputProduct } from "@/lib/outputs/generate";
import { KIT_FETCH_SOURCE } from "@/lib/outputs/runtime-assets-source";
import { fencedBlock, oneLine } from "@/lib/outputs/vscode";
import { makeZip, type ZipEntry } from "@/lib/outputs/zip";

/** "offline" is reserved for the offline install (docs/OFFLINE.md). Only "cloud" is made now. */
export type KitMode = "cloud" | "offline";
export const KIT_MODE: KitMode = "cloud";
export const KIT_VERSION = 1;
export const KIT_MANIFEST = "musemuse-kit.json";
export const selfHostFileName = (slug: string) => `${slug}-selfhost.zip`;

/** Public files bigger than this stay on the live product, and scripts/kit-fetch.mjs downloads them. */
export const KIT_FETCH_OVER_BYTES = 512 * 1024;
/** What one download may be: a Vercel Function's response stays under 4.5 MB. */
export const KIT_MAX_ZIP_BYTES = 4 * 1024 * 1024;

export interface SourceFile {
  path: string;
  content: Buffer;
}

export interface KitManifest {
  kit: number;
  mode: KitMode;
  product: { slug: string; name: string; liveUrl: string };
  /** The live deployment the files came from. */
  deployment: string;
  madeAt: string;
  needs: { metaApiKey: true; node: string; python: boolean };
  /** Parts that reach Muse Muse itself, so they don't work on your own key. */
  platformOnly: Array<{ what: string; files: string[] }>;
  /** Public files left out of the zip, with where to get them. */
  fetch: Array<{ path: string; url: string; sha256: string; bytes: number }>;
  files: Array<{ path: string; sha256: string; bytes: number }>;
}

export class KitError extends Error {
  constructor(
    readonly code: "token_in_source" | "no_package_json" | "too_big" | "mode",
    message: string,
  ) {
    super(message);
  }
}

/** Paths the kit never holds: the platform's build files and anything with settings in it. */
const LEFT_OUT: ReadonlyArray<RegExp> = [
  /^\.env(\..*)?$/,
  /(^|\/)\.env(\.[^/]*)?$/,
  /^\.mcp\.json$/,
  /^(brief|AGENTS|CLAUDE|BUILD_NOTES)\.md$/,
  /^(milestone|refine|fix)-\d+\.md$/,
  /^\.agents\//,
  /^\.muse\//,
  /^\.git\//,
  /^\.vercel\//,
  /^tests\//,
  /^test-results\//,
  /^playwright-report\//,
  /^fixtures\//,
  /^inspo\//,
  /^scripts\/(?!py-local\.mjs$)/,
  /^playwright\.config\.ts$/,
  /^musemuse\.(caps|target)\.json$/,
  /^musemuse\.schema\.json$/,
  /(^|\/)node_modules\//,
  /(^|\/)\.next\//,
  /(^|\/)__pycache__\//,
  /\.tsbuildinfo$/,
];

/** Anything shaped like a Muse Muse product token or a build sandbox's placeholder key. */
const TOKEN = /mm_(?:build|live)_[A-Za-z0-9_-]{20,}|mm_sandbox_[0-9a-f]{20,}/;

/** ELF, Mach-O and Windows executables: Muse Code's binary, or anything like it, never goes in a kit. */
function isExecutable(content: Buffer): boolean {
  if (content.length < 4) return false;
  const magic = content.readUInt32BE(0);
  return magic === 0x7f454c46 || magic === 0xcafebabe || magic === 0xfeedface || magic === 0xfeedfacf || magic === 0xcefaedfe || magic === 0xcffaedfe || (content[0] === 0x4d && content[1] === 0x5a);
}

const TEXT = /\.(m?[jt]sx?|cjs|json|md|css|html?|txt|py|ya?ml|toml|svg|env|sh|cfg|ini|xml|csv)$/i;

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Which parts reach Muse Muse itself, read from the source's imports and files. */
function platformOnlyParts(files: readonly SourceFile[]): KitManifest["platformOnly"] {
  const code = files.filter((f) => /\.(m?[jt]sx?)$/.test(f.path) && !f.path.startsWith("lib/platform/") && !f.path.startsWith("lib/meta/"));
  const using = (pattern: RegExp) => code.filter((f) => pattern.test(f.content.toString("utf8"))).map((f) => f.path);
  const parts: KitManifest["platformOnly"] = [];
  const has = (p: string) => files.some((f) => f.path === p);
  const add = (what: string, list: string[]) => {
    if (list.length) parts.push({ what, files: list.slice(0, 20) });
  };
  if (has("app/api/upload/route.ts")) add("Large uploads (over 4.5 MB) go through Muse Muse's temporary storage, so they don't work: keep files under 4.5 MB.", ["app/api/upload/route.ts", ...using(/uploadMedia\s*\(/)]);
  add("The connected gadget (a board's camera and microphone) is reached through Muse Muse.", using(/from\s+["']@\/lib\/meta\/gadget["']/));
  add("Muse Glimmer needs an endpoint of your own: set GLIMMER_URL, GLIMMER_API_KEY and GLIMMER_MODEL.", using(/from\s+["']@\/lib\/meta\/glimmer["']/));
  add("The agent's tools, other than Meta's web search, run through Muse Muse.", files.filter((f) => f.path.startsWith("lib/agent/")).map((f) => f.path));
  const services = files.filter((f) => /^lib\/platform\/[^/]+\.ts$/.test(f.path) && !["lib/platform/python.ts", "lib/platform/identity.ts"].includes(f.path)).map((f) => f.path);
  add("Muse Muse platform services (saved data, files, connections, jobs and the like) are Muse Muse's own.", services);
  return parts;
}

function envExample(python: boolean): string {
  return [
    "# Copy this file to .env.local and fill it in. Never commit it.",
    "#",
    "# Your own Meta Model API key. Meta's terms don't allow sharing a key, so everyone who runs this kit uses their own.",
    "PRODUCT_TOKEN=",
    "# Where the product's model calls go: Meta's Model API, called with the key above.",
    "GATEWAY_URL=https://api.meta.ai",
    ...(python ? ["# Off Vercel, Python functions run on this machine with python3 (scripts/py-local.mjs). On Vercel, leave it unset.", "# MUSEMUSE_PYTHON=local"] : []),
    "",
  ].join("\n");
}

function kitReadme(m: KitManifest, product: OutputProduct): string {
  const name = oneLine(product.name, 80);
  return [
    `# ${name}: self-host kit`,
    "",
    `This is ${name}'s code as it runs at ${m.product.liveUrl}, made into a kit you run on your own Meta API key. ${NOT_OFFICIAL}`,
    "",
    "It holds no Muse Muse key or token. Its model calls go straight to Meta's Model API with your key, and you pay Meta for them.",
    "",
    "## Run it",
    "",
    fencedBlock(
      [
        ...(m.fetch.length ? ["node scripts/kit-fetch.mjs        # downloads the larger public files it left out"] : []),
        "npm ci",
        "cp .env.example .env.local        # then add your Meta API key",
        "npm run build && npm start        # http://localhost:3100",
      ].join("\n"),
      "bash",
    ),
    "",
    "Or deploy it to Vercel: `npx vercel deploy`, then set `PRODUCT_TOKEN` (your Meta API key) and `GATEWAY_URL=https://api.meta.ai` in the project's environment variables.",
    "",
    `It needs Node ${m.needs.node} or newer${m.needs.python ? ", and for its Python functions in `api/py/` the Python that `.python-version` names: Vercel runs them itself, and anywhere else set `MUSEMUSE_PYTHON=local` and run `node scripts/py-local.mjs install`" : ""}.`,
    "",
    ...(m.platformOnly.length
      ? ["## What doesn't work here", "", "These parts reach Muse Muse itself, so they don't work on your own key:", "", ...m.platformOnly.map((p) => `- ${p.what}`), ""]
      : []),
    "## Good to know",
    "",
    "- Meta's terms and Acceptable Use Policy apply to everything you run with your key, and so do the licenses of the packages in `package.json`.",
    "- `musemuse-kit.json` lists every file with its sha256, and where the kit came from.",
    "- The kit leaves out how the product was built (the build's notes, tests and sample files).",
    "",
  ].join("\n");
}

/** package.json without the scripts that need the build files the kit leaves out. */
function kitPackageJson(content: Buffer): Buffer {
  try {
    const pkg = JSON.parse(content.toString("utf8")) as { scripts?: Record<string, string> };
    if (pkg.scripts) {
      for (const [k, v] of Object.entries(pkg.scripts)) if (/playwright|scripts\/(?!py-local)|verify/.test(v)) delete pkg.scripts[k];
    }
    return Buffer.from(`${JSON.stringify(pkg, null, 2)}\n`);
  } catch {
    return content;
  }
}

export interface KitInput {
  product: OutputProduct & { liveUrl: string };
  deployment: string;
  files: readonly SourceFile[];
  madeAt: Date;
  mode?: KitMode;
}

export interface Kit {
  manifest: KitManifest;
  entries: ZipEntry[];
  /** Paths the kit left out, for the route's log. */
  leftOut: string[];
}

export function selfHostKit(input: KitInput): Kit {
  if ((input.mode ?? KIT_MODE) !== "cloud") throw new KitError("mode", "Only the cloud kit is made now. The offline install comes later.");
  const kept: SourceFile[] = [];
  const leftOut: string[] = [];
  const fetch: KitManifest["fetch"] = [];
  const base = input.product.liveUrl.replace(/\/+$/, "");
  for (const file of input.files) {
    const p = file.path.replace(/^\.\/+/, "");
    if (!p || p.split("/").some((s) => s === ".." || s === "") || LEFT_OUT.some((r) => r.test(p)) || isExecutable(file.content)) {
      leftOut.push(p);
      continue;
    }
    if (TEXT.test(p) && TOKEN.test(file.content.toString("utf8"))) {
      throw new KitError("token_in_source", `The kit wasn't made: ${p} holds something shaped like a Muse Muse token.`);
    }
    if (p.startsWith("public/") && file.content.length > KIT_FETCH_OVER_BYTES) {
      fetch.push({ path: p, url: `${base}/${p.slice("public/".length).split("/").map(encodeURIComponent).join("/")}`, sha256: sha256(file.content), bytes: file.content.length });
      continue;
    }
    kept.push({ path: p, content: p === "package.json" ? kitPackageJson(file.content) : file.content });
  }
  if (!kept.some((f) => f.path === "package.json")) throw new KitError("no_package_json", "The kit wasn't made: the live product has no package.json.");
  const python = kept.some((f) => /^api\/py\/[a-z][a-z0-9_]*\.py$/.test(f.path));
  const extra: SourceFile[] = [
    { path: ".env.example", content: Buffer.from(envExample(python)) },
    ...(fetch.length ? [{ path: "scripts/kit-fetch.mjs", content: Buffer.from(KIT_FETCH_SOURCE) }] : []),
  ];
  const all = [...kept.filter((f) => !extra.some((e) => e.path === f.path) && f.path !== KIT_MANIFEST && f.path !== "README-SELF-HOST.md"), ...extra].sort((a, b) => a.path.localeCompare(b.path));
  const manifest: KitManifest = {
    kit: KIT_VERSION,
    mode: "cloud",
    product: { slug: input.product.slug, name: oneLine(input.product.name, 80), liveUrl: base },
    deployment: input.deployment,
    madeAt: input.madeAt.toISOString(),
    needs: { metaApiKey: true, node: "20", python },
    platformOnly: platformOnlyParts(kept),
    fetch,
    files: all.map((f) => ({ path: f.path, sha256: sha256(f.content), bytes: f.content.length })),
  };
  const entries: ZipEntry[] = [
    ...all.map((f) => ({ path: f.path, content: f.content })),
    { path: "README-SELF-HOST.md", content: kitReadme(manifest, input.product) },
    { path: KIT_MANIFEST, content: `${JSON.stringify(manifest, null, 2)}\n` },
  ];
  return { manifest, entries, leftOut };
}

/** The kit as one zip, or KitError("too_big") when it wouldn't fit in one download. */
export function selfHostZip(input: KitInput): { zip: Buffer; kit: Kit } {
  const kit = selfHostKit(input);
  const zip = makeZip(kit.entries);
  if (zip.length > KIT_MAX_ZIP_BYTES) {
    throw new KitError("too_big", `The kit would be ${(zip.length / 1024 / 1024).toFixed(1)} MB, over the ${KIT_MAX_ZIP_BYTES / 1024 / 1024} MB one download can be.`);
  }
  return { zip, kit };
}
