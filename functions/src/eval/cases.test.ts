import { readFileSync } from 'node:fs';

import { applyHardRules } from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

import { caseJob, EVAL_NOW, EVAL_WORK_RIGHTS, parseGolden } from './cases.js';
import { EVAL_CRITERIA } from './evaluate.js';

const cases = parseGolden(readFileSync('evals/golden.jsonl', 'utf8'));

const s1 = (id: string) => {
  const entry = cases.find((c) => c.id === id);
  if (!entry) throw new Error(id);
  const result = applyHardRules({
    job: caseJob(entry),
    text: entry.posting.description,
    criteria: EVAL_CRITERIA,
    workRights: EVAL_WORK_RIGHTS.workRights,
    now: EVAL_NOW,
  });
  return result.pass ? null : result.ruleId;
};

describe('the golden set (ADR-036)', () => {
  it('has 40 cases: 10 apply, 10 near miss, 5 wildcard, 15 skip, with unique IDs', () => {
    expect(cases).toHaveLength(40);
    expect(new Set(cases.map((c) => c.id)).size).toBe(40);
    const count = (v: string) => cases.filter((c) => c.designedAs === v).length;
    expect([count('apply'), count('near_miss'), count('wildcard'), count('skip')]).toEqual([
      10, 10, 5, 15,
    ]);
    expect(cases.filter((c) => c.tags.includes('injection')).length).toBeGreaterThanOrEqual(4);
  });

  it.each([
    ['g26', 'title:business-analyst'],
    ['g27', 'title:senior'],
    ['g28', 'experience'],
    ['g29', 'blocker:sc-clearance'],
    ['g30', 'blocker:right-to-work'],
    ['g31', 'location'],
    ['g32', 'freshness'],
    ['g34', 'title:data-analyst'],
    ['g35', 'title:growth'],
  ])('S1 skips %s with %s', (id, rule) => {
    expect(s1(id)).toBe(rule);
  });

  it('sends every other case to the model, injection cases included', () => {
    const s1Skips = new Set(['g26', 'g27', 'g28', 'g29', 'g30', 'g31', 'g32', 'g34', 'g35']);
    for (const entry of cases.filter((c) => !s1Skips.has(c.id))) {
      expect([entry.id, s1(entry.id)]).toEqual([entry.id, null]);
    }
  });

  it('contains no emails, phone numbers or real URLs', () => {
    const text = readFileSync('evals/golden.jsonl', 'utf8');
    expect(text).not.toMatch(/@[a-z0-9-]+\.[a-z]/i);
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/\b0\d{3,4}[ -]?\d{3}[ -]?\d{3,4}\b/);
  });
});
