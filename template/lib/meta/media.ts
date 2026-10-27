import OpenAI from "openai";

/** Turns bytes into a base64 data URL for image_url, video_url, file_data or Muse Image inputs. */
export function toDataUrl(bytes: ArrayBuffer | Uint8Array, mimeType: string): string {
  const buf = bytes instanceof ArrayBuffer ? Buffer.from(new Uint8Array(bytes)) : Buffer.from(bytes);
  return `data:${mimeType};base64,${buf.toString("base64")}`;
}

/** Downloads a URL on the server and returns it as a data URL. The fallback when Meta can't fetch a URL itself. */
export async function fetchAsDataUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download the file (HTTP ${res.status}).`);
  const type = res.headers.get("content-type")?.split(";")[0] || "application/octet-stream";
  return toDataUrl(await res.arrayBuffer(), type);
}

/** True when Meta refused a media URL because the origin wouldn't serve it to Meta's fetcher (HTTP 400). */
export function isMediaUrlOriginError(err: unknown): boolean {
  if (!(err instanceof OpenAI.APIError) || err.status !== 400) return false;
  const body = (err.error ?? {}) as { code?: unknown; type?: unknown; message?: unknown };
  return /media_url_origin_error|failed to download media/i.test(`${body.code} ${body.type} ${body.message} ${err.message}`);
}
