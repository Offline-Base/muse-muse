import { createHash } from "node:crypto";
import list from "@/lib/caps/files/models3d.json";

/**
 * The vetted CC0 3D asset set, in "CC0 asset manifest, v1" (~/mm-wt/_plan/3d.md, agreed with General's tg-3d): models,
 * HDRIs and textures that products can load, hosted on Blob at 3d/ next to the datasets. lib/caps/files/models3d.json is
 * the source list: the v1 manifest plus a pinned `download` for each file, which publishedManifest() drops before
 * 3d/manifest.json goes to Blob. Nothing is mirrored yet: scripts/caps/mirror-datasets.ts checks the list and its files,
 * and uploads only with --apply.
 *
 * The rules, checked here so a file that breaks one never goes up:
 *   - license.spdx is CC0-1.0, and attribution is filled anyway, so product credits can show it
 *   - models: binary glTF 2.0 with every texture embedded, at most 5 MB and 50,000 triangles, textures at most 2048 px,
 *     no Draco (no decoder is vendored), meshopt allowed; metres, Y up, origin at the base centre
 *   - HDRIs: Radiance RGBE, 1k or 2k wide. Textures: PNG, JPEG or WebP, at most 2048 px
 *   - previews: WebP or JPEG, 512 px on the long side
 *   - every file has its sha256, which the product checks after download
 */

export type AssetKind = "model" | "hdri" | "texture";
export type AssetRole = "glb" | "preview" | "hdr" | "albedo" | "normal" | "roughness" | "ao";

export interface AssetFile {
  role: AssetRole;
  path: string;
  bytes: number;
  sha256: string;
  /** Source list only: a pinned https download of exactly these bytes. */
  download?: string;
}

export interface Asset3d {
  id: string;
  title: string;
  kind: AssetKind;
  tags: string[];
  files: AssetFile[];
  triangles?: number;
  units?: "m";
  upAxis?: "Y";
  bbox?: { x: number; y: number; z: number };
  license: { spdx: "CC0-1.0"; url: string };
  source: { name: string; url: string };
  attribution: string;
  addedAt: string;
}

export interface Manifest3d {
  version: 1;
  assets: Asset3d[];
}

export const MODEL_MAX_BYTES = 5 * 1024 * 1024;
export const MODEL_MAX_TRIANGLES = 50_000;
export const TEXTURE_MAX_PX = 2048;
export const PREVIEW_PX = 512;
export const CC0_URL = "https://creativecommons.org/publicdomain/zero/1.0/";

const ROLES: Record<AssetKind, { required: AssetRole[]; optional: AssetRole[] }> = {
  model: { required: ["glb", "preview"], optional: [] },
  hdri: { required: ["hdr", "preview"], optional: [] },
  texture: { required: ["albedo", "preview"], optional: ["normal", "roughness", "ao"] },
};

const ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const FILE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA = /^[0-9a-f]{64}$/;
const https = (v: unknown) => typeof v === "string" && /^https:\/\/\S+$/.test(v);

