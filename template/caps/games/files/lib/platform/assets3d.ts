// Platform file (Muse Muse platform services). Don't edit: the engine helpers (lib/platform/babylon-glb.ts,
// lib/platform/phaser-assets.ts) use it, and so may the product.
//
// Free 3D assets in the platform's "CC0 asset manifest, v1" shape (3d/manifest.json): models, HDRIs and textures, each
// file with its size and sha256. parseAssetManifest keeps only CC0 assets within the limits, fetchVerified downloads one
// file and checks its size and sha256 before anything uses it, and glbInfo reads a GLB's header and JSON so a model that
// needs a decoder from another site (Draco, meshopt, KTX2) or points at outside files is refused before the engine
// tries to fetch one. Runs in the browser and in Node 20 or newer.

export const ASSET_MANIFEST_VERSION = 1;

/** The manifest's limits for a model: binary glTF 2.0, textures embedded, at most 5 MB and 50k triangles. */
export const ASSET_LIMITS = { glbBytes: 5 * 1024 * 1024, triangles: 50_000, previewBytes: 1024 * 1024, fileBytes: 32 * 1024 * 1024 } as const;

export type AssetKind = "model" | "hdri" | "texture";
const ROLES: Record<AssetKind, readonly string[]> = {
  model: ["glb", "preview"],
  hdri: ["hdr", "preview"],
  texture: ["albedo", "normal", "roughness", "ao", "preview"],
};

export interface AssetFile {
  role: string;
  path: string;
  bytes: number;
  sha256: string;
}

export interface Asset3d {
  id: string;
  title: string;
  kind: AssetKind;
  tags: string[];
  files: AssetFile[];
  triangles?: number;
  units?: string;
  upAxis?: string;
  bbox?: { x: number; y: number; z: number };
  license: { spdx: "CC0-1.0"; url: string };
  source: { name: string; url: string };
  attribution: string;
  addedAt?: string;
}

export interface AssetManifest {
  version: 1;
  assets: Asset3d[];
  /** Assets left out, with the reason: not CC0, over a limit, or not in the v1 shape. */
  skipped: Array<{ id: string; reason: string }>;
}

/** A problem with an asset, in words to show the person. */
export class AssetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetError";
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** A relative path into the asset store: plain names, forward slashes, no `..`, no scheme. */
export function isAssetPath(p: unknown): p is string {
  return typeof p === "string" && p.length <= 200 && /^[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/.test(p) && !p.split("/").some((s) => s === "." || s === "..");
}

function assetProblem(raw: Record<string, unknown>): string | null {
  if (typeof raw.id !== "string" || !ID.test(raw.id)) return "its id isn't a plain slug";
  if (typeof raw.title !== "string" || !raw.title.trim()) return "it has no title";
  if (!["model", "hdri", "texture"].includes(raw.kind as string)) return "its kind isn't model, hdri or texture";
  const license = raw.license;
  if (!isObject(license) || license.spdx !== "CC0-1.0") return "it isn't CC0-1.0";
  if (typeof raw.attribution !== "string" || !raw.attribution.trim()) return "it has no attribution line";
  if (!isObject(raw.source) || typeof raw.source.name !== "string") return "it doesn't name its source";
  if (!Array.isArray(raw.files) || !raw.files.length) return "it has no files";
  const roles = ROLES[raw.kind as AssetKind];
  for (const f of raw.files) {
    if (!isObject(f)) return "a file entry isn't an object";
    if (typeof f.role !== "string" || !roles.includes(f.role)) return `a file's role isn't one of ${roles.join(", ")}`;
    if (!isAssetPath(f.path)) return "a file's path isn't a plain relative path";
    if (typeof f.bytes !== "number" || !Number.isInteger(f.bytes) || f.bytes <= 0 || f.bytes > ASSET_LIMITS.fileBytes) return "a file's size is missing or too big";
    if (typeof f.sha256 !== "string" || !SHA256.test(f.sha256)) return "a file has no sha256";
    if (f.role === "glb" && f.bytes > ASSET_LIMITS.glbBytes) return "its GLB is over 5 MB";
    if (f.role === "preview" && f.bytes > ASSET_LIMITS.previewBytes) return "its preview is over 1 MB";
  }
  if (raw.kind === "model") {
    if (!raw.files.some((f) => isObject(f) && f.role === "glb")) return "a model has no glb file";
    if (typeof raw.triangles !== "number" || raw.triangles <= 0 || raw.triangles > ASSET_LIMITS.triangles) return "its triangle count is missing or over 50k";
  }
  return null;
}

/**
 * Reads a v1 manifest. Throws AssetError when it isn't one. Assets that aren't CC0-1.0, break a limit or miss a field
 * are left out and listed in `skipped`, so one bad entry never takes the rest down.
 */
export function parseAssetManifest(raw: unknown): AssetManifest {
  if (!isObject(raw) || raw.version !== ASSET_MANIFEST_VERSION || !Array.isArray(raw.assets)) {
    throw new AssetError("The asset list isn't a version 1 asset manifest.");
  }
  const assets: Asset3d[] = [];
  const skipped: AssetManifest["skipped"] = [];
  const seen = new Set<string>();
  for (const a of raw.assets) {
    const id = isObject(a) && typeof a.id === "string" ? a.id.slice(0, 80) : "unknown";
    const problem = !isObject(a) ? "it isn't an object" : seen.has(id) ? "its id is listed twice" : assetProblem(a);
    if (problem) skipped.push({ id, reason: problem });
    else {
      seen.add(id);
      assets.push(a as unknown as Asset3d);
    }
  }
  return { version: 1, assets, skipped };
}

/** One of an asset's files by role, or null. */
export function assetFile(asset: Asset3d, role: string): AssetFile | null {
  return asset.files.find((f) => f.role === role) ?? null;
}

/** The URL of an asset file under `base` (where the asset store is, like "/assets/" or the platform's asset host). */
export function assetUrl(base: string, file: Pick<AssetFile, "path">): string {
  if (!isAssetPath(file.path)) throw new AssetError("That asset's path isn't a plain relative path.");
  return `${base.replace(/\/+$/, "")}/${file.path}`;
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Downloads one asset file and checks its size and sha256 against the manifest before returning its bytes. Throws
 * AssetError in plain words when it can't be fetched or doesn't match, so a changed or swapped file is never used.
 */
export async function fetchVerified(url: string, file: Pick<AssetFile, "bytes" | "sha256">, opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}): Promise<ArrayBuffer> {
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, { signal: opts.signal, credentials: "omit" });
  } catch {
    throw new AssetError("A 3D asset couldn't be downloaded. Check your connection and try again.");
  }
  if (!res.ok) throw new AssetError(`A 3D asset couldn't be downloaded (it answered ${res.status}).`);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > file.bytes) throw new AssetError("A 3D asset is bigger than its listing says, so it wasn't used.");
  const data = await res.arrayBuffer();
  if (data.byteLength !== file.bytes) throw new AssetError("A 3D asset isn't the size its listing says, so it wasn't used.");
  if ((await sha256Hex(data)) !== file.sha256) throw new AssetError("A 3D asset doesn't match its listing's checksum, so it wasn't used.");
  return data;
}

