/**
 * A made-up decide job for the page tests and the local browser check (scripts/dev/decide-fixtures.ts): the ticket
 * dataset of lib/train/__tests__/decision-fixture.ts (inputs written by rules, nobody's data), checked and split as the
 * datasets route does it, and scores as a GPU's ctx.decide would send them, made by rule too. Nothing here ran a model.
 */
import { decisionItems } from "@/lib/decide/format";
import type { DecideScoreItem, DecisionRows, DecisionScoringInput, DecisionSpec, DecisionSummary } from "@/lib/decide/types";
import { checkDecisionUpload, decisionScoringInput } from "@/lib/train/decision-datasets";
import { summarizeDecisions } from "@/lib/train/logic";
import { TICKET_LABELS, TICKET_QUESTION, ticketRows } from "@/lib/train/__tests__/decision-fixture";

export interface TicketDecision {
  title: string;
  spec: DecisionSpec;
  rows: DecisionRows;
  sent: { dev: DecideScoreItem[]; test: DecideScoreItem[] };
  input: DecisionScoringInput;
  summary: DecisionSummary;
}

/** Log-probabilities of a rendering's letters: `p` of `mass` on the wanted letter, the rest of it split evenly. */
function logprobs(labelIds: ReadonlyArray<string | null>, want: string | null, p: number, mass: number): number[] {
  return labelIds.map((id) => Math.log(id === want ? mass * p : (mass * (1 - p)) / (labelIds.length - 1)));
}

/**
 * The ticket upload with `counts` rows a label, and made-up scores: base Glimmer right on rows not divisible by 3, at
 * 40% to 89% sure with 80% of its first token on the letters; the tuned model right on rows not divisible by 7, at 55%
 * to 99% sure with 98% on the letters; both say `none` on every decline rendering. `tuned: false` sends base only, as
 * a scoreOnly job does.
 */
export function ticketDecision(counts: number[] = [60, 60, 60, 60], opts: { tuned?: boolean } = {}): TicketDecision {
  const upload = checkDecisionUpload(
    { title: "Ticket router", question: TICKET_QUESTION, labels: TICKET_LABELS, rows: ticketRows(counts) },
    "page-fixture-seed",
  );
  if (!upload.ok) throw new Error(upload.error);
  const { spec, rows, title } = upload;
  const tuned = opts.tuned !== false;
  const sent = { dev: [] as DecideScoreItem[], test: [] as DecideScoreItem[] };
  for (const part of ["dev", "test"] as const) {
    for (const item of decisionItems({ question: spec.question, labels: spec.labels, rows: rows[part], part })) {
      const right = item.decline ? null : rows[part][item.row]!.label;
      const wrong = item.labelIds.find((id) => id !== right && id !== null) ?? null;
      const baseRight = item.decline || item.row % 3 !== 0;
      const tunedRight = item.decline || item.row % 7 !== 0;
      sent[part].push({
        index: item.index,
        base: logprobs(item.labelIds, baseRight ? right : wrong, 0.4 + ((item.row * 53) % 50) / 100, 0.8),
        tuned: tuned ? logprobs(item.labelIds, tunedRight ? right : wrong, 0.55 + ((item.row * 37) % 45) / 100, 0.98) : null,
        baseMass: 0.8,
        tunedMass: tuned ? 0.98 : null,
      });
    }
  }
  const input = decisionScoringInput(spec, rows, sent, 2);
  return { title, spec, rows, sent, input, summary: summarizeDecisions(input) };
}
