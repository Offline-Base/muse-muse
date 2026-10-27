/**
 * Deletes a test sandbox and the snapshots only it uses.
 *   npx tsx --env-file=.env.local scripts/dev/sandbox-delete.ts <sandbox name>
 */
import { Sandbox } from "@vercel/sandbox";

const name = process.argv[2];
if (!name) throw new Error("usage: sandbox-delete.ts <sandbox name>");
const sb = await Sandbox.get({ name });
await sb.delete({ deleteOrphanSnapshots: true });
console.log(`deleted ${name}`);
