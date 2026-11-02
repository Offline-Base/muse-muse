import { env } from "@/lib/env";
import { EDGE_TEMPLATE_FILES } from "@/lib/edge/template-source";

/**
 * Files the sandbox gets beyond the snapshot's template while EDGE_BUILDS is on: lib/meta/edge.ts (the cloud-to-edge
 * fallback), the muse-edge skill and the outage drill kit (docs/EDGE_DEMO.md). Empty with the flag off, so builds get
 * nothing new. The skill itself says when Muse Code should use them.
 */
export function edgeExtraFiles(): Array<{ path: string; content: string }> {
  return env.edgeBuilds ? EDGE_TEMPLATE_FILES.map((f) => ({ ...f })) : [];
}
