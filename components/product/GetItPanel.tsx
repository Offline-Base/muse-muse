import type { ReactNode } from "react";
import { GetItTabs } from "@/components/product/GetItTabs";
import { TARGETS, type TargetId } from "@/lib/brief/schema";
import { CAP_OUTPUTS, PRODUCT_OUTPUTS, RUNTIME_OUTPUTS, type CapOutput, type ProductOutput, type RuntimeOutput } from "@/lib/native/targets";

export type GetItSlotId = TargetId | ProductOutput | RuntimeOutput | CapOutput;

/** What each tab is called, in the order they show: where a product runs, then what else it comes with. */
const LABELS: Record<GetItSlotId, string> = {
  web: "Web",
  phone: "Phone",
  desktop: "Desktop",
  vr: "VR",
  glasses: "Glasses",
  agent: "Agent",
  edge: "Edge",
  mcp: "MCP",
  cli: "CLI",
  skill: "Skill",
  claude_plugin: "Claude",
  chatgpt: "ChatGPT",
  gadget: "Muse gadget",
  vscode: "VS Code",
  github_action: "GitHub Action",
  self_host: "Self-host",
  extension: "Extension",
};

/** Tabs that need another account or a device to try, behind "More ways to use it" until opened (GetItTabs). */
export const GET_IT_MORE: readonly GetItSlotId[] = ["claude_plugin", "chatgpt", "gadget"];

export const GET_IT_SLOTS: readonly GetItSlotId[] = [...TARGETS, ...PRODUCT_OUTPUTS, ...RUNTIME_OUTPUTS, ...CAP_OUTPUTS];

/** What each unit fills for a product. A slot with nothing to show stays out of the panel: give it null. */
export type GetItSlots = Partial<Record<GetItSlotId, ReactNode>>;

function hasContent(node: ReactNode): boolean {
  if (Array.isArray(node)) return node.some(hasContent);
  return node !== null && node !== undefined && node !== false && node !== true && node !== "";
}

/**
 * The product page's "Get it" panel (docs/NATIVE.md): a tab for each slot that has something in it. With nothing in any
 * slot it renders nothing at all, so the page looks as it does without it. With one there are no tabs, only its content.
 * `initial` picks the tab it opens on, when that slot is filled, and the first one otherwise.
 */
export function GetItPanel({ slots, initial }: { slots: GetItSlots; initial?: GetItSlotId }) {
  const filled = GET_IT_SLOTS.filter((id) => hasContent(slots[id])).map((id) => ({ id, label: LABELS[id], content: slots[id] }));
  if (!filled.length) return null;
  return (
    <section className="card section-card" aria-labelledby="get-it-title">
      <h2 id="get-it-title">Get it</h2>
      {filled.length === 1 ? filled[0]!.content : <GetItTabs slots={filled} initial={initial} more={GET_IT_MORE} />}
    </section>
  );
}
