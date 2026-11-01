import type { Brief } from "@/lib/brief/schema";
import { briefCaps } from "@/lib/caps/brief-fields";
import type { CapId } from "@/lib/caps/ids";
import { EXTENSION_RENDER } from "@/lib/caps/extension/render";
import { GAMES_RENDER } from "@/lib/caps/games/render";
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
  runtime: RUNTIME_RENDER,
  extension: EXTENSION_RENDER,
  games: GAMES_RENDER,
};

function rendered(brief: Brief): Array<[CapId, CapRenderEntry]> {
  return briefCaps(brief).flatMap((id) => (CAP_RENDER[id] ? [[id, CAP_RENDER[id]] as [CapId, CapRenderEntry]] : []));
}

/** `## Platform services` with a `###` per cap block, for brief.md. Empty for a brief with no cap blocks. */
export function capsBuildLines(brief: Brief): string[] {
  const on = rendered(brief);
  if (!on.length) return [];
  return ["", "## Platform services", ...on.flatMap(([, e]) => ["", `### ${e.title}`, "", ...e.build(brief)])];
}

/** What a change request adds for the product's caps. Empty for a product with none. */
export function capsRefineLines(brief: Brief): string[] {
  return rendered(brief).flatMap(([, e]) => e.refine?.(brief) ?? []);
}

/** The product page's brief markdown, after the Agent section. Empty for a brief with no cap blocks. */
export function capsMarkdown(brief: Brief): string[] {
  const on = rendered(brief).filter(([, e]) => e.markdown);
  if (!on.length) return [];
  return ["", "## Platform services", ...on.flatMap(([, e]) => ["", `**${e.title}**`, "", ...(e.markdown?.(brief) ?? [])])];
}
