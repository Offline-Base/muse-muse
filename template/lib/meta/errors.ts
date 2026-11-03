import OpenAI from "openai";
import { ContentFilterFinishReasonError, LengthFinishReasonError } from "openai/error";
import { RespondJsonError } from "./json";

/**
 * Why a model call failed, in a few causes a route can return and a page can explain. Server only.
 *
 * In an action route, catch around the model call and `return modelErrorResponse(err, "action_name")`. It logs one line
 * with the cause and answers with an error status and `{ error, cause, code?, retryAfterS? }`. Show `error` in a
 * role="alert" with a retry. Never answer 200 with a local substitute instead.
 */
export type ModelFailureCause =
  /** The call took too long and was stopped. */
  | "timeout"
  /** The gateway's per-run cap (turns, tool calls or dollars) for this run id is used up. Starting over won't help this run. */
  | "run_limit"
  /** Too many calls a minute, or too many at once. Wait and retry. */
  | "rate_limit"
  /** The product's daily budget, or Muse Muse's, is used up. */
  | "budget"
  /** The gateway or Meta refused this request: a bad input (an image type it can't read), a model not allowed, a policy. */
  | "refused"
  /** The model answered, but not in the shape asked for, even after a retry. */
  | "schema"
  /** Meta or the gateway had a server error, or couldn't be reached. */
  | "upstream"
  | "unknown";

export interface ModelFailure {
  cause: ModelFailureCause;
  /** The HTTP status for the route to answer with. */
  status: number;
  /** One plain sentence or two for the page: what happened and what to try. */
  message: string;
  /** The upstream error code when there was one (run_limit, rate_limited, media_url_origin_error). */
  code?: string;
  /** The upstream HTTP status, 0 when none came back. */
  upstreamStatus: number;
  /** Seconds to wait before a retry, when the gateway said. */
  retryAfterS?: number;
}

const STATUS: Record<ModelFailureCause, number> = {
  timeout: 504,
  run_limit: 429,
  rate_limit: 429,
  budget: 429,
  refused: 422,
  schema: 502,
  upstream: 502,
  unknown: 500,
};

/** What an error from a lib/meta helper means. Never throws. */
export function modelFailure(err: unknown): ModelFailure {
  const make = (cause: ModelFailureCause, message: string, extra: Partial<ModelFailure> = {}): ModelFailure => ({
    cause,
    status: STATUS[cause],
    message,
    upstreamStatus: 0,
    ...extra,
  });
  const name = err instanceof Error ? err.name : "";
  if (err instanceof OpenAI.APIConnectionTimeoutError || name === "TimeoutError" || name === "AbortError" || codeOf(err) === "timeout") {
    return make("timeout", "The model took too long to answer. Try again, or try a shorter input.", { code: "timeout" });
  }
  if (err instanceof RespondJsonError || err instanceof SyntaxError || name === "ZodError" || err instanceof LengthFinishReasonError) {
    return make("schema", "The model's answer didn't come back in the shape this app needs. Try again.");
  }
  if (err instanceof ContentFilterFinishReasonError) {
    return make("refused", "The model declined to answer this. Try different wording or another file.");
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return make("upstream", "Couldn't reach the model. Try again in a moment.");
  }
  const status = typeof (err as { status?: unknown })?.status === "number" ? ((err as { status: number }).status) : 0;
  const code = codeOf(err);
  const said = upstreamMessage(err);
  const retryAfterS = retryAfter(err);
  const extra = { upstreamStatus: status, ...(code ? { code } : {}), ...(retryAfterS ? { retryAfterS } : {}) };
  if (code === "run_limit") return make("run_limit", said || "This run used all the model calls it may make.", extra);
  if (code === "budget_exceeded" || code === "platform_paused" || code === "insufficient_quota") {
    return make("budget", said || "The model budget for today is used up. Try again tomorrow.", extra);
  }
  if (status === 429 || code === "rate_limited" || code === "too_many_in_flight") {
    return make("rate_limit", said || "Too many requests right now. Wait a few seconds and try again.", extra);
  }
  if (code === "decide_offline" || code === "decide_unavailable") return make("upstream", said || "The decision model isn't running right now.", extra);
  if (status === 408 || status === 504) return make("timeout", "The model took too long to answer. Try again, or try a shorter input.", extra);
  if (status >= 500) return make("upstream", `The model service had a problem (HTTP ${status}). Try again in a moment.`, extra);
  if (status >= 400) return make("refused", said ? `The model refused this request: ${said}` : `The model refused this request (HTTP ${status}).`, extra);
  return make("unknown", "Something went wrong calling the model. Try again.", extra);
}

/**
 * The route's answer to a failed model call: logs `[model] <action> failed: <cause> ...` for the server log, and returns
 * the error status with `{ error, cause, code?, retryAfterS? }`. A 429 carries retry-after when the gateway gave one.
 */
export function modelErrorResponse(err: unknown, action = "model call"): Response {
  const f = modelFailure(err);
  const detail = err instanceof Error ? err.message : String(err);
  console.error(`[model] ${action} failed: ${f.cause}${f.code ? ` (${f.code})` : ""}${f.upstreamStatus ? `, HTTP ${f.upstreamStatus}` : ""}: ${detail.slice(0, 300)}`);
  const headers: Record<string, string> = f.retryAfterS ? { "retry-after": String(f.retryAfterS) } : {};
  return Response.json(
    { error: f.message, cause: f.cause, ...(f.code ? { code: f.code } : {}), ...(f.retryAfterS ? { retryAfterS: f.retryAfterS } : {}) },
    { status: f.status, headers },
  );
}

function codeOf(err: unknown): string | undefined {
  const e = err as { code?: unknown; error?: { code?: unknown } } | null;
  const code = e?.code ?? e?.error?.code;
  return typeof code === "string" && code ? code : undefined;
}

/** The gateway's or Meta's own sentence, without the SDK's "429 " prefix. */
function upstreamMessage(err: unknown): string {
  const e = err as { message?: unknown; error?: { message?: unknown } } | null;
  const raw = typeof e?.error?.message === "string" ? e.error.message : typeof e?.message === "string" ? e.message : "";
  return raw.replace(/^\d{3}\s+/, "").replace(/\s+/g, " ").trim().slice(0, 300);
}

function retryAfter(err: unknown): number | undefined {
  const headers = (err as { headers?: unknown })?.headers;
  const value = headers instanceof Headers ? headers.get("retry-after") : null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : undefined;
}
