/**
 * How a harness run ended (scripts/dev/tune-harness.ts), from the events its GPU saved. The last "done" or "failed" decides.
 * Neither means the segment stopped before the runner finished, so that is a failure too: no "done", no success.
 */
export function harnessOutcome(eventLines: readonly string[]): { status: "succeeded" | "failed"; reason: string } {
  for (let i = eventLines.length - 1; i >= 0; i--) {
    const body = JSON.parse(eventLines[i]!) as { type?: string; error?: string };
    if (body.type === "done") return { status: "succeeded", reason: "Harness run: the runner reported done." };
    if (body.type === "failed") return { status: "failed", reason: body.error || "The job failed." };
  }
  return { status: "failed", reason: "Harness run: the GPU's segment ended with no done from the runner." };
}
