/**
 * Lists Muse Muse sandboxes (tag app=musemuse) and recent snapshots, to spot leftovers.
 *   npx tsx --env-file=.env.local scripts/dev/sandbox-list.ts
 */
import { Sandbox, Snapshot } from "@vercel/sandbox";

const sandboxes = await (await Sandbox.list({ tags: { app: "musemuse" } })).toArray();
console.log(`sandboxes tagged app=musemuse: ${sandboxes.length}`);
for (const s of sandboxes) console.log(`  ${s.name}  ${s.status}  persistent=${s.persistent}  created ${new Date(s.createdAt).toISOString()}`);
const all = await (await Sandbox.list({})).toArray();
console.log(`all sandboxes in the project: ${all.length}`);
for (const s of all) console.log(`  ${s.name}  ${s.status}  persistent=${s.persistent}  tags ${JSON.stringify(s.tags ?? {})}  created ${new Date(s.createdAt).toISOString()}`);
const snaps = await (await Snapshot.list({})).toArray();
console.log(`snapshots: ${snaps.length}`);
for (const s of snaps) {
  const x = s as typeof s & { creationMethod?: string; parentId?: string };
  console.log(
    `  ${s.id}  ${s.status}  ${Math.round(s.sizeBytes / 1e6)} MB  created ${new Date(s.createdAt).toISOString()}  expires ${s.expiresAt ? new Date(s.expiresAt).toISOString() : "never"}  method ${x.creationMethod ?? "?"}  session ${s.sourceSessionId}`,
  );
}
