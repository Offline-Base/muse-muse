import { type FleetSamDeps, type FleetSamSettings, FLEET_SAM_ENDPOINT, fleetSamCaller } from "@/lib/caps/fleet/sam";
import { gatewayError } from "@/lib/gateway/errors";

/**
 * GET {GATEWAY_URL}/fleet/v1/segment/status: whether the office board a hosted product's segmentOrEdge reaches through
 * Muse Muse (lib/caps/fleet/sam.ts) is online for this product right now. The product's board status line asks it
 * (template/lib/meta/board-status.ts) and shows "Not connected to a board" unless it says `connected: true`.
 *
 * It takes the same token as the look and makes the same caller checks, so 404 while FLEET_SAM is off, and 401, 403 or
 * 503 for a caller the look would turn away. Then `{ connected, checkedAt }`: connected only when the fleet settings are
 * there and the control plane lists FLEET_SAM_NODE as online and not in maintenance. It sends no photo, runs nothing on
 * the board and asks no model. The control plane's answer is kept for STATUS_CACHE_MS in this server process, shared by
 * every product, so page views never add up to many control-plane requests. It never names the board or the fleet's address.
 */

export const FLEET_SAM_STATUS_ENDPOINT = `${FLEET_SAM_ENDPOINT}/status`;
/** How long one control-plane answer stands for every product. */
export const STATUS_CACHE_MS = 60_000;
const CALL_MS = 8_000;

let cache: { key: string; at: number; online: Promise<boolean> } | null = null;

/** Forgets the cached answer. For tests. */
export function resetFleetStatusCache(): void {
  cache = null;
}

async function nodeOnline(settings: FleetSamSettings, deps: Pick<FleetSamDeps, "fetch">): Promise<boolean> {
  try {
    const res = await deps.fetch(`${settings.url}/api/nodes`, {
      headers: { authorization: `Bearer ${settings.token}`, "ngrok-skip-browser-warning": "1" },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(CALL_MS),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return false;
    }
    const nodes: unknown = await res.json();
    if (!Array.isArray(nodes)) return false;
    const node = nodes.find((n): n is Record<string, unknown> => !!n && typeof n === "object" && ((n as { id?: unknown }).id === settings.node || (n as { name?: unknown }).name === settings.node));
    return !!node && node.status === "online" && node.maintenance !== true;
  } catch {
    return false;
  }
}

/** The office board's state, from the cache when it is fresh. */
function online(settings: FleetSamSettings, deps: Pick<FleetSamDeps, "fetch" | "now">): Promise<boolean> {
  const now = (deps.now?.() ?? new Date()).getTime();
  const key = `${settings.url}\n${settings.node}`;
  if (cache && cache.key === key && now - cache.at < STATUS_CACHE_MS) return cache.online;
  cache = { key, at: now, online: nodeOnline(settings, deps) };
  return cache.online;
}

export async function handleFleetSamStatus(req: Request, deps: FleetSamDeps): Promise<Response> {
  if (!deps.on()) return gatewayError(404, "not_found_error", "unknown_endpoint", `The gateway does not serve ${FLEET_SAM_STATUS_ENDPOINT}.`, { retry: false });
  if (req.method !== "GET") return gatewayError(405, "invalid_request_error", "method_not_allowed", `Use GET for ${FLEET_SAM_STATUS_ENDPOINT}.`, { retry: false, headers: { allow: "GET" } });
  try {
    const token = await fleetSamCaller(req, deps);
    if (token instanceof Response) return token;
    const settings = deps.settings();
    const connected = settings ? await online(settings, deps) : false;
    return Response.json({ connected, checkedAt: (deps.now?.() ?? new Date()).toISOString() }, { headers: { "cache-control": "no-store" } });
  } catch {
    console.error("[fleet-sam] status check failed");
    return gatewayError(502, "server_error", "fleet_unavailable", "The office board's status couldn't be read. Try again in a moment.", { retry: false });
  }
}