/** Checks a manifest's shape and rules (everything but the bytes). Returns the problems, empty when it is good. */
export function manifestProblems(raw: unknown, opts: { source?: boolean } = {}): string[] {
  const problems: string[] = [];
  const m = raw as Partial<Manifest3d> | null;
  if (m?.version !== 1 || !Array.isArray(m.assets)) return ["The manifest isn't version 1 with an assets list."];
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const [i, a] of m.assets.entries()) {
    const at = `asset ${i} (${String(a?.id)})`;
    if (typeof a?.id !== "string" || !ID.test(a.id)) {
      problems.push(`${at}: the id isn't lowercase letters, digits and dashes.`);
      continue;
    }
    if (ids.has(a.id)) problems.push(`${at}: the id is listed twice.`);
    ids.add(a.id);
    if (typeof a.title !== "string" || !a.title.trim()) problems.push(`${at}: no title.`);
    if (!(a.kind in ROLES)) {
      problems.push(`${at}: kind is model, hdri or texture.`);
      continue;
    }
    if (!Array.isArray(a.tags) || a.tags.some((t) => typeof t !== "string" || !/^[a-z0-9-]{1,32}$/.test(t))) problems.push(`${at}: tags are short lowercase words.`);
    if (a.license?.spdx !== "CC0-1.0") problems.push(`${at}: only CC0-1.0 assets are allowed.`);
    if (a.license?.url !== CC0_URL) problems.push(`${at}: the license URL is CC0's.`);
    if (typeof a.source?.name !== "string" || !a.source.name.trim() || !https(a.source?.url)) problems.push(`${at}: no source name and https page.`);
    if (typeof a.attribution !== "string" || !a.attribution.trim()) problems.push(`${at}: attribution is filled even for CC0.`);
    if (typeof a.addedAt !== "string" || Number.isNaN(Date.parse(a.addedAt)) || !a.addedAt.endsWith("Z")) problems.push(`${at}: addedAt is an ISO time in UTC.`);
    const roles = ROLES[a.kind];
    const files = Array.isArray(a.files) ? a.files : [];
    for (const r of roles.required) if (files.filter((f) => f?.role === r).length !== 1) problems.push(`${at}: needs exactly one ${r} file.`);
    for (const f of files) {
      const where = `${at}, ${String(f?.role)} file`;
      if (![...roles.required, ...roles.optional].includes(f?.role)) problems.push(`${where}: a ${a.kind} has no ${String(f?.role)} file.`);
      const name = typeof f?.path === "string" && f.path.startsWith(`3d/${a.id}/`) ? f.path.slice(`3d/${a.id}/`.length) : null;
      if (!name || !FILE.test(name)) problems.push(`${where}: the path is 3d/${a.id}/<plain file name>.`);
      else if (paths.has(f.path)) problems.push(`${where}: the path is listed twice.`);
      if (typeof f?.path === "string") paths.add(f.path);
      if (!Number.isInteger(f?.bytes) || f.bytes <= 0) problems.push(`${where}: no size.`);
      if (typeof f?.sha256 !== "string" || !SHA.test(f.sha256)) problems.push(`${where}: no sha256.`);
      if (f?.role === "glb" && f.bytes > MODEL_MAX_BYTES) problems.push(`${where}: over 5 MB.`);
      if (opts.source && !https(f?.download)) problems.push(`${where}: no pinned https download.`);
      if (!opts.source && f && "download" in f) problems.push(`${where}: the published manifest carries no download address.`);
      if (f?.role === "glb" && name && !name.endsWith(".glb")) problems.push(`${where}: a model is a .glb.`);
      if (f?.role === "preview" && name && !/\.(webp|jpe?g)$/.test(name)) problems.push(`${where}: a preview is WebP or JPEG.`);
      if (f?.role === "hdr" && name && !name.endsWith(".hdr")) problems.push(`${where}: an HDRI is a Radiance .hdr.`);
    }
    if (a.kind === "model") {
      if (!Number.isInteger(a.triangles) || (a.triangles ?? 0) <= 0 || (a.triangles ?? 0) > MODEL_MAX_TRIANGLES) problems.push(`${at}: triangles is a count from 1 to 50,000.`);
      if (a.units !== "m") problems.push(`${at}: units are metres ("m").`);
      if (a.upAxis !== "Y") problems.push(`${at}: Y is up.`);
      const b = a.bbox;
      if (!b || ![b.x, b.y, b.z].every((v) => typeof v === "number" && Number.isFinite(v) && v > 0)) problems.push(`${at}: bbox has positive x, y and z in metres.`);
    }
  }
  return problems;
}

/** The source list, checked. Throws on the first problems. */
export function vetted3dAssets(raw: unknown = list): Asset3d[] {
  const problems = manifestProblems(raw, { source: true });
  if (problems.length) throw new Error(`lib/caps/files/models3d.json: ${problems.slice(0, 5).join(" ")}`);
  return (raw as Manifest3d).assets;
}

/** 3d/manifest.json as it goes to Blob: the source list without its download addresses. */
export function publishedManifest(assets: readonly Asset3d[]): Manifest3d {
  return { version: 1, assets: assets.map((a) => ({ ...a, files: a.files.map(({ download: _d, ...f }) => f) })) };
}

// ---------------------------------------------------------------------------------------------------------------
// The bytes

/** Width and height of a PNG, JPEG or WebP, or null for anything else. */
export function imageSize(bytes: Buffer): { width: number; height: number; type: "png" | "jpeg" | "webp" } | null {
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.toString("ascii", 12, 16) === "IHDR") {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), type: "png" };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1]!;
      const len = bytes.readUInt16BE(at + 2);
      // SOF0 to SOF15, except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7), type: "jpeg" };
      at += 2 + len;
    }
    return null;
  }
  if (bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    const chunk = bytes.toString("ascii", 12, 16);
    if (chunk === "VP8X") return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3), type: "webp" };
    if (chunk === "VP8 ") return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff, type: "webp" };
    if (chunk === "VP8L") {
      const b = bytes.readUInt32LE(21);
      return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff), type: "webp" };
    }
  }
  return null;
}

/** The width and height a Radiance RGBE file declares, or null when it isn't one. */
export function hdrSize(bytes: Buffer): { width: number; height: number } | null {
  const head = bytes.subarray(0, Math.min(bytes.length, 4096)).toString("latin1");
  if (!/^#\?(RADIANCE|RGBE)\n/.test(head) || !/FORMAT=32-bit_rle_rgbe/.test(head)) return null;
  const m = head.match(/\n\n-Y (\d+) \+X (\d+)\n/);
  return m ? { height: Number(m[1]), width: Number(m[2]) } : null;
}

type Mat4 = number[];
const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r]! += a[k * 4 + r]! * b[c * 4 + k]!;
  return out;
}

