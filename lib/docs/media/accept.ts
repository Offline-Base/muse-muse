import type { SampleKind } from "@/lib/docs/media/samples";

/**
 * File input accept lists, as the kit's file slots and FilePicker use them: which sample kinds an accept list offers,
 * and whether a picked file matches it.
 */

const KIND_OF_TYPE: Array<[RegExp, SampleKind]> = [
  [/^image\//, "image"],
  [/^video\//, "video"],
  [/^audio\//, "audio"],
  [/^application\/pdf$/, "pdf"],
  [/^(text\/|application\/(json|jsonl|x-ndjson)$)/, "text"],
];

const KIND_OF_EXT: Record<string, SampleKind> = {
  jpg: "image",
  jpeg: "image",
  png: "image",
  webp: "image",
  gif: "image",
  mp4: "video",
  mov: "video",
  wav: "audio",
  mp3: "audio",
  m4a: "audio",
  pdf: "pdf",
  txt: "text",
  md: "text",
  json: "text",
  jsonl: "text",
};

/** The kind of a MIME type or file name, or null when no demo sends it. */
export function kindOf(file: { type?: string; name?: string }): SampleKind | null {
  const type = (file.type ?? "").toLowerCase();
  for (const [re, kind] of KIND_OF_TYPE) if (re.test(type)) return kind;
  const ext = /\.([a-z0-9]+)$/i.exec(file.name ?? "")?.[1]?.toLowerCase();
  return (ext && KIND_OF_EXT[ext]) || null;
}

/** The sample kinds an accept list allows. An empty list or "*" allows them all. */
export function acceptKinds(accept: string | undefined): SampleKind[] {
  const all: SampleKind[] = ["image", "video", "audio", "pdf", "text"];
  const items = (accept ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!items.length || items.includes("*") || items.includes("*/*")) return all;
  const kinds = new Set<SampleKind>();
  for (const item of items) {
    if (item.startsWith(".")) {
      const kind = KIND_OF_EXT[item.slice(1)];
      if (kind) kinds.add(kind);
      continue;
    }
    const base = item.endsWith("/*") ? `${item.slice(0, -1)}x` : item;
    const kind = kindOf({ type: base });
    if (kind) kinds.add(kind);
  }
  return all.filter((k) => kinds.has(k));
}

/** True when a file matches an accept list (by type, wildcard type, or extension). */
export function matchesAccept(file: { type?: string; name?: string }, accept: string | undefined): boolean {
  const items = (accept ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!items.length || items.includes("*") || items.includes("*/*")) return true;
  const type = (file.type ?? "").toLowerCase();
  const name = (file.name ?? "").toLowerCase();
  return items.some((item) =>
    item.startsWith(".") ? name.endsWith(item) : item.endsWith("/*") ? type.startsWith(item.slice(0, -1)) : type === item,
  );
}

const MIME_OF_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  jsonl: "application/jsonl",
};

/** A type from a file name, for content that comes back as application/octet-stream (GET /v1/files/{id}/content). */
export function mimeFromName(name: string): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return (ext && MIME_OF_EXT[ext]) || null;
}
