/**
 * Signed receipts: proof that code checked something, carried by the model but not forgeable by it, with no stored state,
 * so they survive Keep going. Pass in the server's HMAC and normalizeText, since these helpers import nothing.
 */
export type Hmac = (text: string) => string;

function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function makeReceipts(hmac: Hmac, normalize: (text: string) => string) {
  const read = (source: string) => hmac(JSON.stringify(["read", source]));
  const evidence = (source: string, quote: string, item: string) => hmac(JSON.stringify(["evidence", source, normalize(quote), item]));
  const review = (draft: string) => hmac(JSON.stringify(["review", draft]));
  return {
    read,
    evidence,
    review,
    isRead: (receipt: string, source: string) => same(receipt, read(source)),
    isEvidence: (receipt: string, source: string, quote: string, item: string) => same(receipt, evidence(source, quote, item)),
    isReview: (receipt: string, draft: string) => same(receipt, review(draft)),
  };
}

export type Receipts = ReturnType<typeof makeReceipts>;
