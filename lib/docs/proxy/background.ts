import { matchEndpoint, type DocsEndpoint } from "@/lib/docs/proxy/endpoints";
import { backgroundWorstCase } from "@/lib/docs/proxy/estimate";
import { settleHeld, type DocsSettleDeps } from "@/lib/docs/proxy/limits";
import { docsUsageFromJson, usageShown } from "@/lib/docs/proxy/meter";
import { DOCS_TEXT_MODELS, OUTPUT_TOKEN_CLAMPS } from "@/lib/docs/proxy/policy";
import type { DocsDeps, DocsHoldState } from "@/lib/docs/proxy/types";
import { SseParser } from "@/lib/gateway/meter";

/**
 * Background responses (protocols/responses, "Background responses"): Meta answers at once with status "queued" and
 * bills the run later, so its reply can't be metered like other calls. They run in the live docs under three rules:
 *   1. Only text models, and only with store on: Muse Image and SAM bill per image and per frame (a SAM video can run
 *      to 15,000 frames), and a response that isn't stored can never be read back to be settled.
 *   2. The hold is the worst case, not a guess (backgroundWorstCase in lib/docs/proxy/estimate.ts), so until Meta
 *      reports the real usage the budgets count the most the run can cost. A model whose worst case is more than a
 *      reader's daily dollars (Muse Wonder's whole context window) can't run in the background here.
 *   3. The hold waits in the response's docs_objects row and is settled from Meta's usage once the response is
 *      finished: when the reader retrieves or cancels it, or in the hourly sweep (lib/docs/proxy/cleanup.ts).
 */

type Json = Record<string, unknown>;

/** Statuses a response doesn't leave. Its usage is then what Meta bills. */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "incomplete", "cancelled"]);

/** The usage row's endpoint for a settled background response. */
const CTX = { source: "docs", endpoint: "responses" } as const;
/** A finished response is metered as POST /v1/responses is. */
const RESPONSES = matchEndpoint("POST", ["responses"]) as DocsEndpoint;

function isObject(value: unknown): value is Json {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** A reply that says the response is still to run: Meta's acknowledgement of a background request. */
export function isBackgroundReply(json: Json | null): boolean {
  return !!json && (json.background === true || json.status === "queued" || json.status === "in_progress");
}

/**
 * Why a Responses request's `background` can't run in the live docs, or null when it can (or doesn't ask for it).
 * `model` is the model after the Spark 1.3 swap, `perIpDailyUsd` a reader's dollars for the day.
 */
export function backgroundRefusal(endpoint: DocsEndpoint, json: Json, model: string | null, perIpDailyUsd: number): string | null {
  if (endpoint.id !== "responses.create" || json.background === undefined || json.background === null) return null;
  // A string or a number Meta might read as true would run in the background unseen, so only booleans pass.
  if (typeof json.background !== "boolean") return '"background" must be true or false.';
  if (!json.background) return null;
  if (!model || !OUTPUT_TOKEN_CLAMPS[model]) {
    return `Live demos run background responses on the text models only (${DOCS_TEXT_MODELS.join(", ")}). Run ${model ?? "this model"} without "background".`;
  }
  if (json.store === false) {
    return 'Background responses need "store": true (the default) in the live docs, so they can be read back and metered when they finish.';
  }
  const worst = backgroundWorstCase(model, json);
  // With no dollars at all, paid demos are paused, which the budget check says better.
  if (worst <= perIpDailyUsd || perIpDailyUsd <= 0) return null;
  const fits = DOCS_TEXT_MODELS.filter((m) => backgroundWorstCase(m, json) <= perIpDailyUsd);
  const tools = Array.isArray(json.tools) && json.tools.length ? " with these tools" : "";
  return (
    `A background response holds the most it could cost until it finishes, ${usd(worst)} on ${model}${tools}: ` +
    `more than the ${usd(perIpDailyUsd)} a day live demos allow one reader. ` +
    (fits.length
      ? `Run it in the background on ${listOf(fits)}, or without "background" on ${model}.`
      : `Run it without "background".`)
  );
}

/** "a", "a or b", "a, b or c". */
function listOf(items: readonly string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} or ${items.at(-1)}` : (items[0] ?? "");
}

/** What a finished response used, or null while it isn't finished or doesn't say. */
export function finishedUsage(model: string | null, response: unknown) {
  if (!isObject(response) || !TERMINAL_STATUSES.has(String(response.status))) return null;
  if (!usageShown(RESPONSES, response)) return null;
  return docsUsageFromJson(RESPONSES, model, response);
}

export type BackgroundSettleDeps = DocsSettleDeps & Pick<DocsDeps, "claimHold">;

/**
 * Settles a background response's hold from a reply that shows it finished, once: the hold is claimed off its row
 * first, so a reader's poll and the hourly sweep can't both settle it. "settled" when this call settled it, "pending"
 * while the response isn't finished or its usage isn't shown (the hold stays for later), "gone" when someone else
 * already had.
 */
export async function settleFinished(
  deps: BackgroundSettleDeps,
  id: string,
  hold: DocsHoldState,
  response: unknown,
): Promise<"settled" | "pending" | "gone"> {
  const items = finishedUsage(hold.model, response);
  if (!items) return "pending";
  const claimed = await deps.claimHold(id);
  if (!claimed) return "gone";
  await settleHeld(deps, CTX, claimed, items);
  return "settled";
}

/**
 * The final response a streamed retrieval (GET /v1/responses/{id}?stream=true) carries in its terminal event
 * (protocols/responses, "Streaming retrieval for background responses"), or null when the stream ended without one.
 * Never throws.
 */
export async function finalResponseOf(body: ReadableStream<Uint8Array>): Promise<Json | null> {
  let final: Json | null = null;
  const parser = new SseParser((e) => {
    try {
      const data = JSON.parse(e.data) as unknown;
      const type = e.event ?? (isObject(data) ? data.type : null);
      if (isObject(data) && typeof type === "string" && ["response.completed", "response.incomplete", "response.failed"].includes(type)) {
        if (isObject(data.response)) final = data.response;
      }
    } catch {
      // [DONE] and other lines that aren't JSON.
    }
  });
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.end();
  } catch {
    // Cut off: whatever arrived before is all there is.
  } finally {
    reader.releaseLock();
  }
  return final;
}
