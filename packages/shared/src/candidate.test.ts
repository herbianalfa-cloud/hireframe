import { describe, expect, it } from 'vitest';

import { candidateSummary, factsBlock, SUMMARY_MAX_CHARS, type FunnelFact } from './candidate.js';
import { workRightsLine } from './profile.js';
import { factAliases } from './score.js';

const fact = (id: string, type: FunnelFact['type'], text: string, start?: string): FunnelFact => ({
  id,
  type,
  text,
  dates: start ? { start } : {},
  lanes: [],
});

const FACTS: FunnelFact[] = [
  fact('b2', 'skill', 'SQL'),
  fact('a1', 'skill', 'Python'),
  fact('c3', 'experience', 'Customer onboarding intern', '2024-06'),
  fact('d4', 'experience', 'Student product analyst', '2023-10'),
  fact('e5', 'education', 'BSc Business Information Systems'),
  fact('f6', 'metric', 'Cut time-to-live by 30%'),
  fact('g7', 'constraint', 'Based in London'),
];

describe('candidateSummary', () => {
  it('groups facts by type in a stable order and ends with work rights', () => {
    expect(candidateSummary(FACTS, { workRights: 'time_limited', validUntil: '2028-06-30' })).toBe(
      [
        'Education: BSc Business Information Systems.',
        'Experience: Customer onboarding intern; Student product analyst.',
        'Highlights: Cut time-to-live by 30%.',
        'Skills: Python, SQL.',
        'Constraints: Based in London.',
        'Work rights: time-limited UK work permission, no sponsorship needed now, valid until 2028-06-30.',
      ].join('\n'),
    );
  });

  it('is the same for the same facts in any order', () => {
    const shuffled = [...FACTS].reverse();
    expect(candidateSummary(shuffled, null)).toBe(candidateSummary(FACTS, null));
  });

  it('stays within its length limit', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      fact(
        `x${String(i).padStart(3, '0')}`,
        'experience',
        `Experience item number ${String(i)} with detail`,
      ),
    );
    const summary = candidateSummary(many, null);
    expect(summary.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(summary.endsWith('Work rights: not stated.')).toBe(true);
  });
});

describe('factsBlock', () => {
  it('lists every fact once with its alias, in alias order', () => {
    const { toAlias } = factAliases(FACTS.map((f) => f.id));
    const block = factsBlock(FACTS, toAlias);
    expect(block.split('\n')[0]).toBe('[F1] skill: Python');
    expect(block.split('\n')).toHaveLength(FACTS.length);
    expect(factsBlock([...FACTS].reverse(), toAlias)).toBe(block);
  });
});

describe('workRightsLine', () => {
  it.each([
    [null, 'Work rights: not stated.'],
    [{ workRights: 'unrestricted' as const }, 'Work rights: no restrictions on working in the UK.'],
    [
      { workRights: 'time_limited' as const },
      'Work rights: time-limited UK work permission, no sponsorship needed now.',
    ],
    [
      { workRights: 'needs_sponsorship' as const, validUntil: '2027-01-31' },
      'Work rights: needs visa sponsorship to work in the UK.',
    ],
  ])('%j', (setting, line) => {
    expect(workRightsLine(setting)).toBe(line);
  });
});
