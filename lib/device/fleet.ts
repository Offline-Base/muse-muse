/**
 * Reads the whole fleet through its control plane (jetson-infra's docs/api.md), for /device and for Wonder. It only reads:
 * the board list, and one chat through the gateway. The address and token come from the environment inside each call and
 * stay on the server, and an error here never holds either, so its message is safe to show. Tested against fakes only: this
 * has never reached a real control plane.
 */
import { fleetAccess } from "@/lib/board-loop/fleet";

const CALL_MS = 15_000;
/** A chat on a board that's already busy can take a while to start. Under the ask route's limit. */
const CHAT_MS = 90_000;
/** The fleet's own ask_fleet_model takes these (docs/assistant.md). */
export const FLEET_MAX_TOKENS = 1024;
const MAX_PROMPT_CHARS = 8000;
/** Names come from the boards and go to a model, so a strange one stops here. */
const MAX_NAME_CHARS = 200;
/** How long several admins, or a model asking repeatedly, share one read of the list. Each read spends the tunnel's monthly requests. */
const LIST_CACHE_MS = 30_000;

export class FleetNotConfiguredError extends Error {}
/** The fleet couldn't answer. The message holds no address or token. */
export class FleetError extends Error {
  constructor(
    message: string,
    /** What the control plane answered, when it answered. */
    readonly status?: number,
  ) {
    super(message);
  }
}

/** What may be shown of one board. A NodeSummary's id, labels and facts (hostname, addresses, serial) stay out. */
export interface FleetBoard {
  name: string;
  status: "online" | "stale" | "offline";
  pool: string | null;
  maintenance: boolean;
  loadedModels: string[];
  memUsedMb: number | null;
  memTotalMb: number | null;
  maxTempC: number | null;
}

export interface FleetChat {
  model: string;
  prompt: string;
  /** An nd_ id, sent as X-JCP-Node. The gateway compares only ids. */
  nodeId?: string;
  maxTokens?: number;
}

export interface FleetAsk {
  prompt: string;
  /** A board's name or nd_ id. */
  node?: string;
  maxTokens?: number;
}

export interface FleetAnswer {
  board: string;
  model: string;
  text: string;
  finish: string | null;
}

/** Just what this reads of a NodeSummary. */
interface FleetNode {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  pool?: unknown;
  maintenance?: unknown;
  loaded_models?: unknown;
  metrics?: { mem?: { used_mb?: unknown; total_mb?: unknown }; temps_c?: Record<string, unknown> } | null;
}

/** Whether the fleet's address and token are set, and the address is safe to send the token to. */
export const fleetConfigured = (): boolean => fleetAccess() !== null;

async function call(path: string, init: RequestInit, timeoutMs: number, doFetch: typeof fetch): Promise<Response> {
  const access = fleetAccess();
  if (!access) throw new FleetNotConfiguredError("The fleet isn't set up.");
  try {
    return await doFetch(`${access.url.replace(/\/+$/, "")}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${access.token}`, "content-type": "application/json", ...init.headers },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
      // The token and a prompt go only to the address that was set.
      redirect: "error",
    });
  } catch {
    throw new FleetError("The fleet can't be reached.");
  }
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new FleetError("The fleet's answer couldn't be read.");
  }
}

async function listNodes(doFetch: typeof fetch): Promise<FleetNode[]> {
  const res = await call("/api/nodes", {}, CALL_MS, doFetch);
  if (!res.ok) throw new FleetError(`The fleet answered ${res.status}.`, res.status);
  const nodes = await readJson(res);
  if (!Array.isArray(nodes)) throw new FleetError("The fleet's answer couldn't be read.");
  return nodes.filter((node): node is FleetNode => typeof node === "object" && node !== null);
}

const numberOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const nameOf = (value: unknown): string => (typeof value === "string" && value ? value.slice(0, MAX_NAME_CHARS) : "Unnamed board");
const loadedOf = (node: FleetNode): string[] =>
  Array.isArray(node.loaded_models) ? node.loaded_models.filter((model): model is string => typeof model === "string" && model !== "") : [];

/**
 * A Decision Tree model such as d1-omni-600M, as the control plane's own _looks_like_d1 decides (jetson_cp/llm.py). It's by
 * name because the systemone capability doesn't tell: jetson-05 advertises it and also serves an ordinary model.
 */
function isDecisionModel(model: string): boolean {
  const token = model.split(":", 1)[0]!.toLowerCase();
  return token === "d1" || token.startsWith("d1-") || token.includes("/d1-") || token.endsWith("/d1");
}

const chatModelsOf = (node: FleetNode): string[] => loadedOf(node).filter((model) => !isDecisionModel(model));

/** Only the fields a person or a model may see. The hottest of a board's sensors, as the control plane's own max_temp takes it. */
function safeBoard(node: FleetNode): FleetBoard {
  const temps = Object.values(node.metrics?.temps_c ?? {})
    .map(numberOrNull)
    .filter((temp) => temp !== null);
  return {
    name: nameOf(node.name),
    status: node.status === "online" || node.status === "stale" ? node.status : "offline",
    pool: typeof node.pool === "string" ? node.pool.slice(0, MAX_NAME_CHARS) : null,
    maintenance: node.maintenance === true,
    loadedModels: loadedOf(node).map((model) => model.slice(0, MAX_NAME_CHARS)),
    memUsedMb: numberOrNull(node.metrics?.mem?.used_mb),
    memTotalMb: numberOrNull(node.metrics?.mem?.total_mb),
    maxTempC: temps.length ? Math.max(...temps) : null,
  };
}

