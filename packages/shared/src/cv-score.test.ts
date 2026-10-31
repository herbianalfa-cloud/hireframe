import { describe, expect, it } from 'vitest';

import type { CvContent, TrimmedCvContent } from './cv.js';
import { CV_CRITERIA } from './cv.js';
import { CV_HARD_FINDING_CAP, CV_RUBRIC_VERSION, CV_WEIGHTS, scoreCv } from './cv-score.js';
import type { CvLayoutMetrics, CvScoreInput } from './cv-score.js';
import { aliasOf, at, CV_ALIASES, CV_FACTS, requirement, validCv } from './fixtures/cv.js';

const a = aliasOf;

/** A note of about `words` words in short sentences that names the company, citing a fact. */
function note(
  words: number,
  opener = 'I am applying to Northwind Analytics',
): CvContent['coverNote'] {
  const sentence = 'I wrote clear help text.';
  const count = Math.max(0, Math.round((words - opener.split(' ').length) / 5));
  return {
    paragraphs: [
      { text: `${opener}.`, factRefs: [a('fact-clients')] },
      { text: Array.from({ length: count }, () => sentence).join(' '), factRefs: [a('fact-ttl')] },
    ],
  };
}

/** `validCv` made to satisfy every criterion of the rubric. */
function goodCv(): CvContent {
  const cv = structuredClone(validCv());
  cv.skills = ['SQL', 'Python', 'SQL', 'Python', 'SQL', 'Python'].map((_, i) => ({
    label: i % 2 === 0 ? 'SQL' : 'Python',
    factRefs: [a(i % 2 === 0 ? 'fact-sql' : 'fact-python')],
  }));
  cv.coverNote = note(190);
  const entry = at(cv.experience, 0);
  entry.bullets = [
    { text: 'Led onboarding for 12 clients across the setup flow.', factRefs: [a('fact-clients')] },
    { text: 'Cut client time-to-live by 30% with clearer setup steps.', factRefs: [a('fact-ttl')] },
    {
      text: 'Wrote 25 help-centre articles for the self-serve setup flow.',
      factRefs: [a('fact-articles')],
    },
  ];
  at(cv.projects, 0).bullets = [
    {
      text: 'Analysed an e-commerce dataset with SQL to find late orders.',
      factRefs: [a('fact-olist')],
    },
  ];
  return cv;
}

const LAYOUT: CvLayoutMetrics = { fill: 0.97, bulletLines: [2, 2, 2, 2], headingWraps: 0 };

const REQUIREMENTS = [
  requirement('Client onboarding', { factIds: ['fact-clients'] }),
  requirement('SQL', { factIds: ['fact-sql'], level: 'nice' }),
];

function input(overrides: Partial<CvScoreInput> = {}): CvScoreInput {
  return {
    content: goodCv(),
    facts: CV_FACTS,
    aliases: CV_ALIASES,
    requirements: REQUIREMENTS,
    company: 'Northwind Analytics Ltd',
    layout: LAYOUT,
    ...overrides,
  };
}

const score = (overrides: Partial<CvScoreInput> = {}) => scoreCv(input(overrides));

describe('scoreCv', () => {
  it('gives a good CV at least 8.5 and passes the gate', () => {
    const result = score();
    expect(result.rubric).toBe(CV_RUBRIC_VERSION);
    expect(result.findings).toEqual([]);
    expect(result.total).toBeGreaterThanOrEqual(8.5);
    expect(result.gatePassed).toBe(true);
  });

  it('weights add up to 10 and a perfect CV is close to it', () => {
    expect(CV_CRITERIA.reduce((sum, name) => sum + CV_WEIGHTS[name], 0)).toBe(10);
    expect(score().total).toBeGreaterThanOrEqual(9.5);
  });

  it('is deterministic and holds no text in its findings', () => {
    const cv = goodCv();
    at(cv.experience, 0).bullets[0] = {
      text: 'Led it successfully!',
      factRefs: [a('fact-clients')],
    };
    const first = score({ content: cv });
    expect(score({ content: cv })).toEqual(first);
    expect(JSON.stringify(first.findings)).not.toContain('successfully');
  });
});

