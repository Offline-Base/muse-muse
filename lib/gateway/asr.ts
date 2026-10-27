import { AUDIO_URL_HOST_SUFFIX, DEFAULT_LIMITS } from "@/lib/gateway/policy";

/**
 * The asr/transcribe JSON extension. Products send {model, audioUrl, language?} where audioUrl is a public Vercel Blob
 * URL of a 16 kHz mono WAV. The gateway downloads it and builds the multipart request Meta expects
 * (docs/SPIKES.md: a `request` JSON part with audioEncoding "WAV", plus an `audio` file part).
 * This keeps long audio clear of the 4.5 MB function body limit.
 */
export class AsrInputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 | 502 = 400,
    readonly code = "invalid_audio_url",
  ) {
    super(message);
  }
}

/** Only https URLs on public Vercel Blob storage, with no credentials and the default port. */
export function checkAudioUrl(raw: unknown): URL {
  if (typeof raw !== "string" || !raw) throw new AsrInputError("audioUrl must be a string.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AsrInputError("audioUrl is not a valid URL.");
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !host.endsWith(AUDIO_URL_HOST_SUFFIX) ||
    host.length <= AUDIO_URL_HOST_SUFFIX.length
  ) {
    throw new AsrInputError(`audioUrl must be an https URL on *${AUDIO_URL_HOST_SUFFIX} (upload it through /uploads).`);
  }
  return url;
}

function looksLikeWav(bytes: Uint8Array): boolean {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  return bytes.length > 44 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE";
}

/** Downloads at most `maxBytes`, refusing bigger files before or while reading. */
export async function downloadCapped(
  url: URL,
  fetchFn: typeof fetch,
  maxBytes: number = DEFAULT_LIMITS.asrAudioMaxBytes,
): Promise<Uint8Array<ArrayBuffer>> {
  let res: Response;
  try {
    res = await fetchFn(url, { redirect: "error", signal: AbortSignal.timeout(60_000) });
  } catch {
    throw new AsrInputError("Could not download audioUrl.", 502, "audio_download_failed");
  }
  if (!res.ok || !res.body) {
    throw new AsrInputError(`Downloading audioUrl returned HTTP ${res.status}.`, 400, "audio_download_failed");
  }
  const tooBig = () =>
    new AsrInputError(`The audio file is over ${Math.round(maxBytes / 1024 / 1024)} MB.`, 413, "audio_too_large");
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body.cancel().catch(() => {});
    throw tooBig();
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooBig();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(new ArrayBuffer(size));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Builds Meta's multipart transcribe request from the JSON extension body. */
export async function asrJsonToForm(json: Record<string, unknown>, fetchFn: typeof fetch): Promise<FormData> {
  const { audioUrl, model, ...rest } = json;
  if (typeof model !== "string" || !model) throw new AsrInputError("model is required.", 400, "missing_model");
  const url = checkAudioUrl(audioUrl);
  const audio = await downloadCapped(url, fetchFn);
  if (!looksLikeWav(audio)) {
    throw new AsrInputError("audioUrl must point to a WAV file (16 kHz or 24 kHz, mono, 16-bit PCM).", 400, "invalid_audio");
  }
  const request = { ...rest, model, audioEncoding: "WAV" };
  const form = new FormData();
  form.set("request", JSON.stringify(request));
  form.set("audio", new Blob([audio], { type: "audio/wav" }), "audio.wav");
  return form;
}
