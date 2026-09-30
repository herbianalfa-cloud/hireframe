import type { Fact, FactContent, FactDraft } from './profile.js';

/**
 * Re-upload merge (PRD R2, ADR-018): new facts are added, changed facts are flagged for review,
 * nothing is ever overwritten or archived. Pure and deterministic so it is testable offline.
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

function key(content: Pick<FactContent, 'type' | 'text'>): string {
  return `${content.type}|${normaliseText(content.text)}`;
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
  for (const fact of existing) {
    // Prefer an active fact over an archived one with the same text.
    const current = byKey.get(key(fact.content));
    if (!current || (current.status === 'archived' && fact.status === 'active')) {
      byKey.set(key(fact.content), fact);
    }
  }

  // Pass 1: same type and text. Unchanged, archived (skipped), or only the dates changed.
  const seenDraftKeys = new Set<string>();
  const remaining: FactDraft[] = [];
  for (const draft of drafts) {
    const draftKey = key(draft);
    if (seenDraftKeys.has(draftKey)) {
      plan.duplicatesInCv++;
      continue;
    }
    seenDraftKeys.add(draftKey);
    const exact = byKey.get(draftKey);
    if (!exact) {
      remaining.push(draft);
      continue;
    }
    matched.add(exact.id);
    if (exact.status === 'archived') plan.skippedArchived++;
    else if (sameDates(exact.content.dates, draft.dates)) plan.unchanged++;
    else plan.flag.push({ id: exact.id, proposed: draft });
  }

  // Pass 2: similar text on an unmatched active fact of the same type is a change to review;
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