describe('criterion 1: page fill', () => {
  const fill = (value: number, headingWraps = 0) =>
    score({ layout: { ...LAYOUT, fill: value, headingWraps } }).criteria.fill;

  it('is full at an empty band of 3% or less and zero at 25% or more', () => {
    expect(fill(1)).toBe(2);
    expect(fill(0.97)).toBe(2);
    expect(fill(0.75)).toBe(0);
    expect(fill(0.3)).toBe(0);
  });

  it('is linear between', () => {
    expect(fill(0.86)).toBeCloseTo(1, 1); // band 14%: halfway
    expect(fill(0.9)).toBeGreaterThan(fill(0.8));
  });

  it('costs 0.25 for each heading wrap, as a soft finding', () => {
    expect(fill(1, 2)).toBe(1.5);
    const result = score({ layout: { ...LAYOUT, headingWraps: 2 } });
    expect(result.findings.map((finding) => finding.code)).toEqual([
      'heading_wraps',
      'heading_wraps',
    ]);
    // Charged once, in fill: the writing criterion does not charge it again.
    expect(result.criteria.writing).toBe(2.5);
    expect(result.gatePassed).toBe(true);
  });

  it('a 25% empty band alone brings a perfect CV to 8.0 or less', () => {
    expect(score({ layout: { ...LAYOUT, fill: 0.75 } }).total).toBeLessThanOrEqual(8);
  });
});

describe('criterion 2: writing rules', () => {
  function withBullet(text: string): CvContent {
    const cv = goodCv();
    at(cv.experience, 0).bullets[1] = { text, factRefs: [a('fact-ttl')] };
    return cv;
  }

  it('costs 0.25 for a soft finding', () => {
    const result = score({ content: withBullet('Cut client time-to-live by 30% significantly.') });
    expect(result.criteria.writing).toBe(2.25);
    expect(result.gatePassed).toBe(true);
  });

  it('costs 1.0 for a hard finding and caps the total at 7.5', () => {
    const result = score({
      content: withBullet('Cut time-to-live by 30%, not just fast but proven.'),
    });
    expect(result.findings.some((finding) => finding.severity === 'hard')).toBe(true);
    expect(result.criteria.writing).toBe(1.5);
    expect(result.total).toBeLessThanOrEqual(CV_HARD_FINDING_CAP);
    expect(result.gatePassed).toBe(false);
  });

  it('caps a CV that would otherwise score above 7.5', () => {
    const clean = score();
    const hard = score({ content: withBullet('Cut time-to-live by 30%, proven track record.') });
    expect(clean.total).toBeGreaterThan(CV_HARD_FINDING_CAP);
    expect(hard.total).toBe(CV_HARD_FINDING_CAP);
  });

  it('floors at zero', () => {
    const cv = goodCv();
    at(cv.experience, 0).bullets = Array.from({ length: 4 }, () => ({
      text: 'Passionate team player with a proven track record.',
      factRefs: [a('fact-ttl')],
    }));
    expect(score({ content: cv }).criteria.writing).toBe(0);
  });
});

describe('criterion 3: real numbers', () => {
  it('is full when no cited fact has a figure', () => {
    const cv = goodCv();
    cv.experience = [
      {
        ...at(cv.experience, 0),
        bullets: [
          {
            text: 'Analysed an e-commerce dataset with SQL to find late orders.',
            factRefs: [a('fact-olist')],
          },
        ],
      },
    ];
    expect(score({ content: cv }).criteria.numbers).toBe(1);
  });

  it('is the share of figure-backed bullets that use a figure', () => {
    const cv = goodCv();
    at(cv.experience, 0).bullets[1] = {
      text: 'Shortened client time-to-live with clearer setup steps.',
      factRefs: [a('fact-ttl')],
    };
    // Three bullets cite a fact with a figure; two of them use it.
    expect(score({ content: cv }).criteria.numbers).toBeCloseTo(0.67, 2);
  });
});

