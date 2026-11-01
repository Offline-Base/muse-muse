import {
  decideMessages,
  decideRenderings,
  decisionFromScores,
  stateText,
  taskProblem,
} from "@/lib/decide/format";
import type {
  DecideRendering,
  DecideServeItem,
  DecideTryPick,
  DecisionLabel,
  DecisionSpec,
  WilsonRate,
} from "@/lib/decide/types";
import { ADAPTER_RECIPE, DECIDE_MODE, jobMode } from "@/lib/train/logic";
import { isDecisionSummary } from "@/lib/train/models";
import type { EvalSummary } from "@/lib/train/types";

/**
 * Serving a decision model (docs/DECISION_MODELS.md "Serving and use"): what the Try it live box of a decision model
 * (POST /api/lab/{id}/decide) and {GATEWAY_URL}/decide share. A trained decide job as a model (its labels, question and
 * each side's T), one input's renderings and the items its demo server scores, and the scores back as picks. Pure, no
 * I/O.
 */

/** One side of a decision model: the T its scoring fit on dev rows, and whether it was fit (20 or more dev rows). */
export interface DecisionSide {
  T: number;
  calibrated: boolean;
}

/** A trained decision model as serving reads it. */
export interface DecisionModel {
  /** The decide job's id: the adapter a glimmer-serve job serves, and the gateway's model id. */
  id: string;
  title: string;
  question: string;
  /** In the order the person defined them. */
  labels: DecisionLabel[];
  base: DecisionSide;
  tuned: DecisionSide;
  /** True when the job has a public result page (hasResults in lib/train/store.ts), so anyone may try or call it. */
  public: boolean;
  /**
   * Wave 3, unit 11: the product this model was privately trained for ("Train on my data"). It has no public page, and only
   * that product's token may call it.
   */
  productId?: string;
  /** Rows its dataset trained on, for the wording ("trained on 168 of your examples"). */
  trainRows: number;
  /** Its scores on the held-out test rows, when it was scored: tuned's and base Glimmer's. */
  accuracy: { tuned: WilsonRate | null; base: WilsonRate } | null;
}

/** T when it is one a summary could hold (a positive finite number), else 1. */
function usableT(T: unknown): number {
  return typeof T === "number" && Number.isFinite(T) && T > 0 ? T : 1;
}

/**
 * A decide job as a decision model, or null when it can't be served as one: a Muse Glimmer LoRA job in decide mode that
 * succeeded and trained an adapter (not a dry run, not score only), on a decision dataset with at least 2 labels. Each
 * side's T and calibration come from its decision summary; before it is scored (or when scoring saved only a note) T
 * is 1 and nothing is calibrated.
 */
export function decisionModelOf(input: {
  job: { id: string; title: string; recipe: string; status: string; params: Record<string, unknown> | null; evalSummary: EvalSummary | null };
  spec: Pick<DecisionSpec, "question" | "labels" | "split"> | null;
  public: boolean;
}): DecisionModel | null {
  const { job, spec } = input;
  if (job.recipe !== ADAPTER_RECIPE || jobMode(job.params) !== DECIDE_MODE || job.status !== "succeeded") return null;
  if (Number(job.params?.dryRun) >= 1 || Number(job.params?.scoreOnly) >= 1) return null;
  if (!spec || typeof spec.question !== "string" || !Array.isArray(spec.labels) || spec.labels.length < 2) return null;
  const summary = isDecisionSummary(job.evalSummary) && job.evalSummary.items > 0 ? job.evalSummary : null;
  const side = (s: { T: number; calibrated: boolean } | null | undefined): DecisionSide =>
    s ? { T: usableT(s.T), calibrated: s.calibrated === true && usableT(s.T) === s.T } : { T: 1, calibrated: false };
  return {
    id: job.id,
    title: job.title,
    question: spec.question,
    labels: spec.labels.map((l) => ({ id: l.id, name: l.name, description: l.description ?? "" })),
    base: side(summary?.base),
    tuned: side(summary?.tuned),
    public: input.public,
    trainRows: spec.split?.train ?? 0,
    accuracy: summary ? { tuned: summary.tuned?.accuracy ?? null, base: summary.base.accuracy } : null,
  };
}

/**
 * One input's renderings, as eval scored the test rows: the labels in their defined order, one prompt per group, each
 * with `none` last (decideRenderings), or the error sentence when a task can't be shown (taskProblem: a state of 1 to
 * 3,000 characters, a question of 5 to 300, options of 1 to 60 characters, unique). A state given as a flat object is
 * its JSON text first.
 */
export function serveRenderings(input: {
  state: string | Record<string, unknown>;
  question: string;
  labels: readonly DecisionLabel[];
  none?: boolean;
}): { ok: true; renderings: DecideRendering[] } | { ok: false; error: string } {
  const state = stateText(input.state);
  let renderings: DecideRendering[];
  try {
    renderings = decideRenderings({ state, question: input.question, labels: input.labels, none: input.none ?? true });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  for (const r of renderings) {
    const problem = taskProblem(r.task);
    if (problem) return { ok: false, error: problem };
  }
  return { ok: true, renderings };
}

/** What a decision model's demo server scores for these renderings: each one's [system, user] messages and letters. */
export function serveItems(renderings: readonly DecideRendering[]): DecideServeItem[] {
  return renderings.map((r) => ({ messages: decideMessages(r.task), letters: [...r.letters] }));
}

/**
 * One model's pick from its scores of the renderings (decisionFromScores: renormalized, groups combined, the pick
 * made, then T), with whether T was fit and the mean letter mass. Throws when the scores can't be log-probabilities.
 */
export function servePick(
  labels: readonly DecisionLabel[],
  renderings: readonly DecideRendering[],
  logprobs: ReadonlyArray<readonly number[]>,
  side: DecisionSide,
): DecideTryPick {
  const { decision, mass } = decisionFromScores({ labels, renderings, logprobs, T: side.T });
  const meanMass = mass.length ? mass.reduce((s, m) => s + m, 0) / mass.length : 0;
  return { ...decision, calibrated: side.calibrated, mass: meanMass };
}
