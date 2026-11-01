import { capError, type CapStage } from "@/lib/caps/gate";
import { buildNamespace } from "@/lib/caps/proof";
import { gatewayError } from "@/lib/gateway/errors";

/**
 * A job token lasts 10 minutes, and its run can end sooner: at its dollar limit, cancelled with the product, or simply
 * finished. Every route that takes a job as its caller asks this first (docs/CAPABILITIES.md, 12a), so a token only
 * works while its own run is running, on this product and in this namespace. Anyone who isn't a job passes. With no way to
 * read the run (the jobs cap isn't served), a job is refused rather than trusted.
 */
export type JobRunRead = (runId: string) => Promise<{ productId: string; namespace: string; status: string } | null>;

export const jobNotRunning = (status: string) => gatewayError(409, "invalid_request_error", "job_not_running", `This job run is ${status}, so there is nothing to do.`, { retry: false });

export async function jobRunRefusal(stage: Pick<CapStage, "caller" | "token">, read: JobRunRead | undefined): Promise<Response | null> {
  const runId = stage.caller.job;
  if (!runId) return null;
  const wrong = () => capError("cap_not_allowed", "That job token isn't for this product.");
  if (!read) return wrong();
  const run = await read(runId);
  const namespace = stage.token.scope === "build" ? buildNamespace(stage.token.buildId!) : "live";
  if (!run || run.productId !== stage.token.productId || run.namespace !== namespace) return wrong();
  return run.status === "running" ? null : jobNotRunning(run.status);
}
