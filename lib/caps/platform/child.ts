import { randomUUID } from "node:crypto";

/**
 * A build a product started through its publish power (docs/PLATFORM_POWERS.md) says so in builds.rebuild_of, which holds
 * no catalog id here, so no rebuild page or gallery rule picks it up. Unique per child, so the gallery's newest-per-rebuild
 * rule never hides one behind another. No migration, and the mark outlives the day's counters.
 */
const PREFIX = "power:";

export function powerChildMark(parentProductId: string): string {
  return `${PREFIX}${parentProductId}:${randomUUID()}`;
}

export function isPowerChild(rebuildOf: string | null | undefined): boolean {
  return Boolean(rebuildOf?.startsWith(PREFIX));
}

/** The product that started this build, or null for any other build. */
export function powerParentOf(rebuildOf: string | null | undefined): string | null {
  return isPowerChild(rebuildOf) ? rebuildOf!.slice(PREFIX.length).split(":")[0]! : null;
}