describe('criterion 4: tailoring', () => {
  it('is full at 80% weighted coverage and scales below it', () => {
    const reqs = [
      requirement('A', { factIds: ['fact-clients'] }), // must, cited
      requirement('B', { factIds: ['fact-python'] }), // must, cited
      requirement('C', { factIds: ['fact-scrum'] }), // must, cited
      requirement('D', { factIds: ['fact-intern'] }), // must, cited
      requirement('E', { factIds: ['fact-old'] }), // archived: not coverable
    ];
    expect(score({ requirements: reqs }).criteria.tailoring).toBe(1);

    const missed = [
      requirement('A', { factIds: ['fact-clients'] }),
      requirement('B', { factIds: ['fact-articles'] }),
      requirement('C', { factIds: ['fact-python'], level: 'nice' }),
    ];
    const cv = goodCv();
    cv.skills = cv.skills.filter((skill) => skill.label !== 'Python');
    cv.skills.push(
      ...Array.from({ length: 4 }, () => ({ label: 'SQL', factRefs: [a('fact-sql')] })),
    );
    cv.experience = [
      { ...at(cv.experience, 0), bullets: at(cv.experience, 0).bullets.slice(0, 2) },
    ];
    // A is cited, B (articles) is no longer cited, C is not: 2 of 5 weighted points.
    const result = score({ content: { ...cv, summary: null }, requirements: missed });
    expect(result.criteria.tailoring).toBeCloseTo((1 * (2 / 5)) / 0.8, 1);
  });

  it('leaves out logistics and requirements the profile cannot cover', () => {
    const reqs = [
      requirement('Right to work', { type: 'logistics', factIds: ['fact-clients'] }),
      requirement('Rust', { factIds: [] }),
    ];
    expect(score({ requirements: reqs }).criteria.tailoring).toBe(1);
    expect(score({ requirements: [] }).criteria.tailoring).toBe(1);
  });

  it('counts must as 2 and nice as 1', () => {
    const reqs = [
      requirement('A', { factIds: ['fact-clients'] }),
      requirement('B', { factIds: ['fact-articles'], level: 'nice' }),
      requirement('C', { factIds: ['fact-sql'], level: 'nice' }),
      requirement('D', { factIds: ['fact-python'], level: 'nice' }),
    ];
    const cv = goodCv();
    cv.skills = cv.skills.filter((skill) => skill.label === 'SQL');
    cv.experience = [{ ...at(cv.experience, 0), bullets: [at(at(cv.experience, 0).bullets, 0)] }];
    // Covered: A (2) and C (1) of 5 points; the CV cites no articles or Python.
    const result = score({ content: { ...cv, summary: null }, requirements: reqs });
    expect(result.criteria.tailoring).toBeCloseTo((1 * (3 / 5)) / 0.8, 1);
  });
});

describe('criterion 5: bullet craft', () => {
  const craft = (cv: CvContent, bulletLines?: number[]) =>
    score({ content: cv, layout: { ...LAYOUT, ...(bulletLines ? { bulletLines } : {}) } }).criteria
      .craft;

  it('is full for verb-first bullets of 8 to 28 words on at most 2 lines', () => {
    expect(craft(goodCv())).toBe(1.5);
  });

  it('loses a third when bullets do not open with a verb', () => {
    const cv = goodCv();
    cv.experience = [
      {
        ...at(cv.experience, 0),
        bullets: at(cv.experience, 0).bullets.map((bullet) => ({
          ...bullet,
          text: `Responsible for ${bullet.text.toLowerCase()}`,
        })),
      },
    ];
    const result = craft(cv);
    expect(result).toBeLessThan(1.5);
    expect(result).toBeGreaterThan(0.5);
  });

  it('loses a third when bullets are too short or run over two lines', () => {
    expect(craft(goodCv(), [3, 2, 2, 2])).toBeCloseTo(1.5 - 0.5 / 4, 2);
    const short = goodCv();
    at(short.experience, 0).bullets[0] = { text: 'Led onboarding.', factRefs: [a('fact-clients')] };
    expect(craft(short)).toBeCloseTo(1.5 - 0.5 / 4, 2);
  });

  it('costs 0.25 for each opening verb used more than twice', () => {
    const cv = goodCv();
    at(cv.experience, 0).bullets = Array.from({ length: 4 }, () => ({
      text: 'Wrote 25 help-centre articles for the self-serve setup flow.',
      factRefs: [a('fact-articles')],
    }));
    expect(craft(cv, [2, 2, 2, 2, 2])).toBeCloseTo(1.5 - 0.25, 2);
  });
});

