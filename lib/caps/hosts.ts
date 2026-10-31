import type { CapId } from "@/lib/caps/ids";

/**
 * Hosts a cap's build may reach beyond the build firewall's own (docs/CAPABILITIES.md, section 3). Only unit 10 adds
 * hosts here (PyPI, GET only). Unit 9's own sandboxes get their policies from lib/caps/code/policy.ts.
 */
export const CAP_BUILD_HOSTS: Partial<Record<CapId, readonly string[]>> = {};

/** The extra hosts for these caps, each once, in plan order. Empty for none. */
export function capBuildHosts(caps: readonly CapId[]): string[] {
  return [...new Set(caps.flatMap((id) => CAP_BUILD_HOSTS[id] ?? []))];
}
