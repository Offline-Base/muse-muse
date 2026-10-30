import type { Workspace } from "@/components/docs/playgrounds/muse-code-cookbook/logic/sandbox";
import { isDangerous, isReadOnlyStage, parseCommand, prefixSuggestion, startsWith, type ParsedCommand, type Stage } from "@/components/docs/playgrounds/muse-code-cookbook/logic/shell";

/**
 * The staged-approval contract (cookbook/staged-approvals) as a small engine: parse the compound command into
 * stages, resolve each one against policy, hold on the first stage that can't clear, take the reader's answer for
 * that stage, and run the original text once only after every stage is satisfied. A rejected stage denies the whole
 * action, so nothing runs. Rules follow the recipe's precedence: a deny beats a prompt, a prompt beats an allow,
 * whatever their specificity; within one effect the most specific (longest) prefix is the one cited.
 */

export type Mode = "on-request" | "untrusted";

/** quota_tool.py from the recipe's setup. */
export const QUOTA_TOOL_PY = `#!/usr/bin/env python3
"""Grofflaxon quota rollup for the Vantablast-7 partition."""

PARTITION_RATE_VANTABLAST7 = 0.0193  # credits per Grofflaxon quota-unit

def monthly_quota(units):
    return round(units * PARTITION_RATE_VANTABLAST7, 2)

if __name__ == "__main__":
    print(monthly_quota(500))
`;

/** The recipe's regulated workspace: quota_tool.py committed, then report.log written after the commit. */
export const STAGED_DEMO: Workspace = {
  root: "/tmp/perm_run",
  home: "/home/you",
  tempRoots: ["/tmp"],
  files: { "quota_tool.py": QUOTA_TOOL_PY, "report.log": "cached artifact\n" },
  committed: { "quota_tool.py": QUOTA_TOOL_PY },
  scripts: { "quota_tool.py": "9.65\n" },
};

export interface Rule {
  effect: "allow" | "deny" | "prompt";
  /** An argv prefix, such as ["cargo", "test"]. */
  prefix: string[];
  /** Where it came from: granted in a prompt, or set up for the demo. */
  origin: "granted" | "preset";
}

export type ResolutionKind = "known_safe" | "policy_allow" | "unresolved" | "denied";

export interface Resolution {
  kind: ResolutionKind;
  /** Why, in a few words a reader can check against the recipe. */
  why: string;
  rule?: Rule;
  /** Cleared by on-request's sandboxed fallback rather than proven safe. */
  sandboxed?: boolean;
  dangerous?: boolean;
}

export type Answer = "allow_once" | "allow_workspace" | "abort";

export interface StageState {
  stage: Stage;
  resolution: Resolution;
  /** The reader's answer, when this stage was held. */
  answer?: Answer;
}

export interface Review {
  command: string;
  mode: Mode;
  rules: Rule[];
  parsed: ParsedCommand;
  stages: StageState[];
  /** pending: waiting on the first held stage; ran: every stage cleared; denied: a stage was rejected. */
  status: "pending" | "ran" | "denied";
  /** Index of the stage waiting for an answer. */
  blocking: number | null;
  /** True once any stage has gone to review (so the log holds a `requested` record). */
  reviewed: boolean;
}

