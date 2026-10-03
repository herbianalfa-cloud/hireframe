import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { applyLabels, normaliseVerdict, parseCsv, readGolden, toCsv } from './eval-labels.ts';

const cases = readGolden(readFileSync('evals/golden.jsonl', 'utf8'));

describe('eval-labels', () => {
  it('exports every case without the design intent, and parses back exactly', () => {
    const csv = toCsv(cases);
    expect(csv).not.toContain('designedAs');
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(cases.length + 1);
    const descriptionAt = rows[0]?.indexOf('description') ?? -1;
    expect(rows[1]?.[descriptionAt]).toBe(cases[0]?.posting.description);
  });

  it('imports labels and notes, accepting "near miss" and any case', () => {
    const csv = toCsv(cases)
      .replace(/^(g01,.*?),,$/m, '$1,Apply,')
      .replace(/^(g11,.*?),,$/m, '$1,near miss,"too many tools"');
    const result = applyLabels(cases, csv);
    expect(result.errors).toEqual([]);
    expect(result.cases.find((c) => c.id === 'g01')?.label).toBe('apply');
    expect(result.cases.find((c) => c.id === 'g11')).toMatchObject({
      label: 'near_miss',
      note: 'too many tools',
    });
    expect(result.labelled).toBe(2);
    expect(result.unlabelled).toHaveLength(cases.length - 2);
  });

  it('lists labels that differ from the design, and writes nothing on errors', () => {
    const header = 'id,verdict,note\n';
    expect(applyLabels(cases, `${header}g01,skip,\n`).differFromDesign).toEqual([
      { id: 'g01', designedAs: 'apply', label: 'skip' },
    ]);
    expect(applyLabels(cases, `${header}g01,maybe,\n`).errors[0]).toMatch(/isn't apply/);
    expect(applyLabels(cases, `${header}g99,skip,\n`).errors[0]).toMatch(/Unknown case/);
  });

  it.each([
    ['apply', 'apply'],
    ['Near-miss', 'near_miss'],
    ['  WILDCARD ', 'wildcard'],
    ['', null],
    ['yes', 'invalid'],
  ])('reads "%s" as %s', (raw, verdict) => {
    expect(normaliseVerdict(raw)).toBe(verdict);
  });
});
