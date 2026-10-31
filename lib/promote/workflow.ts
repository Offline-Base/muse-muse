/**
 * The durable workflow that publishes a product imported from a local run (app/api/admin/import-product) the way a
 * live build publishes one, with this site's own env:
 *
 *   publishImportedProduct: startDeployStep (mints the live token, deploys the product's sandbox with GATEWAY_URL and
 *                           that token) -> poll until READY -> save the link -> deploy event -> hibernate the sandbox
 *                           unless a build is using it; or, when it can't publish, hibernate and then say why
 *
 * The deploy steps are the build workflow's own (lib/pipeline/build-steps.ts), so an imported product gets the same
 * project, env and token rules. The route claims the publish before it starts this, with the line in the build room
 * that says it is publishing (lib/promote/store.ts claimPublish). A deploy that fails or runs past its cap leaves the
 * product live in the gallery without a link, with the reason in its build room. That line is the run's last write,
 * since it ends the claim and lets the product be published again. Start it with start() from "workflow/api". Never
 * call it directly.
 */
import { sleep } from "workflow";
import { emitStep, pollDeployStep, startDeployStep } from "@/lib/pipeline/build-steps";
import { BuildStop, failureMessage, pollTimedOut } from "@/lib/pipeline/logic";
import { stepTimeoutMs } from "@/lib/pipeline/steps";
import { hibernateIdleStep, importFailedStep, importLiveStep } from "@/lib/promote/steps";

export interface PublishImportInput {
  productId: string;
  /** The product's latest build: the deploy reads its brief, and its build room tells the story. */
  buildId: string;
  /** products.sandbox_name: every environment shares the Vercel project's sandboxes. */
  sandboxName: string;
}

export interface PublishImportResult {
  liveUrl: string | null;
}

/** As often as the build workflow polls a deployment. */
const DEPLOY_POLL_MS = 10_000;

export async function publishImportedProduct(input: PublishImportInput): Promise<PublishImportResult> {
  "use workflow";
  const { productId, buildId, sandboxName } = input;
  let liveUrl: string | null = null;
  let failure: string | null = null;
  try {
    const deploy = await startDeployStep({ buildId, productId, sandboxName });
    const capMs = stepTimeoutMs("deploy");
    const startedAt = Date.now();
    let url: string | null = null;
    for (let polls = 1; !url; polls++) {
      await sleep(DEPLOY_POLL_MS);
      const poll = await pollDeployStep(deploy.deploymentId);
      if (poll.state === "READY") url = poll.url;
      else if (poll.state === "ERROR" || poll.state === "CANCELED") {
        throw new BuildStop(`Vercel could not deploy the product (${poll.state.toLowerCase()}). ${poll.errorMessage ?? ""}`.trim());
      } else if (pollTimedOut({ startedAt, now: Date.now(), capMs, intervalMs: DEPLOY_POLL_MS, polls })) {
        throw new BuildStop(`The deployment did not finish within ${Math.round(capMs / 60_000)} minutes.`);
      }
    }
    await importLiveStep({ productId, liveUrl: url, projectId: deploy.projectId, liveTokenId: deploy.liveTokenId });
    liveUrl = url;
    await emitStep(buildId, { type: "deploy", url });
  } catch (err) {
    if (!liveUrl) failure = failureMessage("deploy", err);
  }
  await hibernateIdleStep({ productId, sandboxName });
  // After the sandbox is asleep, so a publish started once this line is there never has its sandbox stopped under it.
  if (failure) await importFailedStep({ buildId, productId, message: failure });
  return { liveUrl };
}
