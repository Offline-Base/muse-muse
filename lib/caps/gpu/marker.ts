import { env } from "@/lib/env";

/**
 * Who may reach the shared Glimmer endpoint (docs/CAPABILITIES.md, section 17). GPU isn't a cap: muse-glimmer is already a
 * product model, so a brief has no block for it and no `cap:` marker. A token gets this plain marker when its brief picks
 * muse-glimmer while GPU_GLIMMER_SHARED is on, with Muse Wonder beside it, since askGlimmer falls back to Wonder whenever
 * no window is open. With the flag off nothing is added, so the token's list is today's.
 */
export const GLIMMER_MARKER = "glimmer";
export const GLIMMER_BRIEF_MODEL = "muse-glimmer";
export const GLIMMER_FALLBACK_MODEL = "muse-wonder-1.0";
/** The usage rows a build's calls leave: the gateway's own record that a reply was served and a closed window was tried. */
export const GLIMMER_CANNED_USAGE = "glimmer-canned";
export const GLIMMER_CLOSED_USAGE = "glimmer-closed";

export function picksGlimmer(brief: { capabilities?: ReadonlyArray<{ model: string }> } | null | undefined): boolean {
  return Boolean(brief?.capabilities?.some((c) => c.model === GLIMMER_BRIEF_MODEL));
}

/** True when this new build's product talks to the shared endpoint. */
export function usesSharedGlimmer(brief: { capabilities?: ReadonlyArray<{ model: string }> } | null | undefined): boolean {
  return env.gpuGlimmerForBuilds && picksGlimmer(brief);
}

/** What allowedModelsFor adds to a token. Empty with the flag off, or for a brief without muse-glimmer. */
export function gpuAllowedModels(brief: { capabilities?: ReadonlyArray<{ model: string }> } | null | undefined): string[] {
  return usesSharedGlimmer(brief) ? [GLIMMER_FALLBACK_MODEL, GLIMMER_MARKER] : [];
}
