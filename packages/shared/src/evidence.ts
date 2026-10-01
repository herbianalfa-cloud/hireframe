/**
 * Evidence check (ADR-018): a fact's `evidence` must be a verbatim quote of the CV text, after
 * normalising whitespace, quotes, dashes and bullets. Facts that fail are kept but marked
 * `evidenceVerified: false`, so the owner can see which claims lack a source.
 */
function normalise(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/[•▪●◦⁃∙]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function verifyEvidence(evidence: string, sourceText: string): boolean {
  const quote = normalise(evidence);
  return quote.length > 0 && normalise(sourceText).includes(quote);
}