describe('criterion 6: structure and note', () => {
  const structure = (cv: CvContent | TrimmedCvContent, company = 'Northwind Analytics Ltd') =>
    score({ content: cv, company }).criteria.structure;

  it('is full for a good CV and a note that names the company', () => {
    expect(structure(goodCv())).toBe(1);
  });

  it('loses 0.25 for a summary over two sentences, or none', () => {
    const long = goodCv();
    long.summary = { text: 'One. Two. Three.', factRefs: [a('fact-ttl')] };
    expect(structure(long)).toBe(0.75);
    expect(structure({ ...goodCv(), summary: null })).toBe(0.75);
  });

  it('loses 0.25 when the newest entry has one bullet or any entry has none', () => {
    const thin = goodCv();
    at(thin.experience, 0).bullets = [at(at(thin.experience, 0).bullets, 0)];
    expect(structure(thin)).toBe(0.75);
    const empty = goodCv();
    at(empty.projects, 0).bullets = [];
    expect(structure(empty)).toBe(0.75);
  });

  it('loses 0.25 outside 6 to 14 skills', () => {
    const few = goodCv();
    few.skills = few.skills.slice(0, 5);
    expect(structure(few)).toBe(0.75);
    const many = goodCv();
    many.skills = Array.from({ length: 15 }, () => at(many.skills, 0));
    expect(structure(many)).toBe(0.75);
  });

  it('loses 0.25 for a note outside 150 to 250 words, without the company, or with a cliche opener', () => {
    const short = goodCv();
    short.coverNote = note(120);
    expect(structure(short)).toBe(0.75);
    const long = goodCv();
    long.coverNote = note(260);
    expect(structure(long)).toBe(0.75);
    expect(structure(goodCv(), 'Contoso')).toBe(0.75);
    expect(structure(goodCv(), '')).toBe(0.75);
    const cliche = goodCv();
    cliche.coverNote = note(190, 'Passionate about Northwind Analytics and a proven track record');
    expect(structure(cliche)).toBe(0.75);
  });

  it('matches the company by whole words, ignoring a legal suffix', () => {
    const cv = goodCv();
    cv.coverNote = note(190, 'I am applying to Northwind');
    expect(structure(cv, 'Northwind Ltd')).toBe(1);
    expect(structure(cv, 'North')).toBe(0.75);
  });
});

describe('criterion 7: the cover note (rubric v2)', () => {
  const noteScore = (cv: CvContent) => score({ content: cv }).criteria.note;
  /** A note of distinct sentences, so no trigram is shared with the bullets. */
  const specific = (opener: string, words: number): CvContent['coverNote'] => {
    const extra = Array.from(
      { length: Math.round(words / 6) },
      (_, i) => `Item${String(i)} gave quarterly review number${String(i)} sharper focus.`,
    ).join(' ');
    return {
      paragraphs: [
        { text: `${opener} Northwind Analytics.`, factRefs: [a('fact-clients')] },
        { text: extra, factRefs: [a('fact-ttl')] },
      ],
    };
  };

  it('is full for a 180 to 250 word note with its own opener and its own words', () => {
    const cv = goodCv();
    cv.coverNote = specific('Your team at', 200);
    expect(noteScore(cv)).toBe(1);
  });

  it('loses 0.5 for a stock opener, 0.25 for the length, 0.25 for repeating the bullets', () => {
    const stock = goodCv();
    stock.coverNote = specific('I am applying to', 200);
    expect(noteScore(stock)).toBe(0.5);
    const short = goodCv();
    short.coverNote = specific('Your team at', 60);
    expect(noteScore(short)).toBe(0.75);
    const copied = goodCv();
    const bullets = at(copied.experience, 0)
      .bullets.map((b) => b.text)
      .join(' ');
    copied.coverNote = {
      paragraphs: [
        { text: 'Your team at Northwind Analytics.', factRefs: [a('fact-clients')] },
        {
          text: `${bullets} ${bullets} ${bullets} ${bullets} ${bullets}`,
          factRefs: [a('fact-ttl')],
        },
      ],
    };
    expect(noteScore(copied)).toBeLessThanOrEqual(0.75);
  });

  it('scores a templated note that repeats the bullets 0.75 below a specific one', () => {
    const generic = goodCv();
    const bullets = at(generic.experience, 0)
      .bullets.map((b) => b.text)
      .join(' ');
    const body = Array.from({ length: 10 }, () => bullets)
      .join(' ')
      .split(' ')
      .slice(0, 195)
      .join(' ');
    generic.coverNote = {
      paragraphs: [
        { text: 'I am applying to Northwind Analytics.', factRefs: [a('fact-clients')] },
        { text: `${body}.`, factRefs: [a('fact-ttl')] },
      ],
    };
    const specificCv = goodCv();
    specificCv.coverNote = specific('Your team at', 200);
    expect(noteScore(specificCv) - noteScore(generic)).toBeCloseTo(0.75, 2);
  });
});
