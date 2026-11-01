import type { CapId } from "@/lib/caps/ids";
import { mediaMirrorHosts } from "@/lib/caps/media/hosts";

/**
 * Hosts a cap's build may reach beyond the build firewall's own (docs/CAPABILITIES.md, section 3). Only unit 10 adds
 * hosts here (PyPI, GET only). Unit 9's own sandboxes get their policies from lib/caps/code/policy.ts.
 */
export const CAP_BUILD_HOSTS: Partial<Record<CapId, readonly string[]>> = {
  // A brief with a runtime block has Python functions, whose packages come from PyPI: the index and its file host.
  runtime: ["pypi.org", "files.pythonhosted.org"],
  // Unit 8: the Blob host the gateway's /assets redirects to, so a build's test browser can load the speech model. GET
  // only. None until scripts/caps/mirror-assets.ts has mirrored the files (lib/caps/assets.json's mirror URLs).
  ...(mediaMirrorHosts().length ? { media: mediaMirrorHosts() } : {}),
};

/** The extra hosts for these caps, each once, in plan order. Empty for none. */
export function capBuildHosts(caps: readonly CapId[]): string[] {
  return [...new Set(caps.flatMap((id) => CAP_BUILD_HOSTS[id] ?? []))];
}

/**
 * Methods a cap host takes. Any other method gets the firewall's own 403, the way api.meta.ai's routes end
 * (lib/sandbox/policy.ts). PyPI is for downloads only, so nothing a build does can upload or publish there. A host that
 * isn't listed is allowed with no rules.
 */
export const CAP_HOST_METHODS: Readonly<Record<string, readonly string[]>> = {
  "pypi.org": ["GET"],
  "files.pythonhosted.org": ["GET"],
  ...Object.fromEntries(mediaMirrorHosts().map((h) => [h, ["GET"]])),
};

export const CAP_HOST_BLOCKED_BODY = "Blocked by the Muse Muse build firewall. This host is open to the build for downloads only.";
