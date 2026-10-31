import type { CapId } from "@/lib/caps/ids";
import { gatewayError } from "@/lib/gateway/errors";

/**
 * GET {GATEWAY_URL}/caps/proof (docs/CAPABILITIES.md, 2.8): what the gateway itself saw for a build's namespace, by cap
 * (rows written, files stored, jobs fired, sends simulated, sessions run). verify's caps step reads it next to the
 * product's own test record, and product code can't write it. Build tokens tied to a build only. With no cap enabled the
 * route answers 404 unknown_endpoint and touches nothing, as every wave 3 route does with its flag off.
 *
 * Each cap that stores or simulates anything adds one counter, in plan order: a function from the build id to named
 * counts in the build namespace b:<buildId>.
 */
export const CAP_PROOF: Partial<Record<CapId, (buildId: string) => Promise<Record<string, number>>>> = {};

/** The build namespace a build token's caps rows and files live under (docs/CAPABILITIES.md, 2.3). */
export const buildNamespace = (buildId: string) => `b:${buildId}`;

export interface CapsProofToken {
  scope: string;
  buildId: string | null;
  productId: string;
}

export interface CapsProofDeps {
  enabledCaps(): readonly CapId[];
  findToken(token: string): Promise<CapsProofToken | null>;
  /** The counters to read, CAP_PROOF by default. Tests pass their own. */
  counters?: Partial<Record<CapId, (buildId: string) => Promise<Record<string, number>>>>;
}

export interface CapsProof {
  buildId: string;
  namespace: string;
  caps: Partial<Record<CapId, Record<string, number>>>;
}

function bearer(header: string | null): string | null {
  const m = header?.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1]! : null;
}

export async function handleCapsProof(req: Request, deps: CapsProofDeps): Promise<Response> {
  const enabled = deps.enabledCaps();
  if (!enabled.length) {
    return gatewayError(404, "not_found_error", "unknown_endpoint", "The gateway does not serve /caps/proof.", { retry: false });
  }
  if (req.method !== "GET") {
    return gatewayError(405, "invalid_request_error", "method_not_allowed", "Use GET for /caps/proof.", { retry: false, headers: { allow: "GET" } });
  }
  const raw = bearer(req.headers.get("authorization"));
  const token = raw ? await deps.findToken(raw) : null;
  if (!token) {
    return gatewayError(401, "authentication_error", "invalid_token", "Missing, unknown, revoked or expired product token.", { retry: false });
  }
  if (token.scope !== "build" || !token.buildId) {
    return gatewayError(403, "permission_error", "cap_not_allowed", "Only a build's own token can read what the gateway saw for that build.", { retry: false });
  }
  const counters = deps.counters ?? CAP_PROOF;
  const caps: CapsProof["caps"] = {};
  for (const id of enabled) {
    const count = counters[id];
    if (!count) continue;
    try {
      caps[id] = await count(token.buildId);
    } catch (err) {
      console.error(`[caps/proof] ${id}:`, err);
      return gatewayError(502, "server_error", "cap_failed", `The ${id} record couldn't be read. Try again.`);
    }
  }
  const proof: CapsProof = { buildId: token.buildId, namespace: buildNamespace(token.buildId), caps };
  return Response.json(proof, { headers: { "cache-control": "no-store" } });
}
