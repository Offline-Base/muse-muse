import type { ReactNode } from "react";
import { GetItTabs } from "@/components/product/GetItTabs";
import { TARGETS, type TargetId } from "@/lib/brief/schema";
import { PRODUCT_OUTPUTS, type ProductOutput } from "@/lib/native/targets";

export type GetItSlotId = TargetId | ProductOutput;

/** What each tab is called, in the order they show: where a product runs, then what else it comes with. */
const LABELS: Record<GetItSlotId, string> = {
  web: "Web",
  phone: "Phone",
  desktop: "Desktop",
  vr: "VR",
  glasses: "Glasses",
  agent: "Agent",
  mcp: "MCP",
  cli: "CLI",
  skill: "Skill",
  claude_plugin: "Claude",
  chatgpt: "ChatGPT",
};

export const GET_IT_SLOTS: readonly GetItSlotId[] = [...TARGETS, ...PRODUCT_OUTPUTS];

/** What each unit fills for a product. A slot with nothing to show stays out of the panel: give it null. */
export type GetItSlots = Partial<Record<GetItSlotId, ReactNode>>;

function hasContent(node: ReactNode): boolean {
  if (Array.isArray(node)) return node.some(hasContent);
  return node !== null && node !== undefined && node !== false && node !== true && node !== "";
}

/**
 * The product page's "Get it" panel (docs/NATIVE.md): a tab for each slot that has something in it. With nothing in any
 * slot it renders nothing at all, so the page looks as it does without it. With one there are no tabs, only its content.
 */
export function GetItPanel({ slots }: { slots: GetItSlots }) {
  const filled = GET_IT_SLOTS.filter((id) => hasContent(slots[id])).map((id) => ({ id, label: LABELS[id], content: slots[id] }));
  if (!filled.length) return null;
  return (
    <section className="card section-card" aria-labelledby="get-it-title">
      <h2 id="get-it-title">Get it</h2>
      {filled.length === 1 ? filled[0]!.content : <GetItTabs slots={filled} />}
    </section>
  );
}
