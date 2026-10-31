/**
 * Finds sandboxes this spike may have left behind: only names starting musecode-spike-, with their status. With --stop, stops any
 * that still run, and touches nothing else.
 *   docs/spikes/musecode-2026-10-31/creds.sh docs/spikes/musecode-2026-10-31/list.ts [--stop]
 */
import { Sandbox } from "@vercel/sandbox";

const stop = process.argv.includes("--stop");
const r = await Sandbox.list({ namePrefix: "musecode-spike-", sortBy: "name", limit: 50 } as never);
const items = (r as unknown as { sandboxes?: Array<{ name?: string; status?: string; createdAt?: number }> }).sandboxes ?? [];
const mine = items.filter((s) => s.name?.startsWith("musecode-spike-"));
console.log(`${mine.length} sandboxes from this spike`);
for (const s of mine) {
  console.log(s.name, s.status, s.createdAt ? new Date(s.createdAt).toISOString() : "");
  if (stop && s.status === "running" && s.name) {
    const sb = await Sandbox.get({ name: s.name });
    await sb.stop({ blocking: true }).catch((e) => console.warn("stop:", String(e)));
    const after = await Sandbox.get({ name: s.name }).catch(() => null);
    console.log(`  stopped; status now ${after?.status ?? "gone"}`);
  }
}
