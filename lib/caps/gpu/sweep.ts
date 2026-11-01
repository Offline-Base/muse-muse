import { windowDeps } from "@/lib/caps/gpu/deps";
import { sweepWindows } from "@/lib/caps/gpu/windows";

/** The hourly sweep's entry (lib/caps/cleanup.ts). In its own file, so the registry's other importers read it only then. */
export async function sweepGlimmerWindows(now: Date): Promise<number> {
  return sweepWindows(now, windowDeps());
}
