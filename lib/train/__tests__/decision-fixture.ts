/**
 * A made-up decision dataset for the tests: support tickets sorted into 4 teams. Every input is written by these
 * rules, not by a model and not from anyone's data. Rows of a label share a phrase but carry three numbers of their
 * own, so no two rows are near-duplicates (under 70% shared words) unless a test makes them so.
 */
import type { DecisionRow } from "@/lib/decide/types";

export const TICKET_QUESTION = "Which team should handle this support ticket?";

export const TICKET_LABELS = [
  { name: "Billing", description: "Charges, refunds and invoices" },
  { name: "Shipping", description: "Delivery, tracking and damaged parcels" },
  { name: "Account", description: "Sign-in, passwords and profile" },
  { name: "Returns", description: "" },
];

const PHRASES: Record<string, string[]> = {
  Billing: ["I was charged twice this month", "my refund never arrived back", "the invoice total looks wrong to me", "please cancel this subscription charge", "why did my card get billed again"],
  Shipping: ["the parcel is still not here", "tracking says delivered but nothing came", "my box arrived crushed and wet", "which courier is bringing my order", "the delivery date keeps slipping later"],
  Account: ["I cannot sign in anymore", "please reset my password for me", "change the email on my profile", "the two factor code never comes", "my account got locked after lunch"],
  Returns: ["how do I send this back", "the jacket does not fit at all", "the return label is missing", "exchange it for a bigger size", "a wrong colour came so I am returning it"],
};

/** One made-up ticket: the label's phrase number i % 5, then three numbers no other row has. */
export function ticket(label: string, i: number): string {
  const at = TICKET_LABELS.findIndex((l) => l.name === label);
  const phrases = PHRASES[label]!;
  return `${phrases[i % phrases.length]} case ${1000 * (at + 1) + i} ref ${70000 + 1000 * at + i} on ${900000 + 1000 * at + i}`;
}

/** `counts[k]` rows of the k-th label, the labels interleaved as a person's export might be. Labels by name. */
export function ticketRows(counts: readonly number[] = [30, 30, 30, 30]): DecisionRow[] {
  const out: DecisionRow[] = [];
  const most = Math.max(...counts);
  for (let i = 0; i < most; i++) {
    TICKET_LABELS.forEach((l, k) => {
      if (i < counts[k]!) out.push({ input: ticket(l.name, i), label: l.name });
    });
  }
  return out;
}

/** A CSV field: quoted, with "" for a quote. */
export function csvField(text: string): string {
  return `"${text.replaceAll('"', '""')}"`;
}

/** The rows as CSV with the header input,label. */
export function ticketCsv(rows: readonly DecisionRow[]): string {
  return ["input,label", ...rows.map((r) => `${csvField(r.input)},${r.label}`)].join("\n");
}
