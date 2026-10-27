/**
 * Deletes a test snapshot. Never point this at the BUILDER_SNAPSHOT_ID in use.
 *   npx tsx --env-file=.env.local scripts/dev/sandbox-delete-snapshot.ts <snapshotId>
 */
import { Snapshot } from "@vercel/sandbox";

const id = process.argv[2];
if (!id?.startsWith("snap_")) throw new Error("usage: sandbox-delete-snapshot.ts <snapshotId>");
if (id === process.env.BUILDER_SNAPSHOT_ID) throw new Error("Refusing to delete the BUILDER_SNAPSHOT_ID in use");
const snap = await Snapshot.get({ snapshotId: id });
await snap.delete();
console.log(`deleted ${id}`);
