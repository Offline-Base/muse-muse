import { CAP_IDS, capMarker, type CapId } from "@/lib/caps/ids";

/**
 * A product's musemuse.json may narrow its caps (its `caps` list), never widen them (docs/CAPABILITIES.md, 2.3), as it
 * does for an agent's tools (lib/tools/catalog.ts). A manifest with no `caps` list narrows nothing.
 */

/** The caps a manifest lists, or null when it has no `caps` list. Anything that isn't a cap id is dropped. */
export function manifestCapIds(manifest: unknown): Set<CapId> | null {
  const caps = (manifest as { caps?: unknown } | null | undefined)?.caps;
  if (caps === undefined) return null;
  if (!Array.isArray(caps)) return new Set();
  return new Set(caps.filter((c): c is CapId => (CAP_IDS as readonly unknown[]).includes(c)));
}

/**
 * The caps a token may use: the `cap:<id>` markers the brief gave it, narrowed by the product's manifest. A refinement's
 * build token skips the manifest, since the stored one is the previous version's. For the cap gate (unit 3, check 3).
 */
export function allowedCapIds(token: { scope: string; allowedModels: readonly string[] }, manifest: unknown): CapId[] {
  const ids = CAP_IDS.filter((id) => token.allowedModels.includes(capMarker(id)));
  const narrowed = token.scope === "build" ? null : manifestCapIds(manifest);
  return narrowed ? ids.filter((id) => narrowed.has(id)) : ids;
}

/** A live token's allowlist with the cap markers the manifest leaves out removed. Never adds one. */
export function narrowCapMarkers(allowed: readonly string[], manifest: unknown): string[] {
  const narrowed = manifestCapIds(manifest);
  if (!narrowed) return [...allowed];
  return allowed.filter((m) => !m.startsWith("cap:") || narrowed.has(m.slice(4) as CapId));
}
