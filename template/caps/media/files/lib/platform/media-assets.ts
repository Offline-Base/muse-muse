// Platform file (Muse Muse platform services). Don't edit: lib/platform/speech.ts uses it.
//
// The media service's large files (the speech model and the runtime that runs it) come from the Muse Muse gateway's
// public /assets route, one file per sha256, never from another site. fetchAsset downloads one, shows progress, checks
// its size and sha256 before anything uses it, and keeps it in the browser's Cache Storage so the next visit (or an
// offline one) doesn't download it again. The list below is the platform's (lib/caps/assets.json); a template test keeps
// the two in step. Browser only.

export interface MediaAsset {
  /** The platform's name for the file, as lib/caps/assets.json lists it. */
  name: string;
  bytes: number;
  sha256: string;
}

/** The files the speech helper needs, in the order it loads them. */
export const SPEECH_ASSETS = {
  runtime: { name: "onnxruntime-web/1.30.0/ort.wasm.bundle.min.mjs", bytes: 73054, sha256: "11e64bd8ffe11bd1a2a2f0d6275fdfbbba7262f0b76b99b53d228a8a22ef3d90" },
  wasm: { name: "onnxruntime-web/1.30.0/ort-wasm-simd-threaded.wasm", bytes: 14239897, sha256: "3398c10d07d229bd91b364548e130e0e51a8e5704b88c7c083ebbeb78842dee2" },
  encoder: { name: "speecht5_tts/encoder_model_quantized.onnx", bytes: 88402301, sha256: "407375255d220d8ddf81e9a06d4100f80f870f8446e77d4f20951d2a4c08a156" },
  decoder: { name: "speecht5_tts/decoder_model_merged_quantized.onnx", bytes: 71087100, sha256: "6afe602f82ecdb34a2db003f45ccc1419c77aaf0032c263b4f6a0f8bf5835798" },
  vocoder: { name: "speecht5_hifigan/model_quantized.onnx", bytes: 18251672, sha256: "d092ea63bbc7839f7317657b5f531ebb68377ee05ec866ec096dba25911f9feb" },
} as const satisfies Record<string, MediaAsset>;

/** Every file the media helpers may load, for the template test that compares it with lib/caps/assets.json. */
export const MEDIA_ASSETS: readonly MediaAsset[] = Object.values(SPEECH_ASSETS);

/** Bytes the speech helper downloads the first time. */
export const SPEECH_DOWNLOAD_BYTES = MEDIA_ASSETS.reduce((n, a) => n + a.bytes, 0);

/** A media helper's failure, in plain words the product can show as it is. */
export class MediaError extends Error {
  readonly code: "unsupported" | "unavailable" | "too_large" | "invalid" | "failed" | "stopped";
  constructor(code: MediaError["code"], message: string) {
    super(message);
    this.name = "MediaError";
    this.code = code;
  }
}

/** Where the gateway serves the files, from the build's env. Null when this product has no media service. */
export function assetsBaseUrl(): string | null {
  const base = process.env.NEXT_PUBLIC_MUSEMUSE_ASSETS_URL;
  return base ? base.replace(/\/+$/, "") : null;
}

/** The URL of one file by its sha256. */
export function assetUrl(asset: MediaAsset, base: string | null = assetsBaseUrl()): string {
  if (!base) throw new MediaError("unavailable", "This product can't reach the media files right now.");
  return `${base}/${asset.sha256}`;
}

const CACHE = "musemuse-media-v1";

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readAll(res: Response, total: number, onBytes?: (n: number) => void): Promise<ArrayBuffer> {
  if (!res.body || !onBytes) return res.arrayBuffer();
  const out = new Uint8Array(total);
  const reader = res.body.getReader();
  let at = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (at + value.length > total) throw new MediaError("invalid", "A media file was bigger than it should be.");
    out.set(value, at);
    at += value.length;
    onBytes(at);
  }
  return out.buffer.slice(0, at);
}

export interface FetchAssetOptions {
  base?: string | null;
  /** Bytes read so far of this file. */
  onBytes?: (bytes: number) => void;
  fetchImpl?: typeof fetch;
  /** Cache Storage, or null to skip it (tests). */
  cache?: CacheStorage | null;
  signal?: AbortSignal;
}

/**
 * One file, checked: its size and sha256 must match the platform's list, or it is refused and never kept. A cached copy
 * is checked again before use.
 */
export async function fetchAsset(asset: MediaAsset, opts: FetchAssetOptions = {}): Promise<ArrayBuffer> {
  const url = assetUrl(asset, opts.base === undefined ? assetsBaseUrl() : opts.base);
  const caches_ = opts.cache === undefined ? (typeof caches === "undefined" ? null : caches) : opts.cache;
  const store = caches_ ? await caches_.open(CACHE).catch(() => null) : null;
  const check = async (bytes: ArrayBuffer) => bytes.byteLength === asset.bytes && (await sha256Hex(bytes)) === asset.sha256;
  const hit = store ? await store.match(url).catch(() => undefined) : undefined;
  if (hit) {
    const bytes = await hit.arrayBuffer();
    if (await check(bytes)) {
      opts.onBytes?.(bytes.byteLength);
      return bytes;
    }
    await store?.delete(url).catch(() => false);
  }
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(url, { signal: opts.signal });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw new MediaError("stopped", "The download was stopped.");
    throw new MediaError("unavailable", "The media files couldn't be downloaded. Check the connection and try again.");
  }
  if (!res.ok) throw new MediaError("unavailable", `The media files aren't available right now (the server answered ${res.status}).`);
  const bytes = await readAll(res, asset.bytes, opts.onBytes);
  if (!(await check(bytes))) throw new MediaError("invalid", "A media file didn't match its checksum, so it wasn't used.");
  if (store) await store.put(url, new Response(bytes, { headers: { "content-type": "application/octet-stream" } })).catch(() => undefined);
  return bytes;
}

/** True when the browser already keeps every one of these files, so using them needs no download. */
export async function assetsCached(assets: readonly MediaAsset[], base: string | null = assetsBaseUrl()): Promise<boolean> {
  if (!base || typeof caches === "undefined") return false;
  const store = await caches.open(CACHE).catch(() => null);
  if (!store) return false;
  for (const a of assets) if (!(await store.match(assetUrl(a, base)).catch(() => undefined))) return false;
  return true;
}