function matching(rules: readonly Rule[], argv: readonly string[], effect: Rule["effect"]): Rule | undefined {
  return rules
    .filter((r) => r.effect === effect && startsWith(argv, r.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
}

/** One stage against policy, in the order the recipe gives. */
export function resolveStage(stage: Stage, mode: Mode, rules: readonly Rule[], parseError: string | null): Resolution {
  const deny = matching(rules, stage.argv, "deny");
  if (deny) return { kind: "denied", why: `a deny rule covers ${deny.prefix.join(" ")}`, rule: deny };
  const prompt = matching(rules, stage.argv, "prompt");
  if (prompt) return { kind: "unresolved", why: `a rule forces review for ${prompt.prefix.join(" ")}`, rule: prompt };
  const allow = matching(rules, stage.argv, "allow");
  if (allow) return { kind: "policy_allow", why: `an allow rule you granted covers ${allow.prefix.join(" ")}`, rule: allow };
  const dangerous = isDangerous(stage.argv);
  if (mode === "untrusted") {
    return {
      kind: "unresolved",
      why: dangerous ? "on the dangerous list, and no rule covers it" : "untrusted mode: no rule you granted covers it",
      dangerous,
    };
  }
  if (dangerous) return { kind: "unresolved", why: "rm -f or rm -rf is on the dangerous list", dangerous };
  if (parseError) return { kind: "unresolved", why: "this simulator holds a command it can't parse (fail-closed)" };
  if (isReadOnlyStage(stage)) return { kind: "known_safe", why: "provably read-only" };
  if (!stage.argvComplete) {
    return { kind: "policy_allow", why: `incomplete (${stage.incompleteReasons.join(", ")}) but not dangerous: auto-allowed, sandbox-contained`, sandboxed: true };
  }
  return { kind: "policy_allow", why: "not on the dangerous list: cleared by on-request policy, runs in the sandbox", sandboxed: true };
}

function settle(review: Review): Review {
  // A deny overrides any prompt: a stage a deny rule covers denies the whole action before anything is asked.
  if (review.stages.some((s) => s.resolution.kind === "denied")) return { ...review, status: "denied", blocking: null };
  const blocking = review.stages.findIndex((s) => !s.answer && s.resolution.kind === "unresolved");
  if (blocking >= 0) return { ...review, status: "pending", blocking, reviewed: true };
  return { ...review, status: "ran", blocking: null };
}

/** Starts the review of one command: every stage resolved, holding at the first that can't clear. */
export function startReview(command: string, mode: Mode, rules: readonly Rule[]): Review {
  const parsed = parseCommand(command);
  const stages = parsed.stages.map((stage) => ({ stage, resolution: resolveStage(stage, mode, rules, parsed.error) }));
  const review: Review = { command, mode, rules: [...rules], parsed, stages, status: "pending", blocking: null, reviewed: false };
  if (!stages.length) return { ...review, status: "denied" };
  return settle(review);
}

/** The choices the prompt offers for a held shell stage. The workspace grant needs a permitted prefix. */
export function choicesFor(stage: Stage): { allowOnce: true; workspacePrefix: string[] | null; abort: true } {
  return { allowOnce: true, workspacePrefix: prefixSuggestion(stage), abort: true };
}

/**
 * The reader's answer for the held stage. Allow once clears just this stage; the workspace grant records an allow
 * rule for its prefix (later stages it covers clear too); reject denies the whole command.
 */
export function answer(review: Review, a: Answer): Review {
  if (review.status !== "pending" || review.blocking === null) return review;
  const at = review.blocking;
  if (a === "abort") {
    const stages = review.stages.map((s, i) => (i === at ? { ...s, answer: a } : s));
    return { ...review, stages, status: "denied", blocking: null };
  }
  let rules = review.rules;
  if (a === "allow_workspace") {
    const prefix = prefixSuggestion(review.stages[at].stage);
    if (!prefix) return review;
    rules = [...rules, { effect: "allow", prefix, origin: "granted" }];
  }
  const stages = review.stages.map((s, i) => {
    if (i === at) return { ...s, answer: a };
    if (i > at && !s.answer && a === "allow_workspace") return { ...s, resolution: resolveStage(s.stage, review.mode, rules, review.parsed.error) };
    return s;
  });
  return settle({ ...review, rules, stages });
}

/** approval-policy.json's workspace rules, as the grant would persist them. */
export function policyFile(workspaceRoot: string, rules: readonly Rule[]): string {
  const grants = rules.filter((r) => r.origin === "granted").map((r) => ({ effect: r.effect, argv_prefix: r.prefix, scope: { workspace_root: workspaceRoot } }));
  return JSON.stringify({ rules: grants }, null, 2);
}

/** The approval subject the log's `requested` record carries for a shell command. */
export function approvalSubject(review: Review): Record<string, unknown> {
  return {
    kind: "shell_command",
    raw_command: review.command,
    stages: review.stages.map((s) => ({
      source_position: s.stage.sourcePosition,
      argv: s.stage.argv,
      argv_complete: s.stage.argvComplete,
      resolution: { kind: s.resolution.kind },
    })),
  };
}

/**
 * The decision_applied record for one answered stage, as the recipe's second jq query prints it. The recipe shows
 * {"decision":"abort","policy_result":"deny"} for a rejection; for an allowed stage this uses "approved", the value
 * the audit-agent-sessions recipe's log shows for an allowed action (this recipe doesn't print one).
 */
export function decisionRecord(a: Answer): { decision: string; policy_result: string } {
  return a === "abort" ? { decision: "abort", policy_result: "deny" } : { decision: "approved", policy_result: "allow" };
}

/** What the recipe's two jq queries print for this review: the stages, and the decision for each answered stage. */
export function jqOutput(review: Review): { stages: string | null; decision: string | null } {
  if (!review.reviewed) return { stages: null, decision: null };
  const subject = approvalSubject(review) as { raw_command: string; stages: Array<Record<string, unknown>> };
  const stages = JSON.stringify({
    raw: subject.raw_command,
    stages: subject.stages.map((s) => ({ pos: s.source_position, argv: s.argv, complete: s.argv_complete, res: (s.resolution as { kind: string }).kind })),
  });
  const answered = review.stages.filter((s) => s.answer);
  if (!answered.length || review.status === "pending") return { stages, decision: null };
  return { stages, decision: answered.map((s) => JSON.stringify(decisionRecord(s.answer!))).join("\n") };
}

/**
 * The command-level side_effect_intent once the command runs: allow:approved when a person cleared a held stage,
 * allow:policy when every stage cleared on its own. None when the review aborted: the effect was never authorized.
 * It carries no stage detail: the recipe keeps stage-level provenance in the approval event (stageEvidence).
 */
export function intentFor(review: Review): Record<string, unknown> | null {
  if (review.status !== "ran") return null;
  const approved = review.stages.some((s) => s.answer === "allow_once" || s.answer === "allow_workspace");
  return { kind: "side_effect_intent", operation: "tool:bash", policy_decision: approved ? "allow:approved" : "allow:policy" };
}

/**
 * The approval event's stage_evidence once a reviewed command runs: every stage with its own resolution, auto-cleared
 * stages as they resolved and a held stage with the answer that cleared it. The recipe names the field and what it
 * holds but doesn't print it, so this shape is the demo's. Null when nothing went to review or the review aborted.
 */
export function stageEvidence(review: Review): Array<Record<string, unknown>> | null {
  if (review.status !== "ran" || !review.reviewed) return null;
  return review.stages.map((s) => ({
    source_position: s.stage.sourcePosition,
    argv: s.stage.argv,
    resolution: s.resolution.kind,
    ...(s.answer ? { decision: s.answer } : {}),
  }));
}

/** The tool result the model sees: the original text ran once, or the whole action was denied. */
export function toolOutcome(review: Review): string {
  if (review.status === "ran") return `Ran: ${review.command}`;
  if (review.status === "denied") {
    const denied = review.stages.find((s) => s.resolution.kind === "denied" && !s.answer);
    return denied ? `tool denied: policy (${denied.resolution.why})` : "tool denied: approval aborted";
  }
  return "Waiting for review";
}
