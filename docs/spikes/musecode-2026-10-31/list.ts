/**
 * Finds sandboxes this spike may have left behind. Prints only names starting musecode-spike-, with their status.
 * Stops nothing. Not yet run successfully: Vercel auth was expired on Oct 31, so Sandbox.list's result shape is unchecked.
 *   npx tsx --env-file=<.env.local> docs/spikes/musecode-2026-10-31/list.ts
 */
import { Sandbox } from "@vercel/sandbox";

const r = (await (Sandbox as unknown as { list: (o: { limit: number }) => Promise<Record<string, unknown>> }).list({ limit: 50 })) as {
  json?: { sandboxes?: Array<{ name?: string; status?: string }> };
  sandboxes?: Array<{ name?: string; status?: string }>;
};
const items = r.json?.sandboxes ?? r.sandboxes ?? [];
const mine = items.filter((s) => s.name?.startsWith("musecode-spike-"));
console.log(`${items.length} sandboxes listed, ${mine.length} from this spike`);
for (const s of mine) console.log(s.name, s.status);
