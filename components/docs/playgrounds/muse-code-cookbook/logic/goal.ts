/**
 * Goal tracking (cookbook/goal-tracking) as a gate: a goal is an objective plus acceptance checks, a step probe nudges
 * the agent back every ~10 model calls without progress, and the completion audit lets update_goal close the goal
 * only when every deliverable is proven. Here a judge model grades each check against the agent's report, and this
 * module decides whether update_goal(status: "complete") goes through: every check must pass with evidence quoted
 * from the report. The judge's own overall verdict is shown but never trusted on its own.
 */

export interface GoalCheck {
  id: string;
  text: string;
}

export type CheckStatus = "pass" | "fail" | "unproven";

export interface JudgedCheck {
  id: string;
  status: CheckStatus;
  evidence: string;
}

export interface Judgement {
  checks: JudgedCheck[];
  verdict: "complete" | "incomplete";
  next_step: string;
}

export const PROBE_EVERY = 10;
export const GOAL_REMINDER = "Continue working toward the active session goal";

/** How many step-probe reminders a run of model calls without progress queues. */
export function remindersAfter(callsWithoutProgress: number): number {
  return Math.floor(Math.max(0, callsWithoutProgress) / PROBE_EVERY);
}

/** The status-line indicator: Goal(...) with the objective shortened. */
export function goalIndicator(objective: string, max = 48): string {
  const text = objective.replace(/\s+/g, " ").trim();
  if (text.length <= max) return `Goal(${text})`;
  const cut = text.slice(0, max - 3);
  const space = cut.lastIndexOf(" ");
  return `Goal(${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}...)`;
}

export interface GateResult {
  allowed: boolean;
  passed: string[];
  failing: string[];
  unproven: string[];
  /** The update_goal call the agent tried, and the harness's answer. */
  call: { name: "update_goal"; arguments: { status: "complete" } };
  reply: string;
}

function words(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9_.]+/g) ?? [];
}

/**
 * True when the judge's evidence comes from the report: a quote of it (case and spacing aside), or a close
 * paraphrase where at least four in five of its words are the report's own. Empty evidence never counts.
 */
export function evidenceInReport(evidence: string, report: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const quote = norm(evidence).replace(/^["'.\s]+|["'.\s]+$/g, "");
  if (!quote) return false;
  const body = norm(report);
  if (body.includes(quote)) return true;
  const have = new Set(words(body));
  const used = words(quote).filter((w) => w.length > 2);
  return used.length >= 3 && used.filter((w) => have.has(w)).length / used.length >= 0.8;
}

/** Checks a pass without evidence, or that the judge skipped, count as unproven. Evidence must come from the report. */
export function gateCompletion(checks: readonly GoalCheck[], judged: readonly JudgedCheck[], report: string): GateResult {
  const body = report;
  const passed: string[] = [];
  const failing: string[] = [];
  const unproven: string[] = [];
  for (const check of checks) {
    const j = judged.find((x) => x.id === check.id);
    if (!j || j.status === "unproven") unproven.push(check.id);
    else if (j.status === "fail") failing.push(check.id);
    else if (!evidenceInReport(j.evidence, body)) unproven.push(check.id);
    else passed.push(check.id);
  }
  const allowed = passed.length === checks.length && checks.length > 0;
  const reply = allowed
    ? "update_goal accepted: every acceptance check is proven. The goal is closed."
    : `update_goal refused by the completion audit: ${[
        failing.length ? `${failing.length} failing (${failing.join(", ")})` : "",
        unproven.length ? `${unproven.length} without evidence in the report (${unproven.join(", ")})` : "",
      ]
        .filter(Boolean)
        .join("; ")}. Check requirement by requirement, then try again.`;
  return { allowed, passed, failing, unproven, call: { name: "update_goal", arguments: { status: "complete" } }, reply };
}

export interface GoalPreset {
  label: string;
  objective: string;
  checks: GoalCheck[];
  reports: Array<{ label: string; text: string }>;
}

/** The recipe's Perigord migration. Its six real checks live in test_falcon_acceptance.py; these come from the recipe's description of the work. */
export const GOAL_PRESETS: readonly GoalPreset[] = [
  {
    label: "Perigord gateway",
    objective:
      "Migrate the Perigord API gateway from the legacy Kestrel token scheme to the Falcon request-signing scheme in SPEC.md. Done ONLY when all six checks in test_falcon_acceptance.py pass.",
    checks: [
      { id: "falcon-signature", text: "auth.py checks a Falcon HMAC-SHA256 signature over the request path for the registered client peregrine" },
      { id: "gateway-wired", text: "gateway.py authenticates every request with the Falcon check" },
      { id: "kestrel-token-removed", text: "The Kestrel X-Kestrel-Token header no longer authenticates anyone" },
      { id: "kestrel-secret-removed", text: "The Kestrel shared secret is removed from the code" },
      { id: "acceptance-green", text: "python3 -m pytest -q test_falcon_acceptance.py reports all six checks passing" },
    ],
    reports: [
      {
        label: "Tests still red",
        text: "Implemented the Falcon HMAC-SHA256 path signature in auth.py for client peregrine and switched gateway.py to it. Removed the X-Kestrel-Token check.\n$ python3 -m pytest -q test_falcon_acceptance.py\n4 passed, 2 failed\nFAILED test_falcon_acceptance.py::test_kestrel_secret_removed\nFAILED test_falcon_acceptance.py::test_rejects_unregistered_client\nMarking the goal complete.",
      },
      {
        label: "All six pass",
        text: "auth.py now verifies a Falcon HMAC-SHA256 signature over the request path for the registered client peregrine. gateway.py calls verify_falcon() on every request. Deleted the X-Kestrel-Token check and the KESTREL_SHARED_SECRET constant.\n$ grep -rn Kestrel *.py\n(no output)\n$ python3 -m pytest -q test_falcon_acceptance.py\n6 passed in 0.14s",
      },
      { label: "Claims done, no proof", text: "The migration is finished and everything works now. Closing the goal." },
    ],
  },
  {
    label: "Snorkel Ledger transfer",
    objective: "Add transfer(src, dst, glimbers) to SnorkelLedger with overdraft protection. Done ONLY when pytest -q passes, including the new transfer tests.",
    checks: [
      { id: "transfer-exists", text: "SnorkelLedger.transfer(src, dst, glimbers) moves Glimbers between accounts" },
      { id: "overdraft-blocked", text: "A transfer larger than the source balance raises ValueError and changes nothing" },
      { id: "negative-blocked", text: "A negative or zero amount is rejected, so it can't bypass overdraft protection" },
      { id: "tests-green", text: "pytest -q passes with tests for transfer" },
    ],
    reports: [
      {
        label: "Negative amounts slip through",
        text: "Added transfer(src, dst, glimbers): raises ValueError when src balance < glimbers, otherwise moves the Glimbers.\n$ pytest -q\n3 passed\nDone.",
      },
      {
        label: "All checks covered",
        text: "Added transfer(src, dst, glimbers). It raises ValueError when glimbers <= 0 and when the src balance is lower than glimbers, leaving both balances unchanged; otherwise it moves the Glimbers.\nNew tests: test_transfer_moves_glimbers, test_overdraft_raises_and_changes_nothing, test_non_positive_amount_rejected.\n$ pytest -q\n6 passed in 0.03s",
      },
    ],
  },
];
