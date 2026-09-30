import { describe, expect, it } from 'vitest';

import { jaccard, mergeFacts, normaliseText, type ExistingFact } from './merge.js';
import type { FactDraft } from './profile.js';

const OPTIONS = { similar: 0.6 };

function draft(overrides: Partial<FactDraft> = {}): FactDraft {
  return {
    type: 'experience',
    text: 'Ran onboarding for new B2B clients at Example Ltd',
    evidence: 'Ran onboarding for new B2B clients',
    dates: { start: '2024-01', end: '2025-06' },
    tags: ['onboarding'],
    lanes: ['secondary'],
    ...overrides,
  };
}

function existing(
  id: string,
  overrides: Partial<ExistingFact> = {},
  content = draft(),
): ExistingFact {
  return { id, content, status: 'active', source: 'cv', ...overrides };
}

describe('normaliseText / jaccard', () => {
  it('ignores case, accents, punctuation and spacing', () => {
    expect(normaliseText('  Café — Ran   ONBOARDING!! ')).toBe('cafe ran onboarding');
  });

  it('scores token overlap', () => {
    expect(jaccard('a b c d', 'a b c d')).toBe(1);
    expect(jaccard('a b', 'c d')).toBe(0);
    expect(jaccard('a b c', 'a b d')).toBeCloseTo(0.5);
  });
});

describe('mergeFacts', () => {
  it('adds every draft when the profile is empty', () => {
    const plan = mergeFacts([], [draft(), draft({ type: 'skill', text: 'SQL' })], OPTIONS);
    expect(plan.add).toHaveLength(2);
    expect(plan).toMatchObject({ unchanged: 0, flag: [], missingFromCv: 0 });
  });

  it('counts an identical re-upload as unchanged: nothing added, nothing flagged', () => {
    const facts = [existing('f1'), existing('f2', {}, draft({ type: 'skill', text: 'SQL' }))];
    const plan = mergeFacts(facts, [draft(), draft({ type: 'skill', text: 'sql.' })], OPTIONS);
    expect(plan).toEqual({
      add: [],
      flag: [],
      unchanged: 2,
      skippedArchived: 0,
      duplicatesInCv: 0,
      missingFromCv: 0,
    });
  });

  it('flags a reworded fact for review and never overwrites it', () => {
    const facts = [existing('f1')];
    const reworded = draft({ text: 'Ran onboarding for 12 new B2B clients at Example Ltd' });
    const plan = mergeFacts(facts, [reworded], OPTIONS);
    expect(plan.flag).toEqual([{ id: 'f1', proposed: reworded }]);
    expect(plan.add).toEqual([]);
    expect(facts[0]?.content.text).toBe('Ran onboarding for new B2B clients at Example Ltd');
  });

  it('flags the same text with changed dates', () => {
    const plan = mergeFacts(
      [existing('f1')],
      [draft({ dates: { start: '2024-01', end: 'present' } })],
      OPTIONS,
    );
    expect(plan.flag.map((entry) => entry.id)).toEqual(['f1']);
  });

  it('adds a dissimilar fact and does not match across types', () => {
    const facts = [existing('f1')];
    const plan = mergeFacts(
      facts,
      [draft({ type: 'achievement', text: 'Ran onboarding for new B2B clients at Example Ltd' })],
      OPTIONS,
    );
    expect(plan.add).toHaveLength(1);
    expect(plan.missingFromCv).toBe(1);
  });

  it('skips a draft that matches an archived fact instead of reviving it', () => {
    const plan = mergeFacts([existing('f1', { status: 'archived' })], [draft()], OPTIONS);
    expect(plan).toMatchObject({ add: [], flag: [], skippedArchived: 1, missingFromCv: 0 });
  });

  it('prefers an active fact over an archived one with the same text', () => {
    const facts = [existing('old', { status: 'archived' }), existing('new')];
    expect(mergeFacts(facts, [draft()], OPTIONS)).toMatchObject({
      unchanged: 1,
      skippedArchived: 0,
    });
  });

  it('never flags an archived fact for a similar draft; it adds instead', () => {
    const plan = mergeFacts(
      [existing('f1', { status: 'archived' })],
      [draft({ text: 'Ran onboarding for 12 new B2B clients at Example Ltd' })],
      OPTIONS,
    );
    expect(plan.flag).toEqual([]);
    expect(plan.add).toHaveLength(1);
  });

  it('treats a manual fact with the same text as unchanged, so it is not duplicated', () => {
    const plan = mergeFacts([existing('m1', { source: 'manual' })], [draft()], OPTIONS);
    expect(plan).toMatchObject({ add: [], unchanged: 1 });
  });

  it('counts only active CV facts as missing from the new CV', () => {
    const facts = [
      existing('cv', {}, draft({ type: 'skill', text: 'Figma' })),
      existing('manual', { source: 'manual' }, draft({ type: 'skill', text: 'Unity' })),
      existing('archived', { status: 'archived' }, draft({ type: 'skill', text: 'Excel' })),
    ];
    expect(mergeFacts(facts, [], OPTIONS).missingFromCv).toBe(1);
  });

  it('collapses duplicate drafts within one CV', () => {
    const plan = mergeFacts(
      [],
      [draft(), draft({ text: 'ran onboarding for new B2B clients at Example Ltd.' })],
      OPTIONS,
    );
    expect(plan.add).toHaveLength(1);
    expect(plan.duplicatesInCv).toBe(1);
  });

  it('matches each existing fact at most once: exact matches win over similar ones', () => {
    const facts = [existing('f1')];
    const similar = draft({ text: 'Ran onboarding for 12 new B2B clients at Example Ltd' });
    const plan = mergeFacts(facts, [similar, draft()], OPTIONS);
    expect(plan.unchanged).toBe(1);
    expect(plan.flag).toEqual([]);
    expect(plan.add).toEqual([similar]);
  });
});
