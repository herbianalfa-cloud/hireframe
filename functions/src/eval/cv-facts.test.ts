import type { CvContent } from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

import { CV_BULLET_BUDGET } from '../applications/prompt.js';
import { fitPage } from '../cv/render/fit.js';
import { FAKE_HEADER, fakeDateOf } from '../cv/render/fixtures.js';
import { BODY_SIZES, SPREAD_CAPS } from '../cv/render/layout.js';
import { EVAL_FACTS } from './cases.js';
import { CV_EVAL_FACTS } from './cv-facts.js';

const BULLET_TYPES = new Set(['experience', 'achievement', 'metric', 'project']);
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

describe('CV_EVAL_FACTS', () => {
  it('keeps the funnel eval facts as they were: short, 63 of them', () => {
    expect(EVAL_FACTS).toHaveLength(63);
    expect(EVAL_FACTS[2]?.text).toBe('Led onboarding for 12 clients');
    expect(mean(EVAL_FACTS.map((f) => f.text.length))).toBeLessThan(55);
  });

  it('has the same IDs, types, dates and lanes, so the frozen requirements still resolve', () => {
    const withoutText = (facts: typeof EVAL_FACTS) => facts.map((fact) => ({ ...fact, text: '' }));
    expect(withoutText(CV_EVAL_FACTS)).toEqual(withoutText(EVAL_FACTS));
  });

  it('writes bullet facts at the length of a real master CV, 90 to 170 characters', () => {
    const bullets = CV_EVAL_FACTS.filter((f) => BULLET_TYPES.has(f.type));
    expect(mean(bullets.map((f) => f.text.length))).toBeGreaterThan(90);
    const long = CV_EVAL_FACTS.filter(
      (f) => f.text !== EVAL_FACTS.find((e) => e.id === f.id)?.text,
    );
    expect(long.length).toBeGreaterThanOrEqual(25);
    for (const fact of long) {
      expect(fact.text.length, fact.id).toBeGreaterThanOrEqual(80);
      expect(fact.text.length, fact.id).toBeLessThanOrEqual(170);
    }
  });

  it('is fake data: no contact details, no dashes, nothing that reads as a domain', () => {
    const text = CV_EVAL_FACTS.map((f) => f.text).join('\n');
    expect(text).not.toMatch(/@|https?:|www\.|[–—]/);
    expect(text).not.toMatch(/\+\d{2}\s?\d{3,}/);
  });

  it('keeps the figures of the facts it lengthens', () => {
    const figures = (text: string) => text.match(/\d[\d,.]*k?%?/g) ?? [];
    for (const fact of CV_EVAL_FACTS) {
      const before = EVAL_FACTS.find((e) => e.id === fact.id)?.text ?? '';
      for (const figure of figures(before)) expect(fact.text, fact.id).toContain(figure);
    }
  });
});

describe('a realistic fake CV fills the page', () => {
  const text = (id: string) => CV_EVAL_FACTS.find((f) => f.id === `fact-${id}`)?.text ?? '';
  const bullets = (...ids: string[]) => ids.map((id) => ({ text: text(id), factRefs: ['F1'] }));
  const heading = (role: string, org: string) => ({ role, org, factRef: 'F1' });

  /** Bullets are the facts' own sentences, as the model writes them from a master CV. */
  const realistic = (count: number): CvContent => {
    const all = [
      ['03', '04', '05', '09', '10'],
      ['14', '16', '17', '22'],
      ['24', '26'],
      ['28', '29'],
      ['33'],
    ];
    const cut = all.map((ids) => [...ids]);
    let n = all.flat().length;
    while (n > count) {
      const longest = cut.reduce((x, y) => (y.length > x.length ? y : x));
      longest.pop();
      n -= 1;
    }
    const [intern = [], analyst = [], retail = [], olist = [], unity = []] = cut;
    return {
      summary: {
        text: 'Recent Business Information Systems graduate with an onboarding internship, who builds dashboards in SQL and Python.',
        factRefs: ['F1'],
      },
      experience: [
        {
          heading: heading('Customer Onboarding Intern', 'Example Cloud Ltd'),
          bullets: bullets(...intern),
        },
        {
          heading: heading('Student Product Analyst', 'Campus Apps Society'),
          bullets: bullets(...analyst),
        },
        { heading: heading('Retail Assistant', 'Example Books'), bullets: bullets(...retail) },
      ],
      projects: [
        { heading: heading('Olist e-commerce analysis', ''), bullets: bullets(...olist) },
        { heading: heading('Unity puzzle game', ''), bullets: bullets(...unity) },
      ],
      education: [
        {
          line: 'BSc Business Information Systems, Example University, First Class Honours',
          factRef: 'F1',
        },
        { line: 'Google Data Analytics Certificate', factRef: 'F1' },
        { line: 'Scrum Fundamentals Certificate', factRef: 'F1' },
      ],
      skills: [
        'SQL',
        'Python',
        'Excel',
        'Metabase',
        'Jira',
        'Figma',
        'Miro',
        'User interviews',
        'A/B test analysis',
        'Process mapping',
      ].map((label) => ({ label, factRefs: ['F1'] })),
      coverNote: {
        paragraphs: [
          { text: 'A note.', factRefs: ['F1'] },
          { text: 'A second paragraph.', factRefs: ['F1'] },
        ],
      },
    };
  };

  it.each([
    ['the most bullets', 14],
    ['the fewest the prompt asks for', CV_BULLET_BUDGET.bullets.min],
  ])(
    'fills at least 90%% of the page at %s, on one page and with no cuts',
    async (_name, count) => {
      const fit = await fitPage(FAKE_HEADER, realistic(count), fakeDateOf);
      if (!fit.ok) throw new Error('over a page');
      expect(fit.trimmed).toBe(0);
      expect(fit.fill).toBeGreaterThanOrEqual(0.9);
      expect(fit.spec.bodySize).toBeLessThanOrEqual(11);
    },
  );

  it('did it with a size ladder that stops at 11 pt and the same spread caps', () => {
    expect(Math.max(...BODY_SIZES)).toBe(11);
    expect(SPREAD_CAPS).toEqual({ gap: 1.6, leading: 1.06 });
  });
});
