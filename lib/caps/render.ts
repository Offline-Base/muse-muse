import type { Brief } from "@/lib/brief/schema";
import { briefCaps } from "@/lib/caps/brief-fields";
import { CONNECT_RENDER } from "@/lib/caps/connect/render";
import { CODE_RENDER } from "@/lib/caps/code/render";
import { DATA_RENDER } from "@/lib/caps/data/render";
import { fleetBuildLines, fleetRefineLines } from "@/lib/caps/fleet/render";
import { gpuBuildLines, gpuRefineLines } from "@/lib/caps/gpu/render";
import type { CapId } from "@/lib/caps/ids";
import { EXTENSION_RENDER } from "@/lib/caps/extension/render";
import { FILES_RENDER } from "@/lib/caps/files/render";
import { GAMES_RENDER } from "@/lib/caps/games/render";
import { HARDWARE_RENDER } from "@/lib/caps/hardware/render";
import { JOBS_RENDER } from "@/lib/caps/jobs/render";
import { LIVE_RENDER } from "@/lib/caps/live/render";
import { MEDIA_RENDER } from "@/lib/caps/media/render";
import { PLATFORM_RENDER } from "@/lib/caps/platform/brief";
import { RUNTIME_RENDER } from "@/lib/caps/runtime/render";

/**
 * Each cap's part of the prompts Muse Code gets (docs/CAPABILITIES.md, 2.6). One line per cap, in plan order; the text
 * lives in lib/caps/<id>/render.ts. A cap's build section says, in this order: what the brief asks for, the skill to read
 * first, the helpers, the scope and privacy rules, the limits a user sees, what the build's stand-in returns, and the
 * smoke test's rules, and names any line of template/AGENTS.md that doesn't hold for this brief.
 */
export interface CapRenderEntry {
  /** The `###` heading of its section. */
  title: string;
  build(brief: Brief): string[];
  refine?(brief: Brief): string[];
  markdown?(brief: Brief): string[];
}

export const CAP_RENDER: Partial<Record<CapId, CapRenderEntry>> = {
  data: DATA_RENDER,
  files: FILES_RENDER,
  connect: CONNECT_RENDER,
  jobs: JOBS_RENDER,
  live: LIVE_RENDER,
  media: MEDIA_RENDER,
  code: CODE_RENDER,
  runtime: RUNTIME_RENDER,
  hardware: HARDWARE_RENDER,
  extension: EXTENSION_RENDER,
  games: GAMES_RENDER,
  platform: PLATFORM_RENDER,
};

function rendered(brief: Brief): Array<[CapId, CapRenderEntry]> {
  return briefCaps(brief).flatMap((id) => (CAP_RENDER[id] ? [[id, CAP_RENDER[id]] as [CapId, CapRenderEntry]] : []));
}

/** `## Platform services` with a `###` per cap block, for brief.md. Empty for a brief with no cap blocks. */
export function capsBuildLines(brief: Brief): string[] {
  const on = rendered(brief);
  // Wave 3, unit 11: GPU isn't a cap, so its section has no block. Nothing with GPU_GLIMMER_SHARED off.
  const gpu = gpuBuildLines(brief);
  // The Jetson fleet isn't a cap either (section 17b). Nothing with FLEET_PRODUCTS off.
  const fleet = fleetBuildLines(brief);
  if (!on.length && !gpu.length && !fleet.length) return [];
  return ["", "## Platform services", ...on.flatMap(([, e]) => ["", `### ${e.title}`, "", ...e.build(brief)]), ...gpu, ...fleet];
}

/** What a change request adds for the product's caps. Empty for a product with none. */
export function capsRefineLines(brief: Brief): string[] {
  return [...rendered(brief).flatMap(([, e]) => e.refine?.(brief) ?? []), ...gpuRefineLines(brief), ...fleetRefineLines(brief)];
}

/** The product page's brief markdown, after the Agent section. Empty for a brief with no cap blocks. */
export function capsMarkdown(brief: Brief): string[] {
  const on = rendered(brief).filter(([, e]) => e.markdown);
  if (!on.length) return [];
  return ["", "## Platform services", ...on.flatMap(([, e]) => ["", `**${e.title}**`, "", ...(e.markdown?.(brief) ?? [])])];
}
