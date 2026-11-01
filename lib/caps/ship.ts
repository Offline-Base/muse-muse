import type { CapId } from "@/lib/caps/ids";

/**
 * Caps that make something from a product's live link right after it deploys (docs/CAPABILITIES.md, section 20): the
 * extension's zip, which needs the live link for its one host permission, and the jobs cap's schedules, which start once
 * there is a link to call. Pure, with no imports but types, so the
 * workflow (lib/pipeline/workflow.ts) can read it. The work itself is in lib/caps/ship-run.ts (CAP_SHIP), one entry per
 * id here, in plan order.
 */
export const CAPS_SHIPPING: readonly CapId[] = ["jobs", "extension"];

/** True when an enabled cap has a step after deploy. False with every flag off, so the workflow runs no extra step. */
export function capsShipping(enabled: readonly CapId[]): boolean {
  return enabled.some((id) => CAPS_SHIPPING.includes(id));
}
