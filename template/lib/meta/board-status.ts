import { samBoard } from "./edge";

/**
 * Whether this copy of the product can reach an edge board right now, for the line every edge product shows
 * (components/BoardStatus.tsx, through app/api/board-status/route.ts). It never asks a model, in the cloud or on the
 * board: it only checks that each board side that is set up answers its own health check.
 *
 *   the answer board  EDGE_URL: GET {EDGE_URL}/models (the OpenAI-compatible server's model list)
 *   the look board    only with `looks`, for a product that looks at photos with segmentOrEdge:
 *                       EDGE_SAM_URL set: GET <service>/health on the board's sam3 service
 *                       else, on a hosted product: GET {GATEWAY_URL}/fleet/v1/segment/status with PRODUCT_TOKEN, which
 *                       Muse Muse answers with whether the office board is online for this product. 401, 403 and 404 there
 *                       mean no board is set up for this product.
 *
 * Server only. Never throws: a side that can't be reached in `timeoutMs` (default 3000) is "down".
 */

/** The line a page shows when no board answers. Word for word. */
export const NOT_CONNECTED_LINE = "Not connected to a board";

export type BoardSideState = "connected" | "down" | "not_set";

export interface BoardSide {
  /** "answer" is the backup model for the main answer (EDGE_URL); "look" is Meta SAM 3.1 on a board. */
  kind: "answer" | "look";
  /** The board's name as the label names it. */
  board: string;
  state: BoardSideState;
}

export interface BoardStatus {
  /** True only when at least one board side is set up and every side that is set up answered. */
  connected: boolean;
  /** One fixed line to show as it is: "Connected to <board>" or NOT_CONNECTED_LINE. */
  line: string;
  /** A plain second line when it isn't connected, or null. */
  detail: string | null;
  sides: BoardSide[];
  checkedAt: string;
}

const DEFAULT_TIMEOUT_MS = 3_000;

async function answers(url: string, init: { token?: string | null; timeoutMs: number; doFetch: typeof fetch }, accept: (res: Response) => Promise<BoardSideState>): Promise<BoardSideState> {
  try {
    const res = await init.doFetch(url, {
      headers: init.token ? { authorization: `Bearer ${init.token}` } : {},
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(init.timeoutMs),
    });
    return await accept(res);
  } catch {
    return "down";
  }
}

async function jsonOf(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const json: unknown = await res.json();
    return json && typeof json === "object" ? (json as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function answerSide(timeoutMs: number, doFetch: typeof fetch): Promise<BoardSide | null> {
  const base = process.env.EDGE_URL?.trim().replace(/\/+$/, "");
  if (!base) return null;
  const board = process.env.EDGE_BOARD?.trim() || "the edge board";
  if (!URL.canParse(`${base}/models`)) return { kind: "answer", board, state: "down" };
  const state = await answers(`${base}/models`, { token: process.env.EDGE_API_KEY?.trim() || null, timeoutMs, doFetch }, async (res) => {
    await res.body?.cancel().catch(() => {});
    return res.ok ? "connected" : "down";
  });
  return { kind: "answer", board, state };
}

async function lookSide(timeoutMs: number, doFetch: typeof fetch): Promise<BoardSide | null> {
  const sam = samBoard();
  if (!sam) return null;
  if (sam.viaGateway) {
    const state = await answers(`${sam.url}/status`, { token: sam.apiKey, timeoutMs, doFetch }, async (res) => {
      // Muse Muse has no office board for this product: the route is off (404), or this product may not use it.
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        await res.body?.cancel().catch(() => {});
        return "not_set";
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return "down";
      }
      return (await jsonOf(res))?.connected === true ? "connected" : "down";
    });
    return { kind: "look", board: sam.board, state };
  }
  const health = sam.url.replace(/\/segment$/, "/health");
  const state = await answers(health, { token: sam.apiKey, timeoutMs, doFetch }, async (res) => (res.ok && (await jsonOf(res))?.ok === true ? "connected" : "down"));
  return { kind: "look", board: sam.board, state };
}

const names = (sides: BoardSide[]) => [...new Set(sides.map((s) => s.board))].join(" and ");

/** The status from what each side said. Pure, so the page's line is the same wherever it is worked out. */
export function statusOf(sides: BoardSide[], at: Date = new Date()): BoardStatus {
  const set = sides.filter((s) => s.state !== "not_set");
  const up = set.filter((s) => s.state === "connected");
  const down = set.filter((s) => s.state === "down");
  const checkedAt = at.toISOString();
  if (!set.length) {
    return { connected: false, line: NOT_CONNECTED_LINE, detail: "No board is set up for this copy, so its answers come from the cloud.", sides, checkedAt };
  }
  if (!down.length) return { connected: true, line: `Connected to ${names(up)}`, detail: null, sides, checkedAt };
  return {
    connected: false,
    line: NOT_CONNECTED_LINE,
    detail: up.length ? `${names(down)} didn't answer just now. ${names(up)} did.` : `${names(down)} didn't answer just now.`,
    sides,
    checkedAt,
  };
}

/** Checks every board side this copy has set up, at once. `looks` adds Meta SAM 3.1's board. */
export async function boardStatus(opts: { looks?: boolean; timeoutMs?: number; fetch?: typeof fetch } = {}): Promise<BoardStatus> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = opts.fetch ?? fetch;
  const sides = await Promise.all([answerSide(timeoutMs, doFetch), opts.looks ? lookSide(timeoutMs, doFetch) : null]);
  return statusOf(sides.filter((s): s is BoardSide => s !== null));
}
