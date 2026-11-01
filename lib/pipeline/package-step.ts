import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { emit } from "@/lib/events";
import { packageKinds, runPackaging } from "@/lib/native/package-run";
import { briefTargets } from "@/lib/native/targets";

/**
 * After a build ships to its live link: makes the phone and desktop downloads its brief asks for. The product is live
 * either way, so anything that goes wrong is one build room line. The caller checks a live link and PACKAGER_SNAPSHOT_ID.
 */
export async function packageProductStep(input: { buildId: string; productId: string; liveUrl: string }): Promise<void> {
  "use step";
  try {
    const [row] = await db()
      .select({ brief: schema.builds.brief, slug: schema.products.slug, name: schema.products.name })
      .from(schema.builds)
      .innerJoin(schema.products, eq(schema.products.id, schema.builds.productId))
      .where(eq(schema.builds.id, input.buildId))
      .limit(1);
    const targets = briefTargets(row?.brief);
    if (!row || !packageKinds(targets).length) return;
    await runPackaging({ ...input, url: input.liveUrl, slug: row.slug, name: row.name, targets, origin: "ship" });
  } catch (err) {
    console.error("[native] packaging", err);
    await emit(input.buildId, { type: "log", text: "The phone and desktop downloads couldn't be made. The product is live." });
  }
}
packageProductStep.maxRetries = 0;