/** A node's local matrix, column-major as glTF writes it, from `matrix` or translation, rotation and scale. */
function localMatrix(node: { matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }): Mat4 {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix;
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  return [
    (1 - 2 * (y! * y! + z! * z!)) * sx!, 2 * (x! * y! + z! * w!) * sx!, 2 * (x! * z! - y! * w!) * sx!, 0,
    2 * (x! * y! - z! * w!) * sy!, (1 - 2 * (x! * x! + z! * z!)) * sy!, 2 * (y! * z! + x! * w!) * sy!, 0,
    2 * (x! * z! + y! * w!) * sz!, 2 * (y! * z! - x! * w!) * sz!, (1 - 2 * (x! * x! + y! * y!)) * sz!, 0,
    tx!, ty!, tz!, 1,
  ];
}

export interface GlbFacts {
  triangles: number;
  /** World-space bounds of every drawn primitive, from the POSITION accessors' min and max. */
  min: [number, number, number];
  max: [number, number, number];
  textures: Array<{ width: number; height: number }>;
}

interface Gltf {
  asset?: { version?: string };
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  buffers?: Array<{ uri?: string; byteLength: number }>;
  bufferViews?: Array<{ buffer: number; byteOffset?: number; byteLength: number }>;
  accessors?: Array<{ count: number; min?: number[]; max?: number[] }>;
  images?: Array<{ uri?: string; bufferView?: number; mimeType?: string }>;
  meshes?: Array<{ primitives: Array<{ mode?: number; indices?: number; attributes: Record<string, number> }> }>;
  nodes?: Array<{ mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }>;
  scenes?: Array<{ nodes?: number[] }>;
  scene?: number;
}

/** Reads a GLB and checks the model rules. Throws in plain words on the first one it breaks. */
export function inspectGlb(bytes: Buffer): GlbFacts {
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67) throw new Error("It isn't a binary glTF (.glb) file.");
  if (bytes.readUInt32LE(4) !== 2) throw new Error("It isn't glTF 2.0.");
  if (bytes.readUInt32LE(8) !== bytes.length) throw new Error("Its declared length doesn't match the file.");
  const jsonLength = bytes.readUInt32LE(12);
  if (bytes.readUInt32LE(16) !== 0x4e4f534a) throw new Error("Its first chunk isn't JSON.");
  const gltf = JSON.parse(bytes.toString("utf8", 20, 20 + jsonLength)) as Gltf;
  if (!String(gltf.asset?.version ?? "").startsWith("2.")) throw new Error("It isn't glTF 2.0.");
  let bin: Buffer | null = null;
  const binAt = 20 + jsonLength;
  if (binAt + 8 <= bytes.length && bytes.readUInt32LE(binAt + 4) === 0x004e4942) bin = bytes.subarray(binAt + 8, binAt + 8 + bytes.readUInt32LE(binAt));
  const extensions = new Set([...(gltf.extensionsUsed ?? []), ...(gltf.extensionsRequired ?? [])]);
  if (extensions.has("KHR_draco_mesh_compression")) throw new Error("It uses Draco, which products can't decode yet. Meshopt is fine.");
  if ((gltf.buffers ?? []).some((b) => b.uri !== undefined)) throw new Error("It points to a buffer outside the file. Everything must be inside the .glb.");
  const textures: GlbFacts["textures"] = [];
  for (const img of gltf.images ?? []) {
    if (img.uri !== undefined || img.bufferView === undefined) throw new Error("A texture isn't embedded in the .glb.");
    const view = gltf.bufferViews?.[img.bufferView];
    if (!view || !bin) throw new Error("A texture's bytes are missing.");
    const size = imageSize(bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength));
    if (!size) throw new Error("A texture isn't PNG, JPEG or WebP.");
    if (size.width > TEXTURE_MAX_PX || size.height > TEXTURE_MAX_PX) throw new Error(`A texture is ${size.width} by ${size.height}, over 2048 px.`);
    textures.push({ width: size.width, height: size.height });
  }
  let triangles = 0;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const nodes = gltf.nodes ?? [];
  const visit = (index: number, parent: Mat4, depth: number) => {
    const node = nodes[index];
    if (!node || depth > 64) return;
    const world = multiply(parent, localMatrix(node));
    const mesh = node.mesh !== undefined ? gltf.meshes?.[node.mesh] : undefined;
    for (const p of mesh?.primitives ?? []) {
      if ((p.mode ?? 4) !== 4) continue;
      const count = p.indices !== undefined ? gltf.accessors?.[p.indices]?.count : gltf.accessors?.[p.attributes.POSITION!]?.count;
      triangles += Math.floor((count ?? 0) / 3);
      const pos = gltf.accessors?.[p.attributes.POSITION!];
      if (!pos?.min || !pos.max) throw new Error("A mesh's positions have no min and max, which glTF requires.");
      for (let corner = 0; corner < 8; corner++) {
        const v = [corner & 1 ? pos.max[0]! : pos.min[0]!, corner & 2 ? pos.max[1]! : pos.min[1]!, corner & 4 ? pos.max[2]! : pos.min[2]!];
        for (let axis = 0; axis < 3; axis++) {
          const w = world[axis]! * v[0]! + world[4 + axis]! * v[1]! + world[8 + axis]! * v[2]! + world[12 + axis]!;
          min[axis] = Math.min(min[axis]!, w);
          max[axis] = Math.max(max[axis]!, w);
        }
      }
    }
    for (const child of node.children ?? []) visit(child, world, depth + 1);
  };
  const roots = gltf.scenes?.[gltf.scene ?? 0]?.nodes ?? [];
  for (const root of roots) visit(root, IDENTITY, 0);
  if (!triangles) throw new Error("Its default scene draws no triangles.");
  if (triangles > MODEL_MAX_TRIANGLES) throw new Error(`It has ${triangles.toLocaleString("en-US")} triangles, over 50,000.`);
  return { triangles, min, max, textures };
}

