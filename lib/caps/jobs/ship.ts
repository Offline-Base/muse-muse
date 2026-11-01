import { jobsBlock } from "@/lib/caps/jobs/brief";
import { parseEvery } from "@/lib/caps/jobs/schedule";
import { clearSchedules, syncSchedules } from "@/lib/caps/jobs/store";
import type { CapShipInput } from "@/lib/caps/ship-run";
import * as sandbox from "@/lib/sandbox/builder";

/**
 * After deploy (docs/CAPABILITIES.md, section 12): the product's schedules become what its brief and shipped manifest say.
 * A refinement updates them. The manifest can narrow what the brief lists or change when it runs, never add a schedule,
 * and below 15 minutes parses as 15. Deploying counts as a visit from the owner, so paused schedules start again. A brief with
 * no jobs block ends what an earlier deploy started: its schedules go and its queue empties.
 */
export interface ShipJobsDeps {
  readManifest(): Promise<unknown>;
  syncSchedules: typeof syncSchedules;
  clearSchedules: typeof clearSchedules;
  now(): Date;
}

export const sandboxJobsDeps = (sandboxName: string): ShipJobsDeps => ({
  readManifest: () => sandbox.readManifest(sandboxName),
  syncSchedules,
  clearSchedules,
  now: () => new Date(),
});

export function shippedSchedules(block: { schedules: Array<{ name: string; every: string }> }, manifest: unknown): Array<{ name: string; every: string }> {
  const listed = (manifest as { jobs?: { schedules?: unknown } } | null | undefined)?.jobs?.schedules;
  if (!Array.isArray(listed)) return block.schedules.map(({ name, every }) => ({ name, every }));
  return block.schedules.flatMap((s) => {
    const m = listed.find((l) => (l as { name?: unknown })?.name === s.name) as { every?: unknown } | undefined;
    if (!m) return [];
    return [{ name: s.name, every: parseEvery(m.every) ? (m.every as string) : s.every }];
  });
}

export async function shipJobs(input: CapShipInput, deps: ShipJobsDeps): Promise<string | null> {
  const block = jobsBlock(input.brief);
  if (!block) {
    const gone = await deps.clearSchedules(input.productId, deps.now());
    return gone.length ? `Schedules off: ${gone.join(", ")}. This version has no background jobs.` : null;
  }
  const manifest = await deps.readManifest().catch(() => null);
  const names = await deps.syncSchedules({ productId: input.productId, schedules: shippedSchedules(block, manifest), now: deps.now() });
  return names.length ? `Schedules on: ${names.join(", ")}. They pause after 14 days with no visit from the owner.` : null;
}
