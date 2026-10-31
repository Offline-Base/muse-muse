/**
 * The steps ("use step") of an imported product's publish (lib/promote/workflow.ts) that the build workflow doesn't
 * have. The deploy itself is the build workflow's own: startDeployStep mints the live token and deploys the sandbox,
 * and pollDeployStep waits on it (lib/pipeline/build-steps.ts). These save what it published, or say why it didn't,
 * and put the sandbox back to sleep. Each one is safe to run again on retry.
 */
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { emit } from "@/lib/events";
import { revokeLiveTokensExcept, revokeTokens } from "@/lib/gateway/tokens";
import { runningBuildsFor } from "@/lib/pipeline/records";
import { stepRetries } from "@/lib/pipeline/steps";
import { hibernate } from "@/lib/sandbox/builder";

/**
 * Saves the product's link and project, then revokes every live token but the one its deployment uses, as
 * registerStep does. The status is left alone, so a product an admin turned off meanwhile stays off.
 */
export async function importLiveStep(input: {
  productId: string;
  liveUrl: string;
  projectId: string;
  liveTokenId: string;
}): Promise<void> {
  "use step";
  await db()
    .update(schema.products)
    .set({ liveUrl: input.liveUrl, vercelProjectId: input.projectId, updatedAt: new Date() })
    .where(eq(schema.products.id, input.productId));
  await revokeLiveTokensExcept(input.productId, input.liveTokenId);
}
importLiveStep.maxRetries = stepRetries("register");

/**
 * Tells the build room why the product has no link of its own. Unless something else published it meanwhile, no
 * deployment uses its live tokens, so they are revoked, as failStep does for a product that never shipped.
 */
export async function importFailedStep(input: { buildId: string; productId: string; message: string }): Promise<void> {
  "use step";
  const [row] = await db()
    .select({ liveUrl: schema.products.liveUrl })
    .from(schema.products)
    .where(eq(schema.products.id, input.productId))
    .limit(1);
  if (!row?.liveUrl) await revokeTokens(input.productId, "live");
  await emit(input.buildId, {
    type: "log",
    text: `Publishing the imported product didn't finish, so it stays in the gallery without a link of its own. ${input.message}`,
  });
}
importFailedStep.maxRetries = stepRetries("register");

/**
 * Stops the sandbox the deploy woke, unless a build of the product is using it now (an admin's refinement, say): that
 * build hibernates it when it ends. Never throws: a sandbox left running times out on its own.
 */
export async function hibernateIdleStep(input: { productId: string; sandboxName: string }): Promise<void> {
  "use step";
  try {
    if ((await runningBuildsFor(input.productId)) > 0) return;
    await hibernate(input.sandboxName);
  } catch (err) {
    console.error("[import] hibernate", err);
  }
}
hibernateIdleStep.maxRetries = stepRetries("hibernate");
