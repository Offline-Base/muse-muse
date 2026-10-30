import type { DocsResult } from "@/lib/docs/client/api";

/**
 * Two upstream hiccups that a chained call (one with previous_response_id) gets past on a second try:
 *
 * - HTTP 400 "referenced response not found or expired" when the named response only just finished. A demo whose
 *   mock tools answer instantly sends the next call at once, so it meets this more than an app would (once in a dozen
 *   chained tool-loop calls on Oct 30, 2026).
 * - HTTP 5xx, such as 503 "persistence service error" from Meta's response store (3 of 9 reasoning follow-ups in one
 *   burst on Oct 30, 2026; the next 9 all passed).
 *
 * Such a call gets one retry after a short pause; anything else comes back as it was.
 */

const MISSING = /referenced response not found/i;

export function isChainRace(res: Pick<DocsResult, "status" | "error">, body: unknown): boolean {
  const chained = !!body && typeof body === "object" && typeof (body as { previous_response_id?: unknown }).previous_response_id === "string";
  if (!chained) return false;
  if (res.status === 400) return MISSING.test(res.error?.message ?? "");
  return res.status >= 500 && res.status < 600;
}

export async function withChainRetry<R extends Pick<DocsResult, "status" | "error">>(
  attempt: () => Promise<R>,
  body: unknown,
  opts: { pauseMs?: number; stopped?: () => boolean } = {},
): Promise<R> {
  const first = await attempt();
  if (!isChainRace(first, body)) return first;
  await new Promise((resolve) => setTimeout(resolve, opts.pauseMs ?? 1200));
  if (opts.stopped?.()) return first;
  return attempt();
}
