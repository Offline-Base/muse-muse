import { env } from "@/lib/env";
import { briefTargets } from "@/lib/native/targets";

/**
 * The cloud model an edge product's main answer asks first: respondJsonOrEdge in template/lib/meta/edge.ts calls
 * respondJson, which names Muse Wonder (a test build's own calls swap it for Contributor).
 */
export const EDGE_TEXT_MODEL = "muse-wonder-1.0";

/**
 * What allowedModelsFor adds for an edge build (docs/EDGE_DEMO.md): Muse Wonder, so the product's token can make the
 * cloud call respondJsonOrEdge makes before the board. Without it, an edge brief whose only model is another one
 * (sam-3.1, say) gets 404 model_not_found from the gateway on that call (docs/BUILD_LOG.md, Nov 2, 9 PM). Empty unless
 * EDGE_ENABLED is on (with EDGE_BUILDS) and the brief has the edge target, so with the flags off a token's list is
 * today's. Pure apart from the flag, like gpuAllowedModels and fleetAllowedModels.
 */
export function edgeAllowedModels(brief: Parameters<typeof briefTargets>[0]): string[] {
  return env.edgeEnabled && briefTargets(brief).includes("edge") ? [EDGE_TEXT_MODEL] : [];
}
