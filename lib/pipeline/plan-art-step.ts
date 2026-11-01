import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { addBuildCost, emit } from "@/lib/events";
import { metaPlatform } from "@/lib/meta/platform";
import { makePlanArt, PLAN_ART_REFERENCE, PLAN_ART_TIMEOUT_MS, type EditReply } from "@/lib/pipeline/plan-art";
import { putFile } from "@/lib/storage";
import { platformSpendToday, recordUsage } from "@/lib/usage";

/**
 * The mascot as the edit's reference: the file itself as a data URL where the server has it (a local run, `next start`),
 * else the platform's own public URL for it, which Muse Image fetches (on Vercel, where public/ is served by the CDN).
 */
async function reference(): Promise<string> {
  try {
    const bytes = await readFile(path.join(process.cwd(), "public", PLAN_ART_REFERENCE));
    return `data:image/jpeg;base64,${bytes.toString("base64")}`;
  } catch {
    return `${env.platformUrl}${PLAN_ART_REFERENCE}`;
  }
}

/**
 * PLAN_ART: the plan card's own picture for a new build (lib/pipeline/plan-art.ts). Runs beside the build's next steps
 * and returns the picture's URL, or null when there is none. Never throws and never retries: one call at most, about
 * $0.01, and anything going wrong keeps the stock mascot.
 */
export async function planArtStep(buildId: string): Promise<string | null> {
  "use step";
  if (!env.planArt) return null;
  try {
    const [build] = await db()
      .select({ kind: schema.builds.kind, brief: schema.builds.brief, productId: schema.builds.productId })
      .from(schema.builds)
      .where(eq(schema.builds.id, buildId))
      .limit(1);
    if (!build || build.kind !== "build" || !build.brief) return null;
    const outcome = await makePlanArt(build.brief, {
      spendOk: async () => (await platformSpendToday()) < env.dailySpendCapUsd,
      reference,
      edit: (body, signal) =>
        metaPlatform().post<EditReply>("/images/edits", { body, signal, maxRetries: 0, timeout: PLAN_ART_TIMEOUT_MS }),
      store: (bytes, type) => putFile("fixtures", `${buildId}/plan-art.${type.ext}`, bytes, type.contentType),
      charge: async (usage) => {
        await recordUsage({ source: "platform", endpoint: "images/edits", buildId, productId: build.productId }, usage);
        await addBuildCost(buildId, usage.reduce((sum, u) => sum + (u.costUsd || 0), 0), "Plan picture");
      },
      emit: (url) => emit(buildId, { type: "plan_art", url }),
      log: (message) => console.warn(`[plan art] ${buildId}: ${message}`),
    });
    return "url" in outcome ? outcome.url : null;
  } catch (err) {
    console.warn(`[plan art] ${buildId}: ${(err as Error).message}`);
    return null;
  }
}
planArtStep.maxRetries = 0;
