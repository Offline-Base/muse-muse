/**
 * Base64 and data URLs for the docs demos. Meta's API takes media inline as data URLs (image_url, video_url, file_data)
 * or bare base64 (input_audio.data), so every picked file passes through here. Written for the browser and Node alike
 * (atob and btoa exist in both), so the size math is testable.
 */

/** Encodes bytes as standard base64, in chunks so a multi-megabyte file doesn't overflow the call stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Decodes standard base64 (whitespace is ignored). Throws on characters outside the alphabet. */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Length of the base64 text for `byteLength` raw bytes, padding included. */
export function base64Length(byteLength: number): number {
  return 4 * Math.ceil(byteLength / 3);
}

/** Length of `data:<mime>;base64,<...>` for `byteLength` raw bytes. */
export function dataUrlLength(byteLength: number, mime: string): number {
  return `data:${mime};base64,`.length + base64Length(byteLength);
}

/** The most raw bytes whose data URL stays within `maxLength` characters. */
export function maxBytesForDataUrl(maxLength: number, mime: string): number {
  const room = maxLength - `data:${mime};base64,`.length;
  return room <= 0 ? 0 : Math.floor(room / 4) * 3;
}

export function toDataUrl(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

/** Splits a base64 data URL into its type and bytes, or null when it isn't one. */
export function parseDataUrl(url: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]*)((?:;[^;,=]+=[^;,]*)*);base64,(.*)$/s.exec(url);
  if (!m) return null;
  try {
    return { mime: m[1] || "application/octet-stream", bytes: base64ToBytes(m[3]) };
  } catch {
    return null;
  }
}

/** Reads a file or blob as a data URL. `mime` overrides the blob's own type (some pickers report none). */
export async function fileToDataUrl(blob: Blob, mime?: string): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return toDataUrl(mime || blob.type || sniffMime(bytes) || "application/octet-stream", bytes);
}

/** Reads a file or blob as bare base64, for fields such as input_audio.data. */
export async function fileToBase64(blob: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

function ascii(bytes: Uint8Array, start: number, text: string): boolean {
  if (bytes.length < start + text.length) return false;
  for (let i = 0; i < text.length; i++) if (bytes[start + i] !== text.charCodeAt(i)) return false;
  return true;
}

/**
 * The media type from a file's first bytes, for the formats the demos handle. Muse Image returns bare base64 (WebP by
 * default), and a picked file can arrive without a type, so the bytes decide.
 */
export function sniffMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (ascii(bytes, 0, "\x89PNG\r\n\x1a\n")) return "image/png";
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) return "image/webp";
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WAVE")) return "audio/wav";
  if (ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a")) return "image/gif";
  if (ascii(bytes, 0, "%PDF-")) return "application/pdf";
  if (ascii(bytes, 4, "ftyp")) {
    if (ascii(bytes, 8, "qt  ")) return "video/quicktime";
    if (ascii(bytes, 8, "M4A ")) return "audio/mp4";
    return "video/mp4";
  }
  if (ascii(bytes, 0, "\x1aE\xdf\xa3")) return "video/webm";
  if (ascii(bytes, 0, "ID3") || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  if (ascii(bytes, 0, "OggS")) return "audio/ogg";
  return null;
}

/** The type of a base64 image from its first bytes, defaulting to WebP (Muse Image's default output). */
export function base64ImageMime(b64: string): string {
  try {
    // 16 characters are 12 bytes, enough for every signature sniffMime reads.
    return sniffMime(base64ToBytes(b64.slice(0, 16))) ?? "image/webp";
  } catch {
    return "image/webp";
  }
}

/** "412 KB", "1.4 MB": file sizes for labels, in the binary units browsers and Finder use. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
