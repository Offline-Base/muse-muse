import { EDGE_TEMPLATE_FILES } from "@/lib/edge/template-source";
import { isEdgeBuild } from "@/lib/pipeline/edge-build";

/**
 * Files the sandbox gets beyond the snapshot's template for an edge build: lib/meta/edge.ts (the cloud-to-edge
 * fallback), the muse-edge skill and the outage drill kit (docs/EDGE_DEMO.md). Only for a brief whose targets include
 * edge while EDGE_ENABLED and EDGE_BUILDS are on (isEdgeBuild), so with the flags off, or for any other build with
 * them on, a build gets nothing new.
 */
export function edgeExtraFiles(brief: Parameters<typeof isEdgeBuild>[0]): Array<{ path: string; content: string }> {
  return isEdgeBuild(brief) ? EDGE_TEMPLATE_FILES.map((f) => ({ ...f })) : [];
}
