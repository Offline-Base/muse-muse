/** Quote checks, in code. Spacing and typographic marks are forgiven; every word must still be there, in order. */
export const MIN_QUOTE_CHARS = 20;

export function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/­/g, "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** Null when the quote is in the text. Otherwise a reason to act on, which never gives away any of the source. */
export function quoteProblem(quote: string, sourceText: string): string | null {
  const wanted = normalizeText(quote);
  if (wanted.length < MIN_QUOTE_CHARS) return `That quote is too short to check. Quote at least ${MIN_QUOTE_CHARS} characters of the passage.`;
  if (!normalizeText(sourceText).includes(wanted)) return "That quote isn't in this source word for word. Read it again and copy the passage, or mark the item open.";
  return null;
}
