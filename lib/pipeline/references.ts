/**
 * Validation for what users send with a muse: the note and the references they uploaded to Blob. Pure, so routes and
 * tests share it.
 */
import type { Reference, ReferenceKind } from "@/lib/types";
import { localFileKey } from "@/lib/local-files";

export const MAX_REFERENCES = 8;
export const MAX_NOTE_CHARS = 4000;
export const MAX_REFERENCE_BYTES = 100 * 1024 * 1024;

/** What POST /api/inspirations/upload lets the browser upload. */
export const INSPO_CONTENT_TYPES = [
  "image/*",
  "video/mp4",
  "video/quicktime",
  "audio/wav",
  "audio/x-wav",
  "application/pdf",
] as const;

const KIND_TYPES: Record<Exclude<ReferenceKind, "image">, readonly string[]> = {
  video: ["video/mp4", "video/quicktime"],
  audio: ["audio/wav", "audio/x-wav"],
  pdf: ["application/pdf"],
};

/** The reference kind a content type belongs to, or null when it isn't allowed. */
export function kindForContentType(contentType: string): ReferenceKind | null {
  const ct = contentType.toLowerCase().split(";")[0]!.trim();
  if (/^image\/[a-z0-9.+-]+$/.test(ct)) return "image";
  for (const [kind, types] of Object.entries(KIND_TYPES)) {
    if (types.includes(ct)) return kind as ReferenceKind;
  }
  return null;
}

/** A public Vercel Blob URL under inspo/, which is where the upload route puts inspo (or its local stand-in). */
export function isInspoBlobUrl(raw: string): boolean {
  const local = localFileKey(raw);
  if (local) return local.startsWith("inspo/");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.port &&
    /^[a-z0-9-]+\.public\.blob\.vercel-storage\.com$/.test(url.hostname) &&
    url.pathname.startsWith("/inspo/") &&
    !url.pathname.includes("..")
  );
}

/**
 * A file name that is safe inside the sandbox's inspo/ folder: no directories, only letters, digits, dot, dash and
 * underscore, at most 80 characters with the extension kept.
 */
export function safeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const clean = (s: string) =>
    s
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/-{2,}/g, "-");
  const dot = base.lastIndexOf(".");
  const extBody = dot > 0 ? clean(base.slice(dot + 1)).replace(/[^A-Za-z0-9]/g, "").slice(0, 10) : "";
  const ext = extBody ? `.${extBody}` : "";
  const stem = clean(dot > 0 ? base.slice(0, dot) : base)
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 80 - ext.length)
    .replace(/[.-]+$/, "");
  return `${stem || "file"}${ext}`;
}

/** Adds -2, -3, ... before the extension until the name is unused. */
export function uniqueFileName(name: string, used: Set<string>): string {
  if (!used.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!used.has(candidate)) return candidate;
  }
}

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

/** A note is optional. Blank becomes null. */
export function validateNote(input: unknown): Validation<string | null> {
  if (input === null || input === undefined) return { ok: true, value: null };
  if (typeof input !== "string") return { ok: false, error: "The note must be text." };
  const note = input.trim();
  if (note.length > MAX_NOTE_CHARS) return { ok: false, error: `Keep the note under ${MAX_NOTE_CHARS} characters.` };
  return { ok: true, value: note || null };
}

/**
 * Checks each reference (Blob URL under inspo/, kind matching its content type, size within the limit) and returns
 * them with safe, unique file names. `prefix` is prepended to every file name, so refinements don't overwrite the
 * files an earlier build put in inspo/.
 */
export function validateReferences(input: unknown, opts: { prefix?: string } = {}): Validation<Reference[]> {
  if (input === undefined || input === null) return { ok: true, value: [] };
  if (!Array.isArray(input)) return { ok: false, error: "references must be a list." };
  if (input.length > MAX_REFERENCES) return { ok: false, error: `Add at most ${MAX_REFERENCES} files.` };
  const used = new Set<string>();
  const out: Reference[] = [];
  for (const [i, item] of input.entries()) {
    const n = i + 1;
    if (!item || typeof item !== "object") return { ok: false, error: `File ${n} is not valid.` };
    const r = item as Record<string, unknown>;
    if (typeof r.url !== "string" || !isInspoBlobUrl(r.url)) {
      return { ok: false, error: `File ${n} must be uploaded through Muse Muse first.` };
    }
    if (typeof r.contentType !== "string") return { ok: false, error: `File ${n} has no content type.` };
    const kind = kindForContentType(r.contentType);
    if (!kind) return { ok: false, error: `File ${n} is a type Muse Muse can't read.` };
    if (r.kind !== kind) return { ok: false, error: `File ${n} says it is ${String(r.kind)} but its type is ${r.contentType}.` };
    if (typeof r.size !== "number" || !Number.isFinite(r.size) || r.size < 0) {
      return { ok: false, error: `File ${n} has no size.` };
    }
    if (r.size > MAX_REFERENCE_BYTES) return { ok: false, error: `File ${n} is over 100 MB.` };
    if (typeof r.fileName !== "string" || !r.fileName.trim()) return { ok: false, error: `File ${n} has no name.` };
    const fileName = uniqueFileName(`${opts.prefix ?? ""}${safeFileName(r.fileName)}`, used);
    used.add(fileName);
    out.push({
      url: r.url,
      kind,
      fileName,
      contentType: r.contentType.toLowerCase().split(";")[0]!.trim(),
      size: Math.round(r.size),
    });
  }
  return { ok: true, value: out };
}
