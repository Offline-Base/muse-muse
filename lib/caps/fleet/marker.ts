import { FLEET_BRIEF_MODEL } from "@/lib/brief/schema";
import { env } from "@/lib/env";

/**
 * Who may reach the fleet's endpoint (docs/CAPABILITIES.md, 17b). The fleet isn't a cap, so a brief has no block for it and
 * no `cap:` marker. A token gets this plain marker when its brief picks jetson-fleet while FLEET_PRODUCTS is on and the
 * builder snapshot has the helper. With the flag off nothing is added, so the token's list is today's.
 */
export const FLEET_MARKER = "fleet";
export { FLEET_BRIEF_MODEL };
/** The usage row a build's simulated reply leaves. */
export const FLEET_CANNED_USAGE = "fleet-canned";
/** What askFleetOrMessage (template/lib/meta/fleet.ts) gives back as `label`, and the build prompt quotes. Word for word. */
export const FLEET_LABEL = "Answered on boards we run, with no cloud model. Your text passes through this product's server, Muse Muse, ngrok and our lead board, so don't send private things.";

export function picksFleet(brief: { capabilities?: ReadonlyArray<{ model: string }> } | null | undefined): boolean {
  return Boolean(brief?.capabilities?.some((c) => c.model === FLEET_BRIEF_MODEL));
}

/** True when this new build's product talks to the fleet's endpoint. */
export function usesFleet(brief: { capabilities?: ReadonlyArray<{ model: string }> } | null | undefined): boolean {
  return env.fleetProductsForBuilds && picksFleet(brief);
}

/** What allowedModelsFor adds to a token. Empty with the flag off, or for a brief without jetson-fleet. No model beside it: nothing answers in its place. */
export function fleetAllowedModels(brief: { capabilities?: ReadonlyArray<{ model: string }> } | null | undefined): string[] {
  return usesFleet(brief) ? [FLEET_MARKER] : [];
}
