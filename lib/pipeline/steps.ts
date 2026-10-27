/** The build workflow's steps, as described in docs/DESIGN.md section 2. */
export type StepName =
  | "brief"
  | "provision"
  | "build"
  | "preview"
  | "verify"
  | "fix"
  | "record"
  | "deploy"
  | "register"
  | "hibernate";

export interface StepSpec {
  name: StepName;
  does: string;
  timeoutMs: number;
  retries: number;
}

const MIN = 60_000;

export const STEPS: readonly StepSpec[] = [
  { name: "brief", does: "Read the inspo and note, write a structured brief or a refusal", timeoutMs: 1.5 * MIN, retries: 2 },
  { name: "provision", does: "Get or create the product sandbox from the builder snapshot, copy inspo files to inspo/, write brief.md and fixtures, set the network policy", timeoutMs: 3 * MIN, retries: 2 },
  { name: "build", does: "Run muse exec detached and stream its JSONL events", timeoutMs: 20 * MIN, retries: 0 },
  { name: "preview", does: "Start next dev on port 3000 and save sandbox.domain(3000)", timeoutMs: 2 * MIN, retries: 1 },
  { name: "verify", does: "npm run verify, collect screenshots, ask the judge", timeoutMs: 8 * MIN, retries: 0 },
  { name: "fix", does: "Resume the Muse Code session with the failures", timeoutMs: 10 * MIN, retries: 0 },
  { name: "record", does: "Rerun the test at 1280x720 with video, then make an MP4 with a title card and step captions", timeoutMs: 5 * MIN, retries: 1 },
  { name: "deploy", does: "Read source out of the sandbox and deploy it as the product's Vercel project", timeoutMs: 6 * MIN, retries: 2 },
  { name: "register", does: "Save the product, mint its live gateway token, build its MCP tools", timeoutMs: 0.5 * MIN, retries: 3 },
  { name: "hibernate", does: "Stop the sandbox so it snapshots for later refinements", timeoutMs: 1 * MIN, retries: 2 },
] as const;

export const MAX_FIX_ROUNDS = 3;
