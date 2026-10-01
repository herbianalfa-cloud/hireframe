import type { Fact, FactContent, FactDraft } from './profile.js';

/**
 * Re-upload merge (PRD R2, ADR-018, ADR-022): new facts are added, changed facts are flagged for
 * review, nothing is ever overwritten or archived. Pure and deterministic so it is testable
 * offline. Three passes, each matching an existing fact at most once:
 * 1. same type and text;
 * 2. same type and evidence quote (the model rewords facts between reads; the CV line stays);
 * 3. similar text on an active fact of the same type.
 */

export interface ExistingFact {
  id: string;
  content: FactContent;
  status: Fact['status'];
  source: Fact['source'];
}

export interface MergeOptions {
  /** Token-Jaccard similarity at or above which a draft counts as a change of an existing fact. */
  similar: number;
}

export interface MergePlan {
  add: FactDraft[];
  flag: { id: string; proposed: FactDraft }[];
  unchanged: number;
  skippedArchived: number;
  duplicatesInCv: number;
  missingFromCv: number;
}

/** Lower-case, strip accents and punctuation, collapse whitespace. For matching only. */
export function normaliseText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9%£$€]+/g, ' ')
    .trim();
}

function tokens(text: string): Set<string> {
  return new Set(normaliseText(text).split(' ').filter(Boolean));
}

export function jaccard(a: string, b: string): number {
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 && right.size === 0) return 1;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return shared / (left.size + right.size - shared);
}

function sameDates(a: FactContent['dates'], b: FactContent['dates']): boolean {
  return a.start === b.start && a.end === b.end;
}

/** Identity used for exact matching: type plus normalised text. */
export function factKey(content: Pick<FactContent, 'type' | 'text'>): string {
  return `${content.type}|${normaliseText(content.text)}`;
}

/**
 * Identity of the CV line a fact quotes: type plus the quote with case, accents, punctuation and
 * all spacing removed, so the PDF and DOCX extractions of one line agree (ligatures, curly
 * quotes, bullets, doubled spaces, words hyphenated across a line break). Empty if the quote
 * has no letters or digits.
 */
export function evidenceKey(content: Pick<FactContent, 'type' | 'evidence'>): string {
  const quote = normaliseText(content.evidence).replace(/ /g, '');
  return quote ? `${content.type}|${quote}` : '';
}

/**
 * The fact behind the same quote as `draft`, if exactly one fits. One bullet split into several
 * claims shares a quote, so with several candidates the closest wording wins; a tie between
 * different facts, or no shared word at all, is ambiguous and left to the similarity pass.
 * Copies of one fact (same text) count once, and the active copy is preferred.
 */
function matchByEvidence(
  draft: FactDraft,
  candidates: readonly ExistingFact[],
): ExistingFact | undefined {
  if (candidates.length === 0) return undefined;
  const pick = (facts: readonly ExistingFact[]) =>
    facts.find((fact) => fact.status === 'active') ?? facts[0];
  if (new Set(candidates.map((fact) => factKey(fact.content))).size === 1) return pick(candidates);

  const scored = candidates.map((fact) => ({
    fact,
    score: jaccard(fact.content.text, draft.text),
  }));
  const top = Math.max(...scored.map((entry) => entry.score));
  if (top === 0) return undefined;
  const best = scored.filter((entry) => entry.score === top).map((entry) => entry.fact);
  return new Set(best.map((fact) => factKey(fact.content))).size === 1 ? pick(best) : undefined;
}

export function mergeFacts(
  existing: readonly ExistingFact[],
  drafts: readonly FactDraft[],
  options: MergeOptions,
): MergePlan {
  const plan: MergePlan = {
    add: [],
    flag: [],
    unchanged: 0,
    skippedArchived: 0,
    duplicatesInCv: 0,
    missingFromCv: 0,
  };
  const matched = new Set<string>();
  const byKey = new Map<string, ExistingFact>();
  const byEvidence = new Map<string, ExistingFact[]>();
  for (const fact of existing) {
    const quote = evidenceKey(fact.content);
    if (quote) byEvidence.set(quote, [...(byEvidence.get(quote) ?? []), fact]);
    // Prefer an active fact over an archived one with the same text.
    const current = byKey.get(factKey(fact.content));
    if (!current || (current.status === 'archived' && fact.status === 'active')) {
      byKey.set(factKey(fact.content), fact);
    }
  }

  // Unchanged, archived (skipped), or only the dates changed.
  function settle(fact: ExistingFact, draft: FactDraft): void {
    matched.add(fact.id);
    if (fact.status === 'archived') plan.skippedArchived++;
    else if (sameDates(fact.content.dates, draft.dates)) plan.unchanged++;
    else plan.flag.push({ id: fact.id, proposed: draft });
  }

  // Pass 1: same type and text.
  const seenDraftKeys = new Set<string>();
  const afterText: FactDraft[] = [];
  for (const draft of drafts) {
    const draftKey = factKey(draft);
    if (seenDraftKeys.has(draftKey)) {
      plan.duplicatesInCv++;
      continue;
    }
    seenDraftKeys.add(draftKey);
    const exact = byKey.get(draftKey);
    if (exact && !matched.has(exact.id)) settle(exact, draft);
    else afterText.push(draft);
  }

  // Pass 2: same type and evidence quote. An archived fact is skipped, never re-added reworded.
  const remaining: FactDraft[] = [];
  for (const draft of afterText) {
    const quote = evidenceKey(draft);
    const candidates = (quote ? (byEvidence.get(quote) ?? []) : []).filter(
      (fact) => !matched.has(fact.id),
    );
    const fact = matchByEvidence(draft, candidates);
    if (fact) settle(fact, draft);
    else remaining.push(draft);
  }

  // Pass 3: similar text on an unmatched active fact of the same type is a change to review;
  // anything else is new. Each existing fact matches at most one draft.
  for (const draft of remaining) {
    let best: { fact: ExistingFact; score: number } | undefined;
    for (const fact of existing) {
      if (matched.has(fact.id) || fact.status !== 'active' || fact.content.type !== draft.type) {
        continue;
      }
      const score = jaccard(fact.content.text, draft.text);
      if (score >= options.similar && (!best || score > best.score)) best = { fact, score };
    }
    if (best) {
      matched.add(best.fact.id);
      plan.flag.push({ id: best.fact.id, proposed: draft });
    } else {
      plan.add.push(draft);
    }
  }

  plan.missingFromCv = existing.filter(
    (fact) => fact.source === 'cv' && fact.status === 'active' && !matched.has(fact.id),
  ).length;
  return plan;
}
