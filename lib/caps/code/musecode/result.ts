import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { MUSE_CODE_LIMITS } from "@/lib/caps/code/musecode/limits";
import { redactBytes, redactText } from "@/lib/caps/code/musecode/redact";

/**
 * A Muse Code session's result (docs/CAPABILITIES.md, 15b; the spike's "The binary"). The session's sandbox packs its
 * workspace as a tar, and the platform builds the zip itself from that tar's bytes, so nothing the agent did inside
 * the VM (it has every capability there) can slip a file past these rules:
 *
 *   - the workspace only: paths are relative, with no `..`, no drive, control characters or direction marks, and the
 *     folders in LEFT_OUT_DIRS are left out in any case
 *   - regular files only: a symlink, hard link, device or folder entry is never followed or kept
 *   - no ELF files (Linux programs), and no file whose sha256 matches the Muse Code binary or its helpers, hashed before
 *     the session started
 *   - at most 10 MB a file, 50 MB and 500 files in all
 *   - every file scanned for the platform's secrets and the session's token, and each hit redacted. A file whose name
 *     holds one is left out, and no name kept or listed shows it
 *
 * A piece of the binary split under the caps could still leave (the spike's open point). That is in the owner's terms
 * decision for visitors (decision 10), and stays open.
 */

export interface ResultFile {
  path: string;
  bytes: number;
}

export interface DroppedFile {
  path: string;
  why: string;
}

export interface SessionResultFiles {
  /** The zip's bytes, or null when no file was kept. */
  zip: Buffer | null;
  files: ResultFile[];
  dropped: DroppedFile[];
  /** Secret values found and redacted in the files. */
  secretHits: number;
}

/** Folders a result never includes. */
export const LEFT_OUT_DIRS = ["node_modules", ".git", ".muse", ".venv", "__pycache__"] as const;
const LEFT_OUT = new Set<string>(LEFT_OUT_DIRS);
/** Characters a name in a zip must not carry: controls and direction marks mislead, and `:` is a drive or a stream on Windows. */
// eslint-disable-next-line no-control-regex
const BAD_NAME = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069:\\]/;
const isLeftOut = (part: string) => LEFT_OUT.has(part.toLowerCase());

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

interface TarEntry {
  path: string;
  type: string;
  data: Buffer;
  /** The entry said it was bigger than the tar we have. */
  truncated: boolean;
}

function cString(buf: Buffer): string {
  const end = buf.indexOf(0);
  return buf.subarray(0, end < 0 ? buf.length : end).toString("utf8");
}

function octal(buf: Buffer): number {
  // Base-256 (a size too big for octal) is never something a result keeps.
  if (buf[0]! & 0x80) return Number.MAX_SAFE_INTEGER;
  const text = cString(buf).trim();
  const n = text ? parseInt(text, 8) : 0;
  return Number.isFinite(n) && n >= 0 ? n : -1;
}

/** The entries of a tar (ustar, GNU long names, pax paths). Stops at the end blocks, a bad header or the end of `tar`. */
export function readTar(tar: Buffer): TarEntry[] {
  const out: TarEntry[] = [];
  let at = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;
  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const size = octal(header.subarray(124, 136));
    if (size < 0) break;
    const type = String.fromCharCode(header[156] ?? 0);
    const name = cString(header.subarray(0, 100));
    const magic = header.subarray(257, 263).toString("latin1");
    const prefix = magic.startsWith("ustar") ? cString(header.subarray(345, 500)) : "";
    const start = at + 512;
    const end = start + size;
    const data = tar.subarray(start, Math.min(end, tar.length));
    const truncated = end > tar.length;
    at = start + Math.ceil(Math.min(size, tar.length) / 512) * 512;
    if (type === "L") {
      longName = cString(data);
      continue;
    }
    if (type === "x") {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString("utf8"));
      paxPath = m ? m[1]! : null;
      continue;
    }
    if (type === "g") continue;
    const path = paxPath ?? longName ?? (prefix ? `${prefix}/${name}` : name);
    longName = null;
    paxPath = null;
    out.push({ path, type, data, truncated });
    if (truncated) break;
  }
  return out;
}

/** A workspace-relative path as the zip keeps it, or null when it isn't one. */
export function cleanResultPath(raw: string): string | null {
  const p = raw.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (!p || p.startsWith("/") || BAD_NAME.test(p) || p.length > 400) return null;
  const parts = p.split("/");
  if (parts.some((s) => !s || s === "." || s === "..")) return null;
  if (parts.some(isLeftOut)) return null;
  return p;
}

