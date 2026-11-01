/**
 * CHAINED_BUILDS (docs/CHAINED_BUILDS.md): a big full build runs as many working sessions on one sandbox and one repo.
 * Pure, with no imports, so the workflow and its tests can read it. The steps that act on these answers are the chain
 * steps in lib/pipeline/build-steps.ts.
 */
const MIN = 60_000;

/** A brief with more requirements than a single full build's 6 milestones of 4 can hold gets a chain. */
export const CHAIN_FROM_REQUIREMENTS = 24;
/** Below this much of a session, a new round isn't started in it: the next session gets the whole of its time. */
export const CHAIN_MIN_ROUND_MS = 15 * MIN;
/** The longest one round runs inside a session, as for a full build. */
export const CHAIN_ROUND_MAX_MS = 60 * MIN;
/** Kept out of the milestones' share of the total, so the final checks can run on what was built. */
export const CHAIN_CHECKS_RESERVE_USD = 3;
/** The state file in the product's repo, which each session reads first. */
export const CHAIN_STATE_FILE = "CHAIN_STATE.md";

export interface ChainLimits {
  /** How long one session runs before the next takes over. */
  sessionMs: number;
  /** The most one session's token may spend. */
  sessionUsd: number;
  /** The most the whole chain may spend, everything counted on the build's own cost. */
  totalUsd: number;
  maxSessions: number;
  /** The most the whole chain may take. The sweep (lib/pipeline/sweep.ts) gives it this long too. */
  maxMs: number;
}

export interface ChainPosition {
  session: number;
  chainStartedAt: number;
  sessionStartedAt: number;
  /** The build's cost when this session began. */
  sessionStartUsd: number;
}

export type ChainEndReason = "budget" | "sessions" | "time";

export type ChainNext = { action: "round"; capMs: number } | { action: "rotate" } | { action: "end"; reason: ChainEndReason };

/**
 * What comes next before a milestone round, from the facts only: end the chain and check what was built, start a new
 * session, or run the round with this cap. The total comes first, so no limit is ever traded for more time.
 */
export function chainNext(input: { limits: ChainLimits; position: ChainPosition; costUsd: number; verifyMs: number; now: number }): ChainNext {
  const { limits, position, costUsd, verifyMs, now } = input;
  if (costUsd + CHAIN_CHECKS_RESERVE_USD >= limits.totalUsd) return { action: "end", reason: "budget" };
  if (now - position.chainStartedAt >= limits.maxMs) return { action: "end", reason: "time" };
  const left = position.sessionStartedAt + limits.sessionMs - now - verifyMs;
  const sessionSpent = costUsd - position.sessionStartUsd;
  if (left >= CHAIN_MIN_ROUND_MS && sessionSpent < limits.sessionUsd) return { action: "round", capMs: Math.min(CHAIN_ROUND_MAX_MS, left) };
  if (position.session >= limits.maxSessions) return { action: "end", reason: "sessions" };
  return { action: "rotate" };
}

/** The most the next session's token may spend: its own limit, and never past what the total has left. */
export function chainSessionBudgetUsd(limits: Pick<ChainLimits, "sessionUsd" | "totalUsd">, costUsd: number): number {
  return Math.max(0, Math.min(limits.sessionUsd, limits.totalUsd - costUsd));
}

/** True when the final checks need a fresh session: what's left of this one can't hold them, and another is allowed. */
export function chainChecksNeedSession(input: { limits: ChainLimits; position: ChainPosition; reserveMs: number; now: number }): boolean {
  const { limits, position, reserveMs, now } = input;
  if (position.session >= limits.maxSessions) return false;
  return position.sessionStartedAt + limits.sessionMs - now < reserveMs;
}

/** The build room's plain line for why a chain ended before its last milestone. */
export function chainEndLine(reason: ChainEndReason, limits: Pick<ChainLimits, "totalUsd" | "maxSessions" | "maxMs">, next: number, of: number): string {
  const why =
    reason === "budget"
      ? `it reached its $${limits.totalUsd} spending cap`
      : reason === "sessions"
        ? `it used all ${limits.maxSessions} of its sessions`
        : `it reached its ${Math.round(limits.maxMs / (60 * MIN))}-hour limit`;
  return `The chain stopped because ${why}, so milestone ${next} of ${of} and any after it were skipped. The checks run on what was built.`;
}

/** The repo's state file, written by the platform at the end of each session. */
export function chainStateFile(input: { session: number; milestones: Array<{ title: string; state: string }>; costUsd: number; totalUsd: number }): string {
  return [
    "# Chain state",
    "",
    "The platform writes this file between sessions. Don't edit it. Your own notes go in BUILD_NOTES.md.",
    "",
    `Session ${input.session} just ended, and $${input.costUsd.toFixed(2)} of the $${input.totalUsd} total is spent.`,
    "",
    "## Milestones",
    "",
    ...input.milestones.map((m, i) => `${i + 1}. ${m.title}: ${m.state}`),
    "",
  ].join("\n");
}

/** What the first prompt of a new session starts with: that session knows nothing but the repo. */
export function chainSessionPreface(session: number): string {
  return [
    `This is session ${session} of a long build, and you have no memory of the earlier sessions. Everything they made is in this repo and committed.`,
    "",
    `Before you change anything, read in this order: brief.md, ${CHAIN_STATE_FILE}, BUILD_NOTES.md, then \`git log --oneline -20\`. A milestone marked building or failed in ${CHAIN_STATE_FILE} comes first, before the one below.`,
    "",
  ].join("\n");
}

/** The build prompt's lines about the chain, after the milestones. */
export const CHAIN_BUILD_LINES = [
  "",
  "## Long build",
  "",
  `This build runs across several sessions in this repo. A later session starts with no memory of this one, so keep BUILD_NOTES.md current as you go: the plan, every decision, what is finished and what is next. "All in this session" above means all in this repo. The platform commits your work and writes ${CHAIN_STATE_FILE} when a session ends.`,
];
