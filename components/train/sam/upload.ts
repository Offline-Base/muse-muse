import { downscaleImage } from "@/lib/docs/media/downscale";
import { SAM_PHOTO_MAX_SIDE } from "@/lib/train/sam/photo";
import { SAM_TUNE_LIMITS } from "@/lib/train/sam/types";

/** A base64 photo of the byte cap, as a data URL: about 4/3 of it. */
const DATA_URL_MAX = Math.floor((SAM_TUNE_LIMITS.uploadMaxBytes * 4) / 3) - 64;

/** A picked file shrunk to 1024 px and 400 KB as a JPEG data URL, the way /photos takes it. */
export async function photoDataUrl(file: File): Promise<string> {
  const small = await downscaleImage(file, { maxSide: SAM_PHOTO_MAX_SIDE, maxDataUrl: DATA_URL_MAX, type: "image/jpeg" });
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read that photo."));
    reader.readAsDataURL(small.blob);
  });
}

/** Sends one photo; the server's sentence when it is refused. */
export async function sendPhoto(runId: string, file: File, kind: "photo" | "lookalike"): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; message: string }> {
  let image: string;
  try {
    image = await photoDataUrl(file);
  } catch {
    return { ok: false, message: `Couldn't read ${file.name}. Try a JPEG or PNG.` };
  }
  return postJson(`/api/train/sam/${runId}/photos`, { image, kind });
}

/** POST or PATCH a JSON body; the reply, or the server's sentence. */
export async function postJson(url: string, body: unknown, method: "POST" | "PATCH" = "POST"): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; message: string; status?: number }> {
  try {
    const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return { ok: true, body: json };
    const message = typeof json.message === "string" ? json.message : `That didn't work (${res.status}).`;
    return { ok: false, message, status: res.status };
  } catch {
    return { ok: false, message: "Couldn't reach the server. Check the connection and try again." };
  }
}
