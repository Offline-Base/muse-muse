/**
 * Queues a tuned model's emulator run on the lab's existing queue, and reads the results back. native_jobs needs a run, a
 * build and a product, and a tuned model has none of those, so all these jobs hang off one hidden home: a disabled product
 * with one finished build, made the first time an admin runs one. That avoids a migration and leaves every line of the
 * queue as it is. Its runs have the origin "agent", which the product views skip.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { enqueueJob, type EnqueueResult } from "@/lib/native/queue";
import { localFilesFor } from "@/lib/train/local-files-server";
import { pickSimTuneFile, SIM_TUNE_KIND, SIM_TUNE_LIMIT_SECONDS, SIM_TUNE_MAX_TOKENS, SIM_TUNE_PROMPTS, simTuneActive, simTuneRunView, type SimTuneJobRow, type SimTuneRunView } from "@/lib/train/sim-tune";

const HOME_SLUG = "sim-tune-emulator-runs";

/** The hidden product and build. Two admins racing make one product: the slug is unique and the loser reads the winner's. */
async function simTuneHome(userId: string): Promise<{ productId: string; buildId: string }> {
  const d = db();
  const find = () => d.select({ id: schema.products.id }).from(schema.products).where(eq(schema.products.slug, HOME_SLUG));
  let [product] = await find();
  if (!product) {
    await d.insert(schema.products).values({ slug: HOME_SLUG, name: "Emulator runs (internal)", ownerId: userId, status: "disabled" }).onConflictDoNothing();
    [product] = await find();
  }
  const [build] = await d.select({ id: schema.builds.id }).from(schema.builds).where(eq(schema.builds.productId, product.id)).limit(1);
  if (build) return { productId: product.id, buildId: build.id };
  const [inspiration] = await d.insert(schema.inspirations).values({ userId }).returning({ id: schema.inspirations.id });
  const [made] = await d.insert(schema.builds).values({ inspirationId: inspiration.id, userId, productId: product.id, status: "failed" }).returning({ id: schema.builds.id });
  return { productId: product.id, buildId: made.id };
}

/** This model's newest emulator runs, newest first. */
export async function simTuneRuns(adapterJobId: string, limit = 3): Promise<SimTuneRunView[]> {
  const rows = await db()
    .select()
    .from(schema.nativeJobs)
    .where(and(eq(schema.nativeJobs.kind, SIM_TUNE_KIND), sql`${schema.nativeJobs.input}->>'adapterJobId' = ${adapterJobId}`))
    .orderBy(desc(schema.nativeJobs.createdAt))
    .limit(limit);
  return rows.map((row) => simTuneRunView(row as unknown as SimTuneJobRow));
}

export type StartSimTune = EnqueueResult | { ok: false; reason: "no_file" | "running"; message: string };

export async function startSimTune(adapterJobId: string, userId: string): Promise<StartSimTune> {
  const pick = pickSimTuneFile(await localFilesFor(adapterJobId), env.simTuneMaxBytes);
  if (!pick.ok) return { ok: false, reason: "no_file", message: pick.problem };
  const latest = await simTuneRuns(adapterJobId, 1);
  if (latest[0] && simTuneActive(latest[0].status)) return { ok: false, reason: "running", message: "This model already has an emulator run going." };
  const home = await simTuneHome(userId);
  const [run] = await db()
    .insert(schema.nativeRuns)
    .values({ ...home, origin: "agent", targets: ["phone"], status: "running", createdBy: userId })
    .returning({ id: schema.nativeRuns.id });
  return enqueueJob({
    runId: run.id,
    ...home,
    kind: SIM_TUNE_KIND,
    tier: "ship",
    input: {
      v: 1,
      limitSeconds: SIM_TUNE_LIMIT_SECONDS,
      adapterJobId,
      gguf: { repo: pick.repo, commit: pick.commit, name: pick.file.name, sha256: pick.file.sha256, bytes: pick.file.bytes },
      prompts: [...SIM_TUNE_PROMPTS],
      systemLine: pick.systemLine,
      maxTokens: SIM_TUNE_MAX_TOKENS,
    },
  });
}
