import { start } from "workflow/api";
import { env } from "@/lib/env";
import { partnerEvalJob } from "@/lib/train/partner/workflow";

/**
 * Starts a partner eval once a training job has been judged and published (lib/train/workflow.ts), only with
 * PARTNER_EVALS on. It runs apart from the job's workflow, and a start that fails only logs: the job's run is over and its
 * result is saved either way. No retries.
 */
export async function startPartnerEvalStep(jobId: string): Promise<void> {
  "use step";
  if (!env.partnerEvalProvider) return;
  try {
    await start(partnerEvalJob, [{ jobId }]);
  } catch (err) {
    console.error("[partner-eval] start", err instanceof Error ? err.name : "error");
  }
}
startPartnerEvalStep.maxRetries = 0;
