import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { emit } from "@/lib/events";
import { packageKinds, runPackaging } from "@/lib/native/package-run";
import { packagingSkippedEvent } from "@/lib/native/readiness";
import { briefTargets } from "@/lib/native/targets";

/**
 * After a build ships to its live link: makes the phone and desktop downloads its brief asks for. The product is live
 * either way, so anything that goes wrong is one build room line. The caller runs this only with PACKAGER_SNAPSHOT_ID or
 * NATIVE_TARGETS set. Without the snapshot, a brief that asks for apps gets one "skipped" line that says why, and nothing
 * else runs (docs/NATIVE_READY.md).
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
    const kinds = packageKinds(targets);
    if (!row || !kinds.length) return;
    if (!env.packagerSnapshotId) {
      await emit(input.buildId, packagingSkippedEvent({ buildId: input.buildId, kinds }));
      return;
    }
    await runPackaging({ ...input, url: input.liveUrl, slug: row.slug, name: row.name, targets, origin: "ship" });
  } catch (err) {
    console.error("[native] packaging", err);
    await emit(input.buildId, { type: "log", text: "The phone and desktop downloads couldn't be made. The product is live." });
  }
}
packageProductStep.maxRetries = 0;
