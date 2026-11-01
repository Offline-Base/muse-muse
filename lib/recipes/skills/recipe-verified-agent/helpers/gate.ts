/** The gate, in code only. It returns reasons to refuse, and an empty list means this answer may reach the person. */
export interface Evidence { source: string; quote: string; receipt: string }
export interface Claim { item: string; text: string; evidence: Evidence[] }
export interface OpenItem { item: string; why: string }
export interface Draft { claims: Claim[]; open: OpenItem[] }
export type VerifiedAnswer =
  | (Draft & { status: "answered"; review_receipt: string })
  | { status: "needs_person"; item: string; request: string; tried: Array<{ source: string; receipt: string }>; claims: Claim[] };

export interface GateChecks {
  isRead(receipt: string, source: string): boolean;
  isEvidence(receipt: string, source: string, quote: string, item: string): boolean;
  isReview(receipt: string, draft: string): boolean;
}

export interface Gate {
  receipts: GateChecks;
  normalize(text: string): string;
  /** Items this answer must prove or mark open. Empty when the product has no fixed list. */
  requiredItems: readonly string[];
  /** Every source this run may read. */
  visibleSources: readonly string[];
}

/** What a review receipt covers. Changing a word of a claim, a quote or an open item breaks it. Spacing doesn't. */
export function canonicalDraft(draft: Draft, normalize: (text: string) => string): string {
  return JSON.stringify([
    draft.claims.map((c) => [c.item, normalize(c.text), c.evidence.map((e) => [e.source, normalize(e.quote)])]),
    draft.open.map((o) => [o.item, normalize(o.why)]),
  ]);
}

function claimProblems(claims: readonly Claim[], g: Gate): string[] {
  const out: string[] = [];
  claims.forEach((claim, i) => {
    if (!claim.evidence.length) out.push(`Claim ${i + 1} cites nothing. Record a quote for it, or mark "${claim.item}" open.`);
    for (const e of claim.evidence) {
      if (!g.visibleSources.includes(e.source)) out.push(`Claim ${i + 1} cites "${e.source}", which isn't a source here.`);
      else if (!g.receipts.isEvidence(e.receipt, e.source, e.quote, claim.item)) out.push(`Claim ${i + 1}: the receipt for "${e.source}" doesn't match this quote and item. Record that quote for "${claim.item}" and use the receipt it returns.`);
    }
  });
  return out;
}

/** Everything but the review itself. review_draft runs this first, so a refusal there doesn't use up the kit's one submit retry. */
export function draftProblems(draft: Draft, g: Gate): string[] {
  const out = claimProblems(draft.claims, g);
  if (!draft.claims.length && !draft.open.length) out.push("This answer says nothing. Add a claim or an open item.");
  const proven = new Set(draft.claims.map((c) => c.item));
  const open = new Set(draft.open.map((o) => o.item));
  for (const item of open) if (proven.has(item)) out.push(`"${item}" is both claimed and open. Pick one.`);
  for (const item of g.requiredItems) if (!proven.has(item) && !open.has(item)) out.push(`"${item}" is neither proven nor marked open.`);
  if (g.requiredItems.length) for (const item of new Set([...proven, ...open])) if (!g.requiredItems.includes(item)) out.push(`"${item}" isn't on the item list.`);
  return out;
}

export function answerProblems(answer: VerifiedAnswer, g: Gate): string[] {
  if (answer.status === "answered") {
    const out = draftProblems(answer, g);
    if (!g.receipts.isReview(answer.review_receipt, canonicalDraft(answer, g.normalize))) out.push("This exact answer hasn't passed review. Call review_draft with it, then submit it unchanged with the receipt.");
    return out;
  }
  const out = claimProblems(answer.claims, g);
  if (g.requiredItems.length && !g.requiredItems.includes(answer.item)) out.push(`"${answer.item}" isn't on the item list.`);
  if (answer.claims.some((c) => c.item === answer.item)) out.push(`"${answer.item}" is already backed by a quote. Don't ask a person for it.`);
  const read = new Set(answer.tried.filter((t) => g.receipts.isRead(t.receipt, t.source)).map((t) => t.source));
  const unread = g.visibleSources.filter((s) => !read.has(s));
  if (unread.length) out.push(`Read every source before asking a person. Not read yet: ${unread.join(", ")}.`);
  return out;
}
