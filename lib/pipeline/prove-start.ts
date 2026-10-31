import { start } from "workflow/api";
import { proveProduct } from "@/lib/pipeline/prove";
import { proveAbandonStep } from "@/lib/pipeline/prove-steps";

/**
 * Starts the Prove it workflow once a build is final. It runs apart from the build's own workflow, and a start that
 * fails leaves a line saying so and nothing else. No retries: the build's run is over either way.
 */
export async function startProveStep(input: { buildId: string; runId: string }): Promise<void> {
  "use step";
  try {
    await start(proveProduct, [{ ...input, origin: "ship" as const }]);
  } catch (err) {
    console.error("[prove] start", err);
    await proveAbandonStep({ ...input, origin: "ship" }, "Prove it couldn't start.");
  }
}
startProveStep.maxRetries = 0;
