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
  jobs: async (input) => {
    const { shipJobs, sandboxJobsDeps } = await import("@/lib/caps/jobs/ship");
    return shipJobs(input, sandboxJobsDeps(input.sandboxName));
  },
  extension: async (input) => {
    const { sandboxShipDeps, shipExtension } = await import("@/lib/caps/extension/ship");
    return shipExtension(input, sandboxShipDeps(input.sandboxName));
  },
};

/**
 * Caps whose step runs on every deploy while they're enabled, brief block or not: a refinement that drops the block still
 * has to stop what an earlier deploy started (a schedule keeps firing otherwise).
 */
const SHIP_WITHOUT_BLOCK: readonly CapId[] = ["jobs"];

/**
 * Runs the ship step of each enabled cap the brief has, in plan order, and returns the build room's lines. Never
 * throws: a cap that fails says so in one line, and the product stays live.
 */
export async function runCapsShip(input: CapShipInput, enabled: readonly CapId[], ships: Partial<Record<CapId, CapShip>> = CAP_SHIP): Promise<string[]> {
  const lines: string[] = [];
  const has = briefCaps(input.brief);
  for (const id of [...has, ...SHIP_WITHOUT_BLOCK.filter((c) => !has.includes(c))]) {
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

/** The build room's line when the step after deploy stopped before any cap could say what happened. */
export const CAPS_SHIP_STOPPED = "The platform's steps after deploy didn't finish, so nothing extra was made from the live link. The web product is live as usual.";

/**
 * The whole step after deploy (lib/pipeline/build-steps.ts capsShipStep): reads the brief, runs each cap's ship and puts
 * each line in the build room. Never throws. When reading the brief or writing a line fails, it still tries to say so in
 * one line, so a failure is never silent.
 */
export async function runCapsShipStep(
  input: Omit<CapShipInput, "brief">,
  deps: { brief(): Promise<Brief | null>; emit(text: string): Promise<void>; enabled: readonly CapId[]; ships?: Partial<Record<CapId, CapShip>> },
): Promise<void> {
  try {
    const brief = await deps.brief();
    if (!brief) return;
    for (const text of await runCapsShip({ ...input, brief }, deps.enabled, deps.ships)) await deps.emit(text);
  } catch (err) {
    console.error("[caps] after deploy:", err);
    await deps.emit(CAPS_SHIP_STOPPED).catch((again: unknown) => console.error("[caps] after deploy, the build room line:", again));
  }
}