/** Every board in the fleet. Throws FleetNotConfiguredError or FleetError. */
export async function fleetBoards(doFetch: typeof fetch = fetch): Promise<FleetBoard[]> {
  return (await listNodes(doFetch)).map(safeBoard);
}

let listCache: { key: string; at: number; boards: Promise<FleetBoard[]> } | null = null;

/**
 * fleetBoards for what only shows the list, shared for LIST_CACHE_MS. A failure is shared too, so an outage isn't asked about
 * any faster. It lives in this one server process, so separate Vercel instances each read on their own. fleetAsk doesn't use
 * it: picking from an old list could send a chat to a model that has since unloaded, which would load it again.
 */
export function cachedFleetBoards(doFetch: typeof fetch = fetch): Promise<FleetBoard[]> {
  const access = fleetAccess();
  if (!access) return Promise.reject(new FleetNotConfiguredError("The fleet isn't set up."));
  const key = `${access.url} ${access.token}`;
  if (listCache?.key === key && Date.now() - listCache.at < LIST_CACHE_MS) return listCache.boards;
  const boards = fleetBoards(doFetch);
  listCache = { key, at: Date.now(), boards };
  return boards;
}

/** Forgets the shared read. For tests. */
export function resetFleetCache(): void {
  listCache = null;
}

/** One non-streaming chat through the gateway, of at most FLEET_MAX_TOKENS. Throws FleetNotConfiguredError or FleetError. */
export async function fleetChat({ model, prompt, nodeId, maxTokens }: FleetChat, doFetch: typeof fetch = fetch): Promise<{ text: string; finish: string | null }> {
  if (!prompt.trim()) throw new FleetError("That prompt is empty.");
  if (prompt.length > MAX_PROMPT_CHARS) throw new FleetError(`Keep a prompt under ${MAX_PROMPT_CHARS} characters.`);
  const limit = Math.min(FLEET_MAX_TOKENS, Math.max(1, Math.floor(numberOrNull(maxTokens) ?? FLEET_MAX_TOKENS)));
  const res = await call(
    "/v1/chat/completions",
    {
      method: "POST",
      headers: nodeId ? { "x-jcp-node": nodeId } : {},
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: limit,
        stream: false,
      }),
    },
    CHAT_MS,
    doFetch,
  );
  // The fleet's own error text can name boards and paths, so it isn't passed on.
  if (res.status === 429) throw new FleetError("That board is busy. Try again in a few seconds.");
  if (res.status === 503) throw new FleetError("No board can answer with that model right now.");
  if (!res.ok) throw new FleetError(`The fleet's model answered ${res.status}.`);
  const data = (await readJson(res)) as { choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }> } | null;
  const choice = data?.choices?.[0];
  if (!choice) throw new FleetError("The fleet's answer couldn't be read.");
  const text = typeof choice.message?.content === "string" ? choice.message.content : "";
  const finish = typeof choice.finish_reason === "string" ? choice.finish_reason : null;
  // A model that thinks first can spend the whole limit on that (jetson-infra's docs/fleet.md, Gemma 4), and the gateway still says 200.
  if (!text.trim()) {
    if (finish !== "length") throw new FleetError("The model gave an empty answer.");
    const next = limit < FLEET_MAX_TOKENS ? `Leave the limit out to give it ${FLEET_MAX_TOKENS}.` : "That's the most one ask can use.";
    throw new FleetError(`The model used its whole limit of ${limit} tokens thinking and gave no answer. ${next}`);
  }
  return { text, finish };
}

/**
 * One answer from a model a board already has loaded, always pinned to that board. Left to itself the gateway can send a
 * chat to a board with the model installed but not loaded, which would load it, and a combo's name can reach the cloud, so
 * this picks both. It never picks a Decision Tree model, named board or not: those answer the public sites' live System One
 * calls, on a machine a free-form chat would slow down.
 */
export async function fleetAsk({ prompt, node, maxTokens }: FleetAsk, doFetch: typeof fetch = fetch): Promise<FleetAnswer> {
  const nodes = await listNodes(doFetch);
  const wanted = node?.trim().toLowerCase();
  const target = wanted
    ? nodes.find((n) => n.id === node?.trim() || (typeof n.name === "string" && n.name.toLowerCase() === wanted))
    : nodes.find((n) => n.status === "online" && n.maintenance !== true && chatModelsOf(n).length > 0);
  if (!target) throw new FleetError(wanted ? "The fleet has no board by that name." : "No board has a chat model loaded right now.");
  const board = nameOf(target.name);
  const model = chatModelsOf(target)[0];
  if (!model && loadedOf(target).length > 0) throw new FleetError(`${board} only answers System One calls, so nothing ran.`);
  if (!model || typeof target.id !== "string") throw new FleetError(`${board} has no model loaded, so nothing ran. This doesn't load one.`);
  return { board, model, ...(await fleetChat({ model, prompt, nodeId: target.id, maxTokens }, doFetch)) };
}
