/**
 * Finds sandboxes this spike may have left: only names starting spike-rep-, with their status. With --stop, stops any that still
 * run and checks they stopped. Touches nothing else.
 *   docs/spikes/replication-2026-10-31/run.sh --list [--stop]
 */
import { Sandbox } from "@vercel/sandbox";

const PREFIX = "spike-rep-";
const stop = process.argv.includes("--stop");
// namePrefix needs sortBy "name". Errors print their message only: the SDK's error carries the whole response.
const r = await Sandbox.list({ namePrefix: PREFIX, sortBy: "name", limit: 50 } as never).catch((e: unknown) => {
  console.log(`list failed: ${e instanceof Error ? e.message.slice(0, 300) : "unknown error"}`);
  process.exit(2);
});
const items = (r as unknown as { sandboxes?: Array<{ name?: string; status?: string; createdAt?: number }> }).sandboxes ?? [];
const mine = items.filter((s) => s.name?.startsWith(PREFIX));
console.log(`${mine.length} sandboxes named ${PREFIX}*`);
for (const s of mine) {
  console.log(s.name, s.status, s.createdAt ? new Date(s.createdAt).toISOString() : "");
  if (stop && s.status === "running" && s.name) {
    const sb = await Sandbox.get({ name: s.name, resume: false });
    await sb.stop({ blocking: true }).catch((e) => console.warn("stop:", String(e)));
    const after = await Sandbox.get({ name: s.name, resume: false }).catch(() => null);
    console.log(`  stopped; status now ${after?.status ?? "gone"}`);
  }
}
