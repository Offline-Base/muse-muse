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
  // The demo task's cap covers the test run and Demo Studio's render. finishDemo's basic cut has its own limit.
  { name: "record", does: "Rerun the test with Demo Studio's recorder, then edit it into a 1920x1080 MP4 and a poster", timeoutMs: 9 * MIN, retries: 1 },
  { name: "deploy", does: "Read source out of the sandbox and deploy it as the product's Vercel project", timeoutMs: 6 * MIN, retries: 2 },
  { name: "register", does: "Save the product, mint its live gateway token, build its MCP tools", timeoutMs: 0.5 * MIN, retries: 3 },
  { name: "hibernate", does: "Stop the sandbox so it snapshots for later refinements", timeoutMs: 1 * MIN, retries: 2 },
] as const;

export const MAX_FIX_ROUNDS = 3;

export function stepSpec(name: StepName): StepSpec {
  const spec = STEPS.find((s) => s.name === name);
  if (!spec) throw new Error(`Unknown step ${name}`);
  return spec;
}

/** Retries from the table above, for `fn.maxRetries`. */
export function stepRetries(name: StepName): number {
  return stepSpec(name).retries;
}

/** Time cap for the poll loops that wait on long sandbox work. */
export function stepTimeoutMs(name: StepName): number {
  return stepSpec(name).timeoutMs;
}