const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.005, 0.02 * Math.max(Math.abs(a), Math.abs(b)));

/**
 * Checks one asset's files against its entry: size and sha256 for each, then what each file is. `read` gives a file's
 * bytes by its role's entry. Returns the problems, empty when it is good.
 */
export async function assetFileProblems(asset: Asset3d, read: (file: AssetFile) => Promise<Buffer>): Promise<string[]> {
  const problems: string[] = [];
  for (const f of asset.files) {
    const at = `${asset.id} ${f.role}`;
    let bytes: Buffer;
    try {
      bytes = await read(f);
    } catch (err) {
      problems.push(`${at}: couldn't be read (${err instanceof Error ? err.message : String(err)}).`);
      continue;
    }
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== f.bytes || sha !== f.sha256) {
      problems.push(`${at}: got ${bytes.length} bytes with sha256 ${sha}, the list says ${f.bytes} and ${f.sha256}.`);
      continue;
    }
    try {
      if (f.role === "glb") {
        const facts = inspectGlb(bytes);
        if (facts.triangles !== asset.triangles) problems.push(`${at}: it has ${facts.triangles} triangles, the list says ${asset.triangles}.`);
        const size = [facts.max[0] - facts.min[0], facts.max[1] - facts.min[1], facts.max[2] - facts.min[2]];
        if (asset.bbox && !(close(size[0]!, asset.bbox.x) && close(size[1]!, asset.bbox.y) && close(size[2]!, asset.bbox.z))) {
          problems.push(`${at}: its bounds are ${size.map((v) => v.toFixed(3)).join(" by ")} m, the list says ${asset.bbox.x} by ${asset.bbox.y} by ${asset.bbox.z}.`);
        }
        const height = size[1]!;
        if (Math.abs(facts.min[1]) > Math.max(0.005, 0.02 * height)) problems.push(`${at}: its base isn't at y = 0 (lowest point ${facts.min[1].toFixed(3)} m).`);
        if (!close((facts.max[0] + facts.min[0]) / 2, 0) || !close((facts.max[2] + facts.min[2]) / 2, 0)) problems.push(`${at}: its origin isn't at the centre of its base.`);
      } else if (f.role === "preview") {
        const size = imageSize(bytes);
        if (!size || size.type === "png") problems.push(`${at}: a preview is WebP or JPEG.`);
        else if (Math.max(size.width, size.height) !== PREVIEW_PX) problems.push(`${at}: a preview is 512 px on its long side, not ${Math.max(size.width, size.height)}.`);
      } else if (f.role === "hdr") {
        const size = hdrSize(bytes);
        if (!size) problems.push(`${at}: it isn't a Radiance RGBE file.`);
        else if (![1024, 2048].includes(size.width)) problems.push(`${at}: an HDRI is 1k or 2k wide, not ${size.width}.`);
      } else {
        const size = imageSize(bytes);
        if (!size) problems.push(`${at}: a texture is PNG, JPEG or WebP.`);
        else if (size.width > TEXTURE_MAX_PX || size.height > TEXTURE_MAX_PX) problems.push(`${at}: ${size.width} by ${size.height} is over 2048 px.`);
      }
    } catch (err) {
      problems.push(`${at}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return problems;
}
