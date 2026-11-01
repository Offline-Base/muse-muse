import { CHAIN_ROUND_MAX_MS, type ChainLimits } from "@/lib/chain/plan";
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

// Brief, build and fix fit Muse Wonder, the default for all three: about 17 s a brief plus a repair call or a video,
// and build steps about 1.4 times slower than Spark's. The sandbox's 40-minute work window still covers the longest.
export const STEPS: readonly StepSpec[] = [
  { name: "brief", does: "Read the inspo and note, write a structured brief or a refusal", timeoutMs: 2 * MIN, retries: 2 },
  { name: "provision", does: "Get or create the product sandbox from the builder snapshot, copy inspo files to inspo/, write brief.md and fixtures, set the network policy", timeoutMs: 3 * MIN, retries: 2 },
  { name: "build", does: "Run muse exec detached and stream its JSONL events", timeoutMs: 60 * MIN, retries: 0 },
  { name: "preview", does: "Start next dev on port 3000 and save sandbox.domain(3000)", timeoutMs: 2 * MIN, retries: 1 },
  { name: "verify", does: "npm run verify, collect screenshots, ask the judge", timeoutMs: 8 * MIN, retries: 0 },
  { name: "fix", does: "Resume the Muse Code session with the failures", timeoutMs: 12 * MIN, retries: 0 },
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

// ---------- Wave 3, unit 2: round time by brief size (docs/CAPABILITIES.md, section 8) ----------

/** The longest a build may take from its start, across every Muse Code round, verify and fix, when the engine scales. */
export const MAX_BUILD_WALL_MS = 90 * MIN;
/** A Muse Code round shorter than this isn't worth starting near the wall: the checks need the time instead. */
export const MIN_ROUND_MS = 5 * MIN;
/** Time kept for the judge after a verify, when a round is fitted inside the wall. */
export const JUDGE_RESERVE_MS = 3 * MIN;

/** What sets a round's size: the brief's complexity, its cap blocks, and how many screens and actions it lists. */
export interface RoundSize {
  complexity: "simple" | "standard" | "complex";
  caps: number;
  screens: number;
  actions: number;
}

export type RoundKind = "build" | "fix" | "verify";

/**
 * A round's time cap. With scaling off (ENGINE_ROUND_SCALING), today's caps: 60, 12 and 8 minutes. With it on:
 * - a first round (and each milestone round) gets 60 minutes; below that floor, 25 plus 5 when complex, plus 5 when the brief lists 6 or more
 *   screens and actions together, plus 5 per cap block, at most `maxMinutes`;
 * - a fix round 12 minutes, plus 3 when complex or the brief has caps, so 12 to 15;
 * - a verify run 8 minutes, plus 1 per cap block, so 8 to 10.
 */
export function roundCapMs(size: RoundSize, kind: RoundKind, opts: { scaling: boolean; maxMinutes: number }): number {
  const today = stepTimeoutMs(kind);
  if (!opts.scaling) return today;
  const caps = Math.max(0, Math.floor(size.caps));
  if (kind === "verify") return today + Math.min(2, caps) * MIN;
  if (kind === "fix") return today + (size.complexity === "complex" || caps > 0 ? 3 * MIN : 0);
  const big = size.screens + size.actions >= 6 ? 5 : 0;
  const minutes = 25 + (size.complexity === "complex" ? 5 : 0) + big + 5 * caps;
  return Math.max(today, Math.min(minutes, Math.max(25, opts.maxMinutes)) * MIN);
}

/**
 * What the workflow needs to run a build's rounds: each kind's cap, the wall (null when nothing scales, so a build runs
 * exactly as today) and the milestone titles (empty without milestones). Set once per build, in its brief step.
 */
export interface RoundPlan {
  buildMs: number;
  fixMs: number;
  verifyMs: number;
  wallMs: number | null;
  milestones: Array<{ title: string }>;
  /** FULL_BUILDS: rounds share the time left (fullRoundCap), and a round stopped at its cap still goes on to the checks. */
  full?: boolean;
  /** CHAINED_BUILDS: the chain's limits. wallMs is then one session's, measured from when that session began. */
  chain?: ChainLimits;
}

/** The longest one round of a full build may run. */
export const FULL_ROUND_MAX_MS = 60 * MIN;

/**
 * A full build's plan. Verify covers every requirement's test, so its cap grows with their number, and its smoke step's
 * own limit stays under it. Rounds get no fixed cap of their own: fullRoundCap shares out what is left.
 */
export function chainRoundPlan(size: { requirements: number }, milestones: Array<{ title: string }>, limits: ChainLimits): RoundPlan {
  const verifyMs = Math.min(45, Math.max(25, 12 + Math.ceil(size.requirements / 2))) * MIN;
  return {
    buildMs: Math.min(CHAIN_ROUND_MAX_MS, limits.sessionMs - verifyMs),
    fixMs: 15 * MIN,
    verifyMs,
    wallMs: limits.sessionMs,
    milestones,
    full: true,
    chain: limits,
  };
}

export function fullRoundPlan(size: { requirements: number }, milestones: Array<{ title: string }>, opts: { wallMinutes: number }): RoundPlan {
  return {
    buildMs: FULL_ROUND_MAX_MS,
    fixMs: 15 * MIN,
    verifyMs: Math.min(25, Math.max(12, 10 + size.requirements)) * MIN,
    wallMs: opts.wallMinutes * MIN,
    milestones,
    full: true,
  };
}

/**
 * What a full build keeps for the end: a verify and judge, and a fix round. Verify's cap is a limit, rarely reached, so
 * holding two of them back cut a six-milestone build's rounds to 5 to 8 minutes. A late fix round is skipped if time ran out.
 */
export function fullChecksReserveMs(plan: Pick<RoundPlan, "verifyMs" | "fixMs">): number {
  return plan.verifyMs + JUDGE_RESERVE_MS + plan.fixMs;
}

/**
 * One milestone's share of what's left of the wall after the reserve for the checks, split among the milestones not yet
 * built, so a round that finishes early passes its time on. Null when too little is left to start one.
 */
export function fullRoundCap(input: { plan: Pick<RoundPlan, "verifyMs" | "fixMs" | "wallMs">; startedAt: number; now: number; milestonesLeft: number }): number | null {
  const wall = input.plan.wallMs;
  if (wall === null) return FULL_ROUND_MAX_MS;
  const left = input.startedAt + wall - input.now - fullChecksReserveMs(input.plan);
  if (left < MIN_ROUND_MS) return null;
  return Math.min(FULL_ROUND_MAX_MS, Math.max(MIN_ROUND_MS, left / Math.max(1, input.milestonesLeft)));
}

export function roundPlanFor(
  size: RoundSize,
  milestones: Array<{ title: string }>,
  opts: { scaling: boolean; maxMinutes: number },
): RoundPlan {
  return {
    buildMs: roundCapMs(size, "build", opts),
    fixMs: roundCapMs(size, "fix", opts),
    verifyMs: roundCapMs(size, "verify", opts),
    wallMs: opts.scaling || milestones.length ? MAX_BUILD_WALL_MS : null,
    milestones,
  };
}

/**
 * A round's cap inside the wall: the cap, or what's left before the wall when that is less, or null when less than
 * MIN_ROUND_MS is left. `reserveMs` keeps time for what must run after it (a verify). No wall gives the cap as it is.
 */
export function capWithinWall(input: { capMs: number; startedAt: number; now: number; wallMs: number | null; reserveMs?: number }): number | null {
  if (input.wallMs === null) return input.capMs;
  const left = input.startedAt + input.wallMs - input.now - (input.reserveMs ?? 0);
  if (left < MIN_ROUND_MS) return null;
  return Math.min(input.capMs, left);
}
