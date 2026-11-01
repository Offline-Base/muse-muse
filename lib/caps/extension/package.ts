import { createHash } from "node:crypto";
import type { ExtensionPermission } from "@/lib/caps/extension/brief";
import {
  checkProductManifest,
  EXTENSION_LIMITS,
  extensionConfigSource,
  finalManifest,
  isExtensionPath,
} from "@/lib/caps/extension/manifest";
import { RESERVED_FILES, scanExtensionFiles } from "@/lib/caps/extension/scan";
import { makeZip } from "@/lib/outputs/zip";

/**
 * Packaging a live product's extension (docs/CAPABILITIES.md, section 20). The build's packer compiles extension/ in
 * the sandbox and hands over its files as a bundle. Everything that decides what the extension may do is decided here,
 * on the platform, from the brief and the live link: the manifest's permissions, its one host permission, its policy
 * and config.js. Nothing in the bundle can widen them.
 */

/** What the packer writes (scripts/extension-pack.mjs bundle): the compiled files and the product's own manifest. */
export interface ExtensionBundle {
  musemuse_extension: 1;
  files: Array<{ path: string; base64: string }>;
}

export class ExtensionPackError extends Error {
  constructor(readonly problems: string[]) {
    super(problems[0] ?? "the extension couldn't be packaged");
    this.name = "ExtensionPackError";
  }
}

export interface PackagedExtension {
  zip: Buffer;
  manifest: Record<string, unknown>;
  files: number;
  /** The unpacked size, in bytes. */
  bytes: number;
  sha256: string;
  /** Permissions the product's manifest asked for that its brief didn't list, left out. */
  dropped: string[];
}

/** The bundle's files by path, checked for size and path rules. Throws ExtensionPackError. */
export function readBundle(raw: unknown): Map<string, Buffer> {
  const bundle = raw as Partial<ExtensionBundle> | null;
  if (!bundle || bundle.musemuse_extension !== 1 || !Array.isArray(bundle.files)) throw new ExtensionPackError(["the packer's output isn't an extension bundle"]);
  if (bundle.files.length > EXTENSION_LIMITS.files) throw new ExtensionPackError([`it has ${bundle.files.length} files, more than an extension may (${EXTENSION_LIMITS.files})`]);
  const files = new Map<string, Buffer>();
  let bytes = 0;
  const problems: string[] = [];
  for (const f of bundle.files) {
    const p = (f as { path?: unknown })?.path;
    const b64 = (f as { base64?: unknown })?.base64;
    if (!isExtensionPath(p) || typeof b64 !== "string") {
      problems.push(`"${String(p).slice(0, 60)}" isn't a file an extension may ship`);
      continue;
    }
    if (files.has(p)) {
      problems.push(`${p} is in the extension twice`);
      continue;
    }
    const content = Buffer.from(b64, "base64");
    if (content.length > EXTENSION_LIMITS.fileBytes) problems.push(`${p} is over ${EXTENSION_LIMITS.fileBytes / 1024 / 1024} MB`);
    bytes += content.length;
    files.set(p, content);
  }
  if (bytes > EXTENSION_LIMITS.bytes) problems.push(`its files are over ${EXTENSION_LIMITS.bytes / 1024 / 1024} MB together`);
  if (problems.length) throw new ExtensionPackError(problems);
  return files;
}

/**
 * The zip people install with Load unpacked: the bundle's files, the platform's manifest and config.js, in a stable
 * order so the same files make the same bytes. Throws ExtensionPackError with every problem found.
 */
export function packageExtension(raw: unknown, opts: { origin: string; permissions: readonly ExtensionPermission[] }): PackagedExtension {
  const files = readBundle(raw);
  const own = files.get("manifest.json");
  if (!own) throw new ExtensionPackError(["it has no manifest.json"]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(own.toString("utf8"));
  } catch {
    throw new ExtensionPackError(["extension/manifest.json isn't valid JSON"]);
  }
  const check = checkProductManifest(parsed, { allowed: opts.permissions });
  const problems = [...check.problems];
  for (const name of RESERVED_FILES) if (name !== "manifest.json" && files.has(name)) problems.push(`${name} is written by the platform, so the extension can't have its own`);
  for (const f of check.files) if (!files.has(f)) problems.push(`the manifest names ${f}, which isn't in the extension`);
  problems.push(...scanExtensionFiles(files));
  if (problems.length || !check.manifest) throw new ExtensionPackError(problems.length ? problems : ["the manifest couldn't be read"]);

  const manifest = finalManifest(check.manifest, opts.origin);
  const out = new Map(files);
  out.set("manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  out.set("config.js", Buffer.from(extensionConfigSource(opts.origin)));
  const entries = [...out.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => ({ path, content }));
  const zip = makeZip(entries);
  return {
    zip,
    manifest,
    files: entries.length,
    bytes: entries.reduce((n, e) => n + e.content.length, 0),
    sha256: createHash("sha256").update(zip).digest("hex"),
    dropped: check.dropped,
  };
}
