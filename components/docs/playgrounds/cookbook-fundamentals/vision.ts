/**
 * The vision-input recipe's request shapes on Chat Completions, and its self-contained test images: an image goes in
 * a user message as an image_url part (a public URL the server fetches, or a base64 data URL), several images go in
 * one message in the order listed, an image in a developer or system message is a 400, and
 * POST /v1/responses/input_tokens (with Responses' input_text and input_image parts) counts what an image costs
 * before you send it. solidPng is the recipe's standard-library PNG maker, ported: a solid-color square as a data URL.
 */

/** The recipe's own test image: 256 x 256, red left half and blue right half. */
export const RECIPE_TEST_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAAC/0lEQVR42u3TsQkAAAzDsPz/dDvngiwCX2BQLtEwD8Z5AAAAAgAAAQCAAABAAAAgAAAQAAAIAAAEAAACAAABAIAAAEAAACAAABAAAAgAAAQAAAIAAAEAgAAAQAAAIAAAEAAACAAABAAAAgAAAAQAAAIAAAEAgAAAQAAAIAAAEAAACAAABAAAAgAAAQCAAABAAAAgAAAQAAAIAAAEAAACAAABAIAAAEAAACAAABAAAAgAAAQAAAAIAAAEAAACAAABAIAAAEAAACAAABAAAAgAAAQAAAIAAAEAgAAAQAAAIAAAEAAACAAABAAAAgAAAQCAAABAAAAgAAAQAAAIAAAA8AAAAAQAAAIAAAEAgAAAQAAAIAAAEAAACAAABAAAAgAAAQCAAABAAAAgAAAQAAAIAAAEAAACAAABAIAAAEAAACAAABAAAAgAAGQAAAAIAAAEAAACAAABAIAAAEAAACAAABAAAAgAAAQAAAIAAAEAgAAAQAAAIAAAEAAACAAABAAAAgAAAQCAAABAAAAgAAAQAAAIAAAAEAAACAAABAAAAgAAAQCAAABAAAAgAAAQAAAIAAAEAAACAAABAIAAAEAAACAAABAAAAgAAAQAAAIAAAEAgAAAQAAAIAAAEAAAAOABAAAIAAAEAAACAAABAIAAAEAAACAAABAAAAgAAAQAAAIAAAEAgAAAQAAAIAAAEAAACAAABAAAAgAAAQCAAABAAAAgAAAQAADIAwAAEAAACAAABAAAAgAAAQCAAABAAAAgAAAQAAAIAAAEAAACAAABAIAAAEAAACAAABAAAAgAAAQAAAIAAAEAgAAAQAAAIAAAEAAAACAAABAAAAgAAAQAAAIAAAEAgAAAQAAAIAAAEAAACAAABAAAAgAAAQCAAABAAAAgAAAQAAAIAAAEAAACAAABAIAAAEAAACAAAADAAwAAEAAACAAABAAAAgAAAQCAAABAAAAgAAAQAAAIAAAEAAACAAABAIAAAEAAACAAABAAAAgAAAQAAAIAAAEAgLoHSlsO8jZgvpcAAAAASUVORK5CYII=";

/** The recipe's three swatches. */
export const SWATCHES: ReadonlyArray<{ name: string; rgb: readonly [number, number, number] }> = [
  { name: "red", rgb: [220, 30, 30] },
  { name: "green", rgb: [30, 200, 60] },
  { name: "blue", rgb: [30, 60, 220] },
];

/** Public images the API's fetcher can reach, from Meta's segment-anything repository (Apache 2.0). */
export const URL_SAMPLES: ReadonlyArray<{ label: string; url: string }> = [
  { label: "Dog", url: "https://raw.githubusercontent.com/facebookresearch/segment-anything/main/notebooks/images/dog.jpg" },
  { label: "Truck", url: "https://raw.githubusercontent.com/facebookresearch/segment-anything/main/notebooks/images/truck.jpg" },
  { label: "Groceries", url: "https://raw.githubusercontent.com/facebookresearch/segment-anything/main/notebooks/images/groceries.jpg" },
];

