import { DOCS_ENDPOINT_LIST, type DocsObjectKind } from "@/lib/docs/proxy/endpoints";
import { gatewayError, type GatewayErrorType } from "@/lib/gateway/errors";

/**
 * The docs proxy's own errors, in the gateway's shape ({ error: { type, code, message, param } }, so the kit and the
 * OpenAI SDK read them the same way), worded for someone reading the docs. They never carry a key, a cookie or an
 * upstream header.
 */

export function docsError(
  status: number,
  type: GatewayErrorType,
  code: string,
  message: string,
  opts: { retry?: boolean; headers?: Record<string, string> } = {},
): Response {
  const headers = { "cache-control": "no-store", ...opts.headers };
  return gatewayError(status, type, code, message, { ...opts, headers });
}

/** "12 s", "4 min", "3 h 20 min": how long until a limit resets. */
export function waitText(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** What a reader hears when Meta refuses Muse Muse's key, over HTTP or on the realtime socket. Says nothing about the key. */
export const KEY_REFUSED_MESSAGE =
  "The Meta Model API refused Muse Muse's key for live demos. That's on our side, not your request. Try again later.";

export const docsErrors = {
  unknownEndpoint(method: string, path: readonly string[]) {
    const shown = `/v1/${path.join("/")}`.slice(0, 200);
    return docsError(
      404,
      "not_found_error",
      "unknown_endpoint",
      `The live docs don't run ${method} ${shown}. They run: ${DOCS_ENDPOINT_LIST.join(", ")}.`,
      { retry: false },
    );
  },
  crossSite() {
    const message = "Live demos only run from the Muse Muse docs pages, not from other sites.";
    return docsError(403, "permission_error", "cross_site", message, { retry: false });
  },
  paused() {
    const message = "Live demos are paused right now. The docs and their code still work with your own key.";
    return docsError(503, "server_error", "docs_paused", message, { retry: false });
  },
  tooLarge(maxBytes: number) {
    return docsError(
      413,
      "invalid_request_error",
      "body_too_large",
      `Live demos take request bodies up to ${(maxBytes / 1024 / 1024).toFixed(1)} MB. Use a smaller file: the demos keep uploads under 3 MB.`,
      { retry: false },
    );
  },
  invalidBody(message: string) {
    return docsError(400, "invalid_request_error", "invalid_body", message, { retry: false });
  },
  invalidAudio(message: string) {
    return docsError(400, "invalid_request_error", "invalid_audio", message, { retry: false });
  },
  missingModel(label: string) {
    return docsError(400, "invalid_request_error", "missing_model", `${label} needs a "model".`, { retry: false });
  },
  modelNotFound(model: string, label: string, allowed: readonly string[]) {
    return docsError(
      404,
      "invalid_request_error",
      "model_not_found",
      `The live docs don't run "${model.slice(0, 64)}" on ${label}. Try one of: ${allowed.join(", ")}.`,
      { retry: false },
    );
  },
  notOwned(kind: DocsObjectKind, id: string) {
    const shown = id.slice(0, 128);
    return docsError(
      404,
      "not_found_error",
      "not_found",
      kind === "file"
        ? `No file "${shown}" was uploaded from this browser. Live demos can use only files you uploaded here in the last hour.`
        : `No response "${shown}" was created from this browser. Live demos can use only responses you made here in the last day.`,
      { retry: false },
    );
  },
  unsupportedBackground(message: string) {
    return docsError(400, "invalid_request_error", "unsupported_background", message, { retry: false });
  },
  refusedReference(message: string) {
    return docsError(400, "invalid_request_error", "unsupported_reference", message, { retry: false });
  },
  rateLimited(scope: "minute" | "day", limit: number, retryAfterSec: number) {
    const message =
      scope === "minute"
        ? `Live demos are limited to ${limit} runs a minute. Try again in ${waitText(retryAfterSec)}.`
        : `Live demos are limited to ${limit} runs a day from one network. They reset at 00:00 UTC, in ${waitText(retryAfterSec)}.`;
    const headers = { "retry-after": String(retryAfterSec) };
    return docsError(429, "rate_limit_error", "rate_limited", message, { headers });
  },
  modelBusy(model: string, limit: number, retryAfterSec: number) {
    return docsError(
      429,
      "rate_limit_error",
      "model_busy",
      `Live demos on ${model} are busy: every reader together gets ${limit} runs a minute on it, to stay inside Meta's limits. ` +
        `Try again in ${waitText(retryAfterSec)}, or pick another model.`,
      { headers: { "retry-after": String(retryAfterSec) } },
    );
  },
  uploadsBusy(limit: number, retryAfterSec: number) {
    return docsError(
      429,
      "rate_limit_error",
      "uploads_busy",
      `Live demos take ${limit.toLocaleString("en-US")} uploads an hour across every reader, and this hour's are used. Try again in ${waitText(retryAfterSec)}.`,
      { headers: { "retry-after": String(retryAfterSec) } },
    );
  },
  paidPaused() {
    const message =
      "Live demos that cost money are paused right now. Free calls (listing models and files, counting tokens) still run.";
    return docsError(503, "server_error", "paid_paused", message, { retry: false });
  },
  tooManyInFlight(limit: number) {
    return docsError(
      429,
      "rate_limit_error",
      "too_many_in_flight",
      `Live demos run at most ${limit} calls at once from one network. Try again when one finishes.`,
      { headers: { "retry-after": "2" } },
    );
  },
  ipBudget(capUsd: number, spentUsd: number, estimateUsd: number, retryAfterSec: number) {
    const left = Math.max(0, capUsd - spentUsd);
    const message =
      spentUsd >= capUsd
        ? `You've used today's ${usd(capUsd)} of live demo runs. They reset at 00:00 UTC, in ${waitText(retryAfterSec)}.`
        : `This run is estimated at ${usd(estimateUsd)}, more than the ${usd(left)} left of today's ${usd(capUsd)} for live demos. ` +
          "Try a cheaper model or a lower output limit, or come back after 00:00 UTC.";
    const headers = { "retry-after": String(retryAfterSec) };
    return docsError(429, "insufficient_quota", "ip_budget", message, { retry: false, headers });
  },
  docsBudget(retryAfterSec: number) {
    return docsError(
      503,
      "server_error",
      "docs_budget",
      `Live demos used today's budget for everyone. They come back at 00:00 UTC, in ${waitText(retryAfterSec)}.`,
      { retry: false, headers: { "retry-after": String(retryAfterSec) } },
    );
  },
  platformPaused() {
    const message = "Muse Muse paused Meta calls for today. Try again tomorrow.";
    return docsError(503, "server_error", "platform_paused", message, { retry: false });
  },
  upstreamUnreachable() {
    return docsError(502, "server_error", "upstream_unreachable", "Couldn't reach the Meta Model API. Try again.");
  },
  keyRefused() {
    return docsError(502, "server_error", "upstream_auth", KEY_REFUSED_MESSAGE);
  },
  unexpected() {
    return docsError(500, "server_error", "docs_error", "The live docs hit an unexpected error. Try again.");
  },
};
