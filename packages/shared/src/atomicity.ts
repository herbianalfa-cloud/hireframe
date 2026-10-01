/**
 * Soft atomicity check for model-drafted facts (one claim per fact). Counts drafts that look
 * like they bundle several claims: two or more numbers, or clauses joined by "and"/";" in a
 * long text. The count is logged for review only; it never rejects a fact.
 */
const NUMBER = /\d+(?:[.,]\d+)?%?/g;
const JOINER = /\b(?:and|as well as)\b|;/i;
const LONG_TEXT = 80;

export function looksCompound(text: string): boolean {
  const numbers = text.match(NUMBER)?.length ?? 0;
  return numbers >= 2 || (text.length > LONG_TEXT && JOINER.test(text));
}

export function countCompound(texts: readonly string[]): number {
  return texts.filter(looksCompound).length;
}
