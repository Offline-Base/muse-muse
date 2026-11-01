import type { Brief } from "@/lib/brief/schema";
import { usesSharedGlimmer } from "@/lib/caps/gpu/marker";

/**
 * The product's Glimmer settings (docs/CAPABILITIES.md, section 17). A build and a deploy only say the shared endpoint is on:
 * askGlimmer then builds its address from GATEWAY_URL and PRODUCT_TOKEN, which the build and the deploy already set. Never
 * GLIMMER_URL. That makes glimmer() return a client, so a product whose code calls it directly would stop falling to Muse
 * Wonder and throw 503 glimmer_closed outside a window. Empty with the flag off, so .env.local and the deploy env are today's.
 */
export function gpuBuildEnv(brief: Brief): Record<string, string> {
  return usesSharedGlimmer(brief) ? { GLIMMER_SHARED: "1", GLIMMER_MODEL: "muse-glimmer" } : {};
}

export function gpuDeployEnv(brief: Brief): Record<string, string> {
  return usesSharedGlimmer(brief) ? { GLIMMER_SHARED: "1", GLIMMER_MODEL: "muse-glimmer" } : {};
}
