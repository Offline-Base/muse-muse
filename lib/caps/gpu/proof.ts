import type { Brief } from "@/lib/brief/schema";
import { gpuProofLines } from "@/lib/caps/gpu/judge";
import { usesSharedGlimmer } from "@/lib/caps/gpu/marker";
import { glimmerBuildCounts } from "@/lib/caps/gpu/store";
import { env } from "@/lib/env";
import { publicHost } from "@/lib/sandbox/policy";

/**
 * What judgeStep adds to its fixed checks for a build on the shared endpoint, or null. A local run's sandbox can't reach the
 * gateway, so its record would say nothing about the product, and this says nothing there too.
 */
export async function gpuProofText(brief: Brief, buildId: string): Promise<string | null> {
  if (!usesSharedGlimmer(brief) || publicHost(env.platformUrl) === null) return null;
  return gpuProofLines(await glimmerBuildCounts(buildId)).join("\n");
}
