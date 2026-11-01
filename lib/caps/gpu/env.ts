import type { Brief } from "@/lib/brief/schema";
import { usesSharedGlimmer } from "@/lib/caps/gpu/marker";
import { env } from "@/lib/env";

/**
 * The product's Glimmer settings (docs/CAPABILITIES.md, section 17), for the existing helper's own variables. A build's
 * .env.local only says the shared endpoint is on: the helper then builds its address from GATEWAY_URL and PRODUCT_TOKEN,
 * which the build token already fills. Empty with the flag off, so .env.local and the deploy env are today's.
 */
export function gpuBuildEnv(brief: Brief): Record<string, string> {
  return usesSharedGlimmer(brief) ? { GLIMMER_SHARED: "1", GLIMMER_MODEL: "muse-glimmer" } : {};
}

export function gpuDeployEnv(brief: Brief, liveToken: string): Record<string, string> {
  if (!usesSharedGlimmer(brief)) return {};
  return { GLIMMER_URL: `${env.gatewayUrl}/glimmer/v1`, GLIMMER_API_KEY: liveToken, GLIMMER_MODEL: "muse-glimmer" };
}
