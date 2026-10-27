/**
 * The durable build workflow. Real code starts at kickoff.
 *
 * TODO(kickoff, day 3): implement with the Workflow DevKit ("workflow" package).
 * Put "use workflow" as the first statement of buildProduct and "use step" as the first statement of each step
 * function. Stream BuildEvents to the build room with getWritable() inside steps.
 *
 * Outline:
 *   brief      -> transcribe voice memos, send references and note to Spark 1.3. If refused: status "refused", stop
 *   provision  -> sandbox "product-<slug>" from BUILDER_SNAPSHOT_ID, builderNetworkPolicy(), copy inspo/, write brief.md + fixtures
 *   build      -> muse exec (museExecArgs with images from inspo/), save session id from the JSONL stream
 *   preview    -> next dev -H 0.0.0.0 -p 3000, wait for 200, save sandbox.domain(3000)
 *   verify     -> npm run verify, upload screenshots to Blob, judge with JUDGE_MODEL
 *   fix        -> up to MAX_FIX_ROUNDS, then verify again
 *   deploy     -> platform reads files out of the sandbox and deploys them with the Vercel REST API
 *   register   -> product row, live gateway token, MCP tools from musemuse.json
 *   hibernate  -> sandbox.stop()
 */
export interface BuildProductInput {
  buildId: string;
}

export async function buildProduct(input: BuildProductInput): Promise<void> {
  void input;
  throw new Error("buildProduct is not implemented yet. This repo is a scaffold until kickoff.");
}
