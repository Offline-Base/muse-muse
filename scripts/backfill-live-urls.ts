/**
 * Points products whose stored live link is the long team-scoped address (musemuse-<slug>-<team>.vercel.app) at their short
 * alias (musemuse-<slug>.vercel.app), the link new builds get since 9057a7a5. Dry run by default: it changes nothing.
 *
 *   npx tsx --env-file-if-exists=.env.local scripts/backfill-live-urls.ts            say what would change
 *   npx tsx --env-file-if-exists=.env.local scripts/backfill-live-urls.ts --apply    change products.live_url
 *     --slug a,b    only these products
 *
 * For each product it fetches both addresses with no redirects, and moves the product only when both answer 200 and name the
 * same deployment (the `dpl_` id in the page, lib/publish/live-alias.ts). The update only lands while the row still holds the
 * long link, so a build that shipped meanwhile wins. It needs DATABASE_URL for the site whose products these are, and no
 * other key. Nothing else is touched: past build events keep the link they had.
 */
import { and, eq, inArray, like } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { decideBackfill, deploymentIdOf, longLinkAlias, type PageCheck } from "@/lib/publish/live-alias";

const FETCH_MS = 15_000;
const MAX_HTML = 2_000_000;

function flag(name: string): string | null {
  const at = process.argv.indexOf(name);
  return at >= 0 ? (process.argv[at + 1] ?? "") : null;
}

async function check(url: string): Promise<PageCheck> {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(FETCH_MS), headers: { "user-agent": "musemuse-backfill-live-urls" } });
    const html = res.status === 200 ? (await res.text()).slice(0, MAX_HTML) : "";
    return { status: res.status, deploymentId: deploymentIdOf(html) };
  } catch {
    return { status: 0, deploymentId: null };
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const slugs = flag("--slug")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
  const d = db();
  const rows = await d
    .select({ id: schema.products.id, slug: schema.products.slug, liveUrl: schema.products.liveUrl })
    .from(schema.products)
    .where(and(like(schema.products.liveUrl, "https://musemuse-%.vercel.app%"), slugs?.length ? inArray(schema.products.slug, slugs) : undefined));

  let changed = 0;
  let candidates = 0;
  for (const row of rows) {
    const alias = longLinkAlias(row.liveUrl, row.slug);
    if (!alias || !row.liveUrl) continue;
    candidates++;
    const [long, short] = await Promise.all([check(row.liveUrl), check(alias)]);
    const decision = decideBackfill({ alias, long, short });
    if (!decision.update) {
      console.log(`skip    ${row.slug}: ${decision.why}`);
      continue;
    }
    if (!apply) {
      console.log(`would   ${row.slug}: ${row.liveUrl} -> ${decision.to} (${short.deploymentId})`);
      continue;
    }
    const updated = await d
      .update(schema.products)
      .set({ liveUrl: decision.to, updatedAt: new Date() })
      .where(and(eq(schema.products.id, row.id), eq(schema.products.liveUrl, row.liveUrl)))
      .returning({ id: schema.products.id });
    if (updated.length) changed++;
    console.log(`${updated.length ? "updated" : "skip   "} ${row.slug}: ${updated.length ? `${row.liveUrl} -> ${decision.to}` : "its link changed meanwhile"}`);
  }
  console.log(`\n${candidates} long link${candidates === 1 ? "" : "s"} of ${rows.length} vercel.app links. ${apply ? `${changed} updated.` : "Dry run: nothing changed. Add --apply to update."}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
