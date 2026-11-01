// Platform file (Muse Muse platform services). Keep this file as it is.
//
// POST /api/musemuse/live-caption?session=&startMs=&endMs= with a WAV as its body: sends one piece of a person's speech
// to Muse Voice Transcribe through the gateway, and answers {text, startMs, endMs}. useCaptions calls it. Nothing is kept.
import { gatewayEnv } from "@/lib/meta/client";
import { VOICE_MODEL } from "@/lib/meta/voice";
import { identityHeaders, newVisitorId, visitorCookie, visitorId } from "@/lib/platform/identity";
import { userHeaders } from "@/lib/platform/user";

/** Ten seconds of 16 kHz WAV, the longest piece the gateway takes as a live chunk, with its header. */
const MOST_BYTES = 320_100;
const SESSION = /^[A-Za-z0-9_-]{8,64}$/;

const refuse = (error: string, status: number, code?: string, headers?: HeadersInit) => Response.json({ error, ...(code ? { code } : {}) }, { status, headers });

export async function POST(request: Request): Promise<Response> {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return refuse("This only works from the product's own page.", 403);
  const url = new URL(request.url);
  const session = url.searchParams.get("session") ?? "";
  const startMs = Number(url.searchParams.get("startMs"));
  const endMs = Number(url.searchParams.get("endMs"));
  if (!SESSION.test(session) || !Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs) return refuse("This piece of audio has no session or times.", 400);
  if (Number(request.headers.get("content-length") ?? 0) > MOST_BYTES) return refuse("This piece of audio is too long.", 413);
  const wav = await request.arrayBuffer();
  if (wav.byteLength > MOST_BYTES) return refuse("This piece of audio is too long.", 413);
  if (wav.byteLength <= 44) return refuse("This piece of audio is empty.", 400);

  // Caption minutes are per person, so a first piece gives this browser its id.
  const created = visitorId(request) ? null : newVisitorId();
  const form = new FormData();
  form.append("request", JSON.stringify({ model: VOICE_MODEL, audioEncoding: "WAV" }));
  form.append("audio", new Blob([wav], { type: "audio/wav" }), "chunk.wav");
  try {
    const { baseURL, apiKey } = gatewayEnv();
    const res = await fetch(`${baseURL}/asr/transcribe`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "x-musemuse-live": session, ...identityHeaders(request, created), ...userHeaders(request) },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    const reply = (await res.json().catch(() => ({}))) as { transcript?: unknown; error?: { message?: string; code?: string } };
    const headers = new Headers({ "cache-control": "no-store" });
    if (created) headers.append("set-cookie", visitorCookie(created));
    if (!res.ok) {
      const retry = res.headers.get("retry-after");
      if (retry) headers.set("retry-after", retry);
      return refuse(reply.error?.code === "quota_exceeded" ? (reply.error.message ?? "Captions have used today's minutes.") : "This piece of audio couldn't be read.", res.status, reply.error?.code, headers);
    }
    const text = typeof reply.transcript === "string" ? reply.transcript.replace(/​/g, "").trim() : "";
    return Response.json({ text, startMs, endMs }, { headers });
  } catch {
    return refuse("This piece of audio couldn't reach Muse Muse.", 502);
  }
}
