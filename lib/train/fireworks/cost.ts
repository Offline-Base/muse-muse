/** What answering the kept-aside prompts cost: its tokens at the quoted rate, or the whole ceiling when no tokens were reported. Pure. */
export function evalAnswersUsd(tokens: number, ratePerMTokens: number, ceilingUsd: number): number {
  if (!(tokens > 0) || !(ratePerMTokens > 0)) return ceilingUsd;
  return Math.round((tokens * ratePerMTokens) / 1e6 * 1e6) / 1e6;
}