/** What a GLB holds, from its header and JSON chunk. */
export interface GlbInfo {
  version: number;
  bytes: number;
  extensionsUsed: string[];
  extensionsRequired: string[];
  meshes: number;
  triangles: number;
  images: number;
  /** Buffers and images that point at a file or URL instead of living in the GLB. */
  externalUris: string[];
}

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"

/** Reads a GLB's header and JSON chunk. Throws AssetError when it isn't a binary glTF 2.0 file. */
export function glbInfo(data: ArrayBuffer): GlbInfo {
  if (data.byteLength < 20) throw new AssetError("That model file is too small to be a GLB.");
  const view = new DataView(data);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new AssetError("That model file isn't a GLB (binary glTF).");
  const version = view.getUint32(4, true);
  if (version !== 2) throw new AssetError("That model is glTF 1, and only glTF 2.0 loads.");
  const length = view.getUint32(8, true);
  if (length !== data.byteLength) throw new AssetError("That model file is cut short or has extra bytes.");
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== CHUNK_JSON || 20 + jsonLength > length) throw new AssetError("That model file's JSON part is missing.");
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 20, jsonLength))) as Record<string, unknown>;
  } catch {
    throw new AssetError("That model file's JSON part can't be read.");
  }
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  const strings = (v: unknown) => list(v).filter((x): x is string => typeof x === "string");
  const accessors = list(json.accessors) as Array<{ count?: unknown }>;
  const count = (i: unknown) => (typeof i === "number" && typeof accessors[i]?.count === "number" ? (accessors[i]!.count as number) : 0);
  let triangles = 0;
  for (const mesh of list(json.meshes) as Array<{ primitives?: unknown }>) {
    for (const p of list(mesh?.primitives) as Array<{ mode?: unknown; indices?: unknown; attributes?: { POSITION?: unknown } }>) {
      const mode = typeof p?.mode === "number" ? p.mode : 4;
      const vertices = p?.indices !== undefined ? count(p.indices) : count(p?.attributes?.POSITION);
      if (mode === 4) triangles += Math.floor(vertices / 3);
      else if (mode === 5 || mode === 6) triangles += Math.max(0, vertices - 2);
    }
  }
  const uris = [...(list(json.buffers) as Array<{ uri?: unknown }>), ...(list(json.images) as Array<{ uri?: unknown }>)]
    .map((b) => b?.uri)
    .filter((u): u is string => typeof u === "string" && !u.startsWith("data:"));
  return {
    version,
    bytes: data.byteLength,
    extensionsUsed: strings(json.extensionsUsed),
    extensionsRequired: strings(json.extensionsRequired),
    meshes: list(json.meshes).length,
    triangles,
    images: list(json.images).length,
    externalUris: uris,
  };
}

/** glTF extensions whose decoders the engines fetch from their own sites. None is served locally yet, so they're refused. */
export const DECODER_EXTENSIONS = ["KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_meshopt_compression", "KHR_texture_basisu"] as const;

/**
 * Checks a GLB before an engine loads it: glTF 2.0, self-contained, within the size and triangle limits, and with no
 * extension whose decoder would come from another site. Returns its info, or throws AssetError.
 */
export function checkGlb(data: ArrayBuffer, limits: { maxBytes?: number; maxTriangles?: number } = {}): GlbInfo {
  const info = glbInfo(data);
  const maxBytes = limits.maxBytes ?? ASSET_LIMITS.glbBytes;
  const maxTriangles = limits.maxTriangles ?? ASSET_LIMITS.triangles;
  if (info.bytes > maxBytes) throw new AssetError(`That model is over ${Math.round(maxBytes / 1024 / 1024)} MB.`);
  if (info.triangles > maxTriangles) throw new AssetError(`That model has more than ${maxTriangles.toLocaleString("en-US")} triangles.`);
  if (info.externalUris.length) throw new AssetError("That model points at outside files. Only self-contained GLB files load.");
  const needsDecoder = [...info.extensionsUsed, ...info.extensionsRequired].find((e) => (DECODER_EXTENSIONS as readonly string[]).includes(e));
  if (needsDecoder) throw new AssetError("That model is compressed in a way that needs a decoder from another site, so it can't load here.");
  return info;
}
