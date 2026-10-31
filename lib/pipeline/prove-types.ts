/** What started a Prove it run: a build that shipped, or the nightly re-check. */
export type ProveOrigin = "ship" | "nightly";

export interface ProveInput {
  buildId: string;
  runId: string;
  origin: ProveOrigin;
}