/** The workspace's files as the result keeps them, and the zip. `binaryHashes` are sha256 hex of the Muse Code programs. */
export function resultFromTar(
  tar: Buffer,
  opts: {
    binaryHashes: readonly string[];
    secrets: readonly string[];
    /** The tar was read up to its cap, so more of it may not have been read. */
    cut?: boolean;
    /** The paths the pack left out for size. */
    skipped?: readonly string[];
    limits?: Partial<Record<"resultFileMaxBytes" | "resultMaxBytes" | "resultMaxFiles", number>>;
  },
): SessionResultFiles {
  const limits = { resultFileMaxBytes: MUSE_CODE_LIMITS.resultFileMaxBytes, resultMaxBytes: MUSE_CODE_LIMITS.resultMaxBytes, resultMaxFiles: MUSE_CODE_LIMITS.resultMaxFiles, ...(opts.limits ?? {}) };
  const banned = new Set(opts.binaryHashes.map((h) => h.toLowerCase()));
  const kept: Array<{ path: string; data: Buffer }> = [];
  const dropped: DroppedFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  let secretHits = 0;
  const shownName = (raw: string) => redactText(raw, opts.secrets).text.slice(0, 200);
  const nameHoldsSecret = (name: string) => redactText(name, opts.secrets).hits > 0;
  for (const name of opts.skipped ?? []) {
    const path = cleanResultPath(name);
    if (path) dropped.push({ path: shownName(path), why: `bigger than ${Math.round(limits.resultFileMaxBytes / 1024 / 1024)} MB` });
  }
  const entries = readTar(tar);
  for (const entry of entries) {
    if (entry.type === "5") continue; // a folder: its files speak for it
    const path = cleanResultPath(entry.path);
    if (!path) {
      // The workspace's own root entry and the folders left out on purpose are skipped quietly.
      const quiet = /^(\.\/?)?$/.test(entry.path) || entry.path.split("/").some(isLeftOut);
      if (!quiet) dropped.push({ path: shownName(entry.path), why: "not a path inside the workspace" });
      continue;
    }
    if (nameHoldsSecret(path)) {
      dropped.push({ path: shownName(path), why: "its name held a secret, so it was left out" });
      continue;
    }
    if (entry.type !== "0" && entry.type !== "\0" && entry.type !== "7") {
      dropped.push({ path, why: entry.type === "2" ? "a link, which a result never follows" : entry.type === "1" ? "a hard link" : "not a plain file" });
      continue;
    }
    if (seen.has(path)) continue;
    seen.add(path);
    if (entry.truncated) {
      dropped.push({ path, why: `over the ${Math.round(limits.resultMaxBytes / 1024 / 1024)} MB a result may hold` });
      continue;
    }
    if (entry.data.length > limits.resultFileMaxBytes) {
      dropped.push({ path, why: `bigger than ${Math.round(limits.resultFileMaxBytes / 1024 / 1024)} MB` });
      continue;
    }
    if (entry.data.subarray(0, 4).equals(ELF_MAGIC)) {
      dropped.push({ path, why: "a program file, which a result never includes" });
      continue;
    }
    if (banned.has(createHash("sha256").update(entry.data).digest("hex"))) {
      dropped.push({ path, why: "a copy of the Muse Code program, which a result never includes" });
      continue;
    }
    if (kept.length >= limits.resultMaxFiles) {
      dropped.push({ path, why: `over the ${limits.resultMaxFiles} files a result may hold` });
      continue;
    }
    if (total + entry.data.length > limits.resultMaxBytes) {
      dropped.push({ path, why: `over the ${Math.round(limits.resultMaxBytes / 1024 / 1024)} MB a result may hold` });
      continue;
    }
    const clean = redactBytes(Buffer.from(entry.data), opts.secrets);
    secretHits += clean.hits;
    total += entry.data.length;
    kept.push({ path, data: clean.bytes });
  }
  if (opts.cut || entries.at(-1)?.truncated) dropped.push({ path: "(the rest of the workspace)", why: "Other files were left out: the workspace was bigger than a result can read" });
  return { zip: kept.length ? zipFiles(kept) : null, files: kept.map((f) => ({ path: f.path, bytes: f.data.length })), dropped: dropped.slice(0, 200), secretHits };
}

// ---------- A small zip writer: deflate or store, UTF-8 names, no zip64 (a result is at most 50 MB) ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Zips files in order. Each is deflated unless that doesn't make it smaller. */
export function zipFiles(files: ReadonlyArray<{ path: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  // 1980-01-01 00:00, a fixed time, so the same files make the same zip.
  const dosTime = 0;
  const dosDate = (0 << 9) | (1 << 5) | 1;
  for (const f of files) {
    const name = Buffer.from(f.path, "utf8");
    const crc = crc32(f.data);
    const deflated = deflateRawSync(f.data);
    const store = deflated.length >= f.data.length;
    const body = store ? f.data : deflated;
    const method = store ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 * 0x10000) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}