/** A structured analysis the reply must match (strict json_schema on Chat Completions' response_format). */
export const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "One sentence on what the image shows." },
    objects: { type: "array", items: { type: "string" }, description: "The main things in it." },
    colors: { type: "array", items: { type: "string" }, description: "The dominant colors." },
    setting: { type: "string", enum: ["indoor", "outdoor", "screen", "document", "abstract"] },
    text_in_image: { type: "string", description: "Any words visible in the image, or an empty string." },
  },
  required: ["summary", "objects", "colors", "setting", "text_in_image"],
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------------------------------------------
// PNG, the standard-library way

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/** zlib with stored (uncompressed) deflate blocks: valid everywhere, and a solid swatch is small anyway. */
function zlibStored(data: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(data.length / 65535));
  const out = new Uint8Array(2 + blocks * 5 + data.length + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let o = 2;
  for (let b = 0; b < blocks; b++) {
    const start = b * 65535;
    const len = Math.min(65535, data.length - start);
    out[o++] = b === blocks - 1 ? 1 : 0;
    out[o++] = len & 0xff;
    out[o++] = len >>> 8;
    out[o++] = ~len & 0xff;
    out[o++] = (~len >>> 8) & 0xff;
    out.set(data.subarray(start, start + len), o);
    o += len;
  }
  out.set(u32(adler32(data)), o);
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + data.length);
  for (let i = 0; i < 4; i++) body[i] = type.charCodeAt(i);
  body.set(data, 4);
  const out = new Uint8Array(12 + data.length);
  out.set(u32(data.length), 0);
  out.set(body, 4);
  out.set(u32(crc32(body)), 8 + data.length);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** The recipe's solid_png: a size x size solid-color PNG as a data URL. */
export function solidPng(rgb: readonly [number, number, number], size = 64): string {
  const ihdr = new Uint8Array([...u32(size), ...u32(size), 8, 2, 0, 0, 0]);
  const row = new Uint8Array(1 + size * 3);
  for (let x = 0; x < size; x++) row.set(rgb, 1 + x * 3);
  const raw = new Uint8Array(row.length * size);
  for (let y = 0; y < size; y++) raw.set(row, y * row.length);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlibStored(raw)), chunk("IEND", new Uint8Array())];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    png.set(p, o);
    o += p.length;
  }
  return `data:image/png;base64,${bytesToBase64(png)}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Requests

export interface VisionAsk {
  model: string;
  question: string;
  /** Image URLs: https:// for the server to fetch, or data: URLs inline. */
  images: string[];
  /** "developer" puts the image in a developer message: the recipe's HTTP 400. */
  role?: "user" | "developer";
  effort?: string | null;
  /** Ask for the structured analysis. */
  structured?: boolean;
}

/** The Chat Completions body for a vision question, in the recipe's shapes. */
export function visionChatBody(a: VisionAsk): Record<string, unknown> {
  const parts = a.images.map((url) => ({ type: "image_url", image_url: { url } }));
  const messages =
    a.role === "developer"
      ? [
          { role: "developer", content: [{ type: "text", text: "Reference image:" }, ...parts] },
          { role: "user", content: a.question },
        ]
      : [{ role: "user", content: [{ type: "text", text: a.question }, ...parts] }];
  const body: Record<string, unknown> = { model: a.model, messages };
  if (a.effort) body.reasoning_effort = a.effort;
  if (a.structured) body.response_format = { type: "json_schema", json_schema: { name: "image_analysis", schema: ANALYSIS_SCHEMA, strict: true } };
  return body;
}

/** The recipe's count_input_tokens body: Responses input with input_text and, when given, input_image parts. */
export function inputTokensBody(model: string, question: string, images: string[] = []): Record<string, unknown> {
  return {
    model,
    input: [{ role: "user", content: [{ type: "input_text", text: question }, ...images.map((image_url) => ({ type: "input_image", image_url }))] }],
  };
}

/** Image types the recipe lists for image_url. */
export const IMAGE_TYPES = ["jpeg", "jpg", "png", "gif", "webp", "x-icon"];

/** True for a URL the API's fetcher could reach: https, not this machine. */
export function isPublicImageUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !/^(localhost|127\.|10\.|192\.168\.|\[::1\])/.test(u.hostname);
  } catch {
    return false;
  }
}
