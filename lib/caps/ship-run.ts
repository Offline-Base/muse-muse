import type { Brief } from "@/lib/brief/schema";
import { briefCaps } from "@/lib/caps/brief-fields";
import type { CapId } from "@/lib/caps/ids";

/**
 * What each cap in CAPS_SHIPPING (lib/caps/ship.ts) does after its product deploys: a line for the build room, or null
 * when the brief has nothing for it. One entry per cap, in plan order.
 */
export interface CapShipInput {
  buildId: string;
  productId: string;
  sandboxName: string;
  liveUrl: string;
  brief: Brief;
}

export type CapShip = (input: CapShipInput) => Promise<string | null>;

/** Each entry loads its module when it runs, so the build steps' imports stay as they were for products without caps. */
export const CAP_SHIP: Partial<Record<CapId, CapShip>> = {
  extension: async (input) => {
    const { sandboxShipDeps, shipExtension } = await import("@/lib/caps/extension/ship");
    return shipExtension(input, sandboxShipDeps(input.sandboxName));
  },
};

/**
 * Runs the ship step of each enabled cap the brief has, in plan order, and returns the build room's lines. Never
 * throws: a cap that fails says so in one line, and the product stays live.
 */
export async function runCapsShip(input: CapShipInput, enabled: readonly CapId[], ships: Partial<Record<CapId, CapShip>> = CAP_SHIP): Promise<string[]> {
  const lines: string[] = [];
  for (const id of briefCaps(input.brief)) {
    const ship = enabled.includes(id) ? ships[id] : undefined;
    if (!ship) continue;
    try {
      const line = await ship(input);
      if (line) lines.push(line);
    } catch (err) {
      console.error(`[caps] ${id} after deploy failed:`, err);
      lines.push(`The ${id} step after deploy didn't finish. The web product is live as usual.`);
    }
  }
  return lines;
}
