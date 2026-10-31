/**
 * A tools/call that cannot reach the device gets a tool result Muse can read, not an HTTP error.
 *
 * When the device is offline (503, or 502 from a device whose app is not running), took too long
 * (504) or is busy (429), and the request body is one JSON-RPC tools/call with an id, the relay
 * answers 200 with {jsonrpc, id, result: {content: [{type: "text", text}], isError: true}}.
 * Everything else (initialize, tools/list, notifications, batches) keeps its status code.
 *
 * Only the body's method and id are read, and only on these failures. Nothing is stored or logged.
 */

export const OFFLINE_TEXT =
  "The user's Muse Privacy device is offline right now (asleep, or the app is not running), so nothing was shared. Ask the user to wake the device and try again.";
export const TIMEOUT_TEXT =
  "The user's Muse Privacy device took too long, and nothing was shared. If you started a job, call get_result with its job_id in a minute.";
export const BUSY_TEXT =
  "The user's Muse Privacy device is busy with other requests right now, and nothing was shared. Try again in a minute.";

const TEXTS: Record<number, string> = { 502: OFFLINE_TEXT, 503: OFFLINE_TEXT, 504: TIMEOUT_TEXT, 429: BUSY_TEXT };

/** The id of a single JSON-RPC tools/call request, or undefined for anything else. */
export function toolCallId(body: string): string | number | undefined {
  let message: unknown;
  try {
    message = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
  const { jsonrpc, method, id } = message as { jsonrpc?: unknown; method?: unknown; id?: unknown };
  if (jsonrpc !== "2.0" || method !== "tools/call") return undefined;
  return typeof id === "string" || (typeof id === "number" && Number.isFinite(id)) ? id : undefined;
}

/** The readable tool result for a failed forward, or null when the status or body does not call for one. */
export function toolResultFor(status: number, body: string): Response | null {
  const text = TEXTS[status];
  if (!text) return null;
  const id = toolCallId(body);
  if (id === undefined) return null;
  const answer = { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } };
  return new Response(JSON.stringify(answer), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
