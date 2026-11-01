import { resolveCapCaller, subjectKey } from "@/lib/caps/principal";
import { LIVE_LIMITS } from "@/lib/caps/live/limits";
import { capMarker } from "@/lib/caps/ids";
import { gatewayError } from "@/lib/gateway/errors";
import type { ParsedRequest } from "@/lib/gateway/extract";

/**
 * Near-live captions at the Meta gateway (docs/CAPABILITIES.md, section 13). A chunk is an ordinary
 * POST /v1/asr/transcribe, on the product's Meta budget, with x-musemuse-live naming its caption session. For a token with
 * cap:live, while the live cap is served, such a call counts under its own per-IP key with a higher limit, since a chunk
 * every 2 to 3 seconds would hit the usual 20 a minute and use up that person's other calls with it. It also counts against
 * LIVE_CAPTION_MINUTES. lib/gateway/handler.ts calls these two
 * functions from its marked lines; with the cap off its deps have no liveCaptions and neither runs, so the header means
 * nothing.
 */

export const LIVE_HEADER = "x-musemuse-live";
const SESSION = /^[A-Za-z0-9_-]{8,64}$/;
/** Meta takes 16 kHz or 24 kHz. Counting from bytes at 16 kHz never counts a chunk as shorter than it is. */
const WAV_BYTES_PER_SECOND = 32_000;
/** Each piece repeats this much of the one before, so words aren't cut. It isn't new talk, so it costs nothing. */
const OVERLAP_TENTHS = 4;

export interface LiveCaptionDeps {
  /** LIVE_CAPTION_MINUTES: audio minutes per visitor per UTC day. */
  minutesPerDay: number;
}

/** What the handler needs of its own deps for these. GatewayDeps has them. */
export interface LiveCaptionCounters {
  reserveCounter(key: string, windowStart: Date, amount: number, limit: number): Promise<number | null>;
  adjustCounter(key: string, windowStart: Date, delta: number): Promise<void>;
  hitRateLimits(keys: string[], windowStart: Date): Promise<Record<string, number>>;
}

export interface LiveChunk {
  /** What it costs of the day's caption minutes, in tenths of a second. */
  tenths: number;
  perIp: { prefix: string; limit: number };
}

/** The token fields used here. A build token's row also has its build. */
interface LiveToken {
  productId: string;
  scope: string;
  allowedModels: string[];
  buildId?: string | null;
}

const invalid = (code: string, message: string) => gatewayError(400, "invalid_request_error", code, message, { retry: false });

/**
 * Whether this call is a live chunk: null when it isn't (another endpoint, no header, a token without cap:live), the
 * chunk, or the refusal. Only real chunks get the higher limit, so a long file or an audioUrl can't use it.
 */
export function liveChunkOf(req: Request, endpoint: string, parsed: ParsedRequest, token: LiveToken): LiveChunk | Response | null {
  if (endpoint !== "asr/transcribe") return null;
  const session = req.headers.get(LIVE_HEADER);
  if (session === null || !token.allowedModels.includes(capMarker("live"))) return null;
  if (!SESSION.test(session)) return invalid("invalid_live_session", `${LIVE_HEADER} must be 8 to 64 letters, digits, dashes or underscores.`);
  if (parsed.kind !== "multipart") return invalid("invalid_live_chunk", "A live chunk is a multipart WAV, not a link to one.");
  const audio = parsed.form.get("audio");
  if (!audio || typeof audio === "string") return invalid("invalid_live_chunk", 'A live chunk needs its WAV in the "audio" part.');
  const seconds = Math.max(1, Math.ceil(audio.size / WAV_BYTES_PER_SECOND));
  if (seconds > LIVE_LIMITS.chunkMaxSeconds) return invalid("live_chunk_too_long", `A live chunk can be at most ${LIVE_LIMITS.chunkMaxSeconds} seconds.`);
  const tenths = Math.max(10, Math.ceil(audio.size / (WAV_BYTES_PER_SECOND / 10)) - OVERLAP_TENTHS);
  return { tenths, perIp: { prefix: "live-ip", limit: LIVE_LIMITS.asrPerIpPerMinute } };
}

const nextUtcDay = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));

/** How many caption minutes each key may use today, for this caller: their own, then their address's. */
function captionKeys(req: Request, token: LiveToken, minutes: number, now: Date): Array<{ key: string; tenths: number; shared: boolean }> {
  const caller = resolveCapCaller(req, { productId: token.productId, scope: token.scope, buildId: token.buildId ?? null }, now);
  const base = `live-captions:${token.scope}:${token.productId}`;
  const person = caller.visitor ? subjectKey("visitor", token.productId, caller.visitor) : caller.user ? subjectKey("user", token.productId, caller.user) : null;
  const day = minutes * 600;
  const wider = day * LIVE_LIMITS.captionMinutesIpTimes;
  return [
    ...(person ? [{ key: `${base}:who:${person}`, tenths: day, shared: false }] : []),
    // With no visitor and no address (a server calling with no identity), the product shares one wider allowance.
    ...(caller.ip ? [{ key: `${base}:ip:${caller.ip}`, tenths: wider, shared: true }] : person ? [] : [{ key: `${base}:product`, tenths: wider, shared: true }]),
  ];
}

/**
 * Takes the chunk's new audio from today's caption minutes, or the refusal. Records a build's chunk for its proof: that
 * count means the gateway accepted a chunk, not that Meta answered. The helper's own record is what needs real replies.
 */
export async function spendLiveSeconds(req: Request, token: LiveToken, chunk: LiveChunk, live: LiveCaptionDeps, counters: LiveCaptionCounters, now: Date): Promise<Response | null> {
  const day = nextUtcDay(now);
  const taken: string[] = [];
  for (const { key, tenths, shared } of captionKeys(req, token, live.minutesPerDay, now)) {
    const total = await counters.reserveCounter(key, day, chunk.tenths, tenths);
    if (total === null) {
      for (const back of taken) await counters.adjustCounter(back, day, -chunk.tenths);
      const retry = Math.max(60, Math.ceil((day.getTime() - now.getTime()) / 1000));
      const message = shared ? "Captions have used today's minutes for this network, which everyone connected through it shares. They reset at 00:00 UTC." : `Captions have used today's ${live.minutesPerDay} minutes for this person. They reset at 00:00 UTC.`;
      return gatewayError(429, "insufficient_quota", "quota_exceeded", message, { retry: false, headers: { "retry-after": String(retry) } });
    }
    taken.push(key);
  }
  if (token.scope === "build" && token.buildId) await counters.hitRateLimits([liveProofKey("chunks", token.buildId)], now);
  return null;
}

/**
 * A count for /caps/proof: a rate_limits row per moment, so a verify's `since` counts exactly what happened after it.
 * The hourly prune removes them.
 */
export const liveProofKey = (what: "chunks" | "tickets" | "streams" | "events", buildId: string) => `live-proof:${what}:${buildId}`;
