import { connectProof } from "@/lib/caps/connect/store";
import { codeProof } from "@/lib/caps/code/store";
import { dataProof } from "@/lib/caps/data/store";
import { filesProof } from "@/lib/caps/files/store";
import { hardwareProof } from "@/lib/caps/hardware/store";
import type { CapId } from "@/lib/caps/ids";
import { liveProof } from "@/lib/caps/live/store";
import { gatewayError } from "@/lib/gateway/errors";
import type { ProductStatus } from "@/lib/types";

/**
 * GET {GATEWAY_URL}/caps/proof (docs/CAPABILITIES.md, 2.8): what the gateway itself saw for a build's namespace, by cap
 * (rows written, files stored, jobs fired, sends simulated, sessions run). verify's caps step reads it next to the
 * product's own test record, and product code can't write it. Build tokens tied to a build only. With no cap enabled the
 * route answers 404 unknown_endpoint and touches nothing, as every wave 3 route does with its flag off.
 *
 * `?since=<ISO time>` counts only what happened from then on. verify passes the time it started, so what an earlier
 * round, a milestone's verify or Muse Code itself did with the build token never passes a later verify.
 *
 * Each cap that stores or simulates anything adds one counter, in plan order: a function from the build id and the
 * window to named counts in the build namespace b:<buildId>. A counter must count only what was written at or after
 * `since` when it is set.
 */
export type CapProofCounter = (buildId: string, window: { since: Date | null }) => Promise<Record<string, number>>;
export const CAP_PROOF: Partial<Record<CapId, CapProofCounter>> = {
  // Rows written in the build namespace since `since`, rows there by scope, writers, and the brief's collections.
  data: dataProof,
  // Files made ready, documents indexed and dataset files read in the build namespace since `since`, and the brief's choices.
  files: filesProof,
  // Unit 5: sampled fetches and calls, simulated sends, test keys and their hashes for the leak scan, the brief's picks.
  connect: connectProof,
  // Unit 7: caption chunks, tickets, streams and changes sent since `since`, and what the brief asks for.
  live: liveProof,
  // Exec runs and pages opened in the build namespace since `since`, and which parts the brief asked for.
  code: codeProof,
  // Unit 13: board tool calls that reached the simulated board since `since`, and what the brief asks for.
  hardware: hardwareProof,
};

/** The build namespace a build token's caps rows and files live under (docs/CAPABILITIES.md, 2.3). */
export const buildNamespace = (buildId: string) => `b:${buildId}`;

/** How often one build token may read its proof: verify reads it once a run, so this only stops a loop. */
export const CAPS_PROOF_PER_MINUTE = 30;
/** The oldest `since` the route takes. A build's whole life fits well inside it. */
const SINCE_MAX_AGE_MS = 48 * 3_600_000;

export interface CapsProofToken {
  id: string;
  scope: string;
  buildId: string | null;
  productId: string;
}

export interface CapsProofDeps {
  enabledCaps(): readonly CapId[];
  findToken(token: string): Promise<CapsProofToken | null>;
  /** The product's status, as the gateway checks it: a disabled or failed product's token reads nothing. */
  productStatus(productId: string): Promise<ProductStatus | null>;
  /** The gateway's rate limit counters (lib/gateway/store.ts). */
  hitRateLimits(keys: string[], windowStart: Date): Promise<Record<string, number>>;
  /** The counters to read, CAP_PROOF by default. Tests pass their own. */
  counters?: Partial<Record<CapId, CapProofCounter>>;
  now?(): Date;
}

export interface CapsProof {
  buildId: string;
  namespace: string;
  /** The start of the window counted, or null for the whole build. */
  since: string | null;
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
  const status = await deps.productStatus(token.productId);
  if (!status || status === "disabled" || status === "failed") {
    return gatewayError(403, "permission_error", "product_disabled", "This product is turned off on Muse Muse.", { retry: false });
  }
  const now = deps.now?.() ?? new Date();
  const sinceParam = new URL(req.url).searchParams.get("since");
  const since = sinceParam === null ? null : new Date(sinceParam);
  if (since && (Number.isNaN(since.getTime()) || since.getTime() > now.getTime() + 5 * 60_000 || since.getTime() < now.getTime() - SINCE_MAX_AGE_MS)) {
    return gatewayError(400, "invalid_request_error", "invalid_arguments", "since must be an ISO time within the last 48 hours.", { retry: false });
  }
  const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const key = `caps-proof:token:${token.id}`;
  const counts = await deps.hitRateLimits([key], windowStart);
  if ((counts[key] ?? 0) > CAPS_PROOF_PER_MINUTE) {
    return gatewayError(429, "rate_limit_error", "rate_limited", `Too many reads of the gateway's record: the limit is ${CAPS_PROOF_PER_MINUTE} a minute.`, { headers: { "retry-after": "60" } });
  }
  const counters = deps.counters ?? CAP_PROOF;
  const caps: CapsProof["caps"] = {};
  for (const id of enabled) {
    const count = counters[id];
    if (!count) continue;
    try {
      caps[id] = await count(token.buildId, { since });
    } catch (err) {
      console.error(`[caps/proof] ${id}:`, err);
      return gatewayError(502, "server_error", "cap_failed", `The ${id} record couldn't be read. Try again.`);
    }
  }
  const proof: CapsProof = { buildId: token.buildId, namespace: buildNamespace(token.buildId), since: since ? since.toISOString() : null, caps };
  return Response.json(proof, { headers: { "cache-control": "no-store" } });
}
