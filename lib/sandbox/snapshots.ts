import manifest from "@/lib/sandbox/snapshots.json";

/**
 * The builder snapshots and the cap overlays each one carries (docs/CAPABILITIES.md, 2.4a). scripts/make-builder-snapshot.ts
 * appends an entry under each new id, and the entry is committed with the BUILDER_SNAPSHOT_ID change, so it deploys in
 * the same redeploy. Snapshot ids aren't credentials. There is no env var for this on purpose: a second setting that
 * moves with every id would drift.
 */
export interface SnapshotEntry {
  createdAt: string;
  templateHash: string;
  /** The template/caps overlays the snapshot installed in CAPS_DIR, sorted. */
  capOverlays: string[];
}

export type SnapshotManifest = Record<string, SnapshotEntry>;

export const SNAPSHOTS: SnapshotManifest = manifest as SnapshotManifest;

const warned = new Set<string>();

/**
 * The cap overlays the snapshot `id` has, from the manifest. An id missing from it, or no id, gives [] and one warning
 * per process naming the id, so every cap stays out of new briefs until the manifest has it.
 */
export function snapshotCapOverlays(id: string | undefined, snapshots: SnapshotManifest = SNAPSHOTS, warn: (line: string) => void = console.warn): string[] {
  const entry = id ? snapshots[id] : undefined;
  if (entry && Array.isArray(entry.capOverlays)) return entry.capOverlays.filter((o) => typeof o === "string");
  const key = id ?? "(none)";
  if (!warned.has(key)) {
    warned.add(key);
    warn(`musemuse: builder snapshot ${id ? id : "(BUILDER_SNAPSHOT_ID is not set)"} is not in lib/sandbox/snapshots.json, so no caps. Run npm run snapshot and commit the manifest with the id.`);
  }
  return [];
}

/** Forgets which ids were warned about. For tests. */
export function resetSnapshotWarnings(): void {
  warned.clear();
}
