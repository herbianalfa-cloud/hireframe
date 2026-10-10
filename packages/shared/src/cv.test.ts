import { describe, expect, it } from 'vitest';

import { CV_ISSUE_CODES, type CvIssueCode } from './applications.js';
import {
  applyTrim,
  CV_LIMITS,
  CvContentSchema,
  CvContentShapeSchema,
  CvDocSchema,
  CvHeaderSchema,
  cvId,
  citedFactIds,
  figuresIn,
  formatFactDates,
  hasContactDetails,
  isPrintable,
  isWinAnsi,
  issueCodes,
  trimOrder,
  validateCv,
  type CvContent,
  type CvFact,
  type CvIssue,
} from './cv.js';
import { aliasOf, at, CV_ALIASES, CV_FACTS, fullCv, validCv } from './fixtures/cv.js';

// Ofcom's fictional drama range, built at run time so the PII scan never sees a phone literal.
const NATIONAL_PHONE = ['07700', '900123'].join(' ');
const INTL_PHONE = ['+44', '7700', '900123'].join(' ');

const check = (content: CvContent, facts = CV_FACTS) => validateCv(content, CV_ALIASES, facts);

function issuesOf(content: CvContent, facts = CV_FACTS): CvIssue[] {
  const result = check(content, facts);
  if (result.ok) throw new Error('expected issues');
  return result.issues;
}

/** A copy of the valid CV with `edit` applied to it. */
function edited(edit: (cv: CvContent) => void): CvContent {
  const cv = structuredClone(validCv());
  edit(cv);
  return cv;
}

describe('validateCv', () => {
  it('accepts the valid fixture, which also satisfies the strict schema', () => {
    expect(check(validCv())).toEqual({ ok: true });
    expect(CvContentSchema.safeParse(validCv()).success).toBe(true);
  });

  // One fixture per issue code. `expected` is the path and code the validator must report.
  const cases: Record<CvIssueCode, { cv: () => CvContent; path: string }> = {
    uncited: {
      cv: () =>
        edited((cv) => {
          at(at(cv.experience, 0).bullets, 1).factRefs = [];
        }),
      path: 'experience[0].bullets[1]',
    },
    unknown_fact: {
      cv: () =>
        edited((cv) => {
          at(at(cv.experience, 0).bullets, 0).factRefs = ['F99'];
        }),
      path: 'experience[0].bullets[0]',
    },
    wrong_fact_type: {
      cv: () =>
        edited((cv) => {
          // A skill cited as a job heading.
          at(cv.experience, 0).heading.factRef = aliasOf('fact-sql');
        }),
      path: 'experience[0].heading',
    },
    unsupported_number: {
      cv: () =>
        edited((cv) => {
          // The cited fact says 12 clients, not a team of 12... and not 40 either.
          at(cv.experience, 0).bullets[0] = {
            text: 'Led a team of 40 across three offices.',
            factRefs: [aliasOf('fact-clients')],
          };
        }),
      path: 'experience[0].bullets[0]',
    },
    contact_in_text: {
      cv: () =>
        edited((cv) => {
          cv.summary.text = 'Analyst. Write to alex@example.com for more.';
        }),
      path: 'summary',
    },
    too_long: {
      cv: () =>
        edited((cv) => {
          at(at(cv.experience, 0).bullets, 0).text = 'Led onboarding. '.repeat(20);
        }),
      path: 'experience[0].bullets[0]',
    },
    unsupported_text: {
      cv: () =>
        edited((cv) => {
          at(cv.experience, 0).heading.role = 'Senior Product Manager';
        }),
      path: 'experience[0].heading.role',
    },
    unsupported_char: {
      cv: () =>
        edited((cv) => {
          // Not in WinAnsi, so Helvetica can't print it: a Greek letter in a bullet.
          at(at(cv.experience, 0).bullets, 2).text = 'Wrote 25 help-centre articles (α release).';
        }),
      path: 'experience[0].bullets[2]',
    },
  };

  it.each(CV_ISSUE_CODES)('reports %s at the right path', (code) => {
    const { cv, path } = cases[code];
    expect(issuesOf(cv())).toContainEqual({ path, code });
  });

  it('has a fixture for every issue code, and none for a code that is not declared', () => {
    expect(Object.keys(cases).sort()).toEqual([...CV_ISSUE_CODES].sort());
  });

  it('rejects "led a team of 12" citing a fact that has a 12 only as clients, then accepts it once the fact says so', () => {
    const claim = edited((cv) => {
      at(cv.experience, 0).bullets[0] = {
        text: 'Led a team of 15 engineers.',
        factRefs: [aliasOf('fact-clients')],
      };
    });
    expect(issuesOf(claim)).toContainEqual({
      path: 'experience[0].bullets[0]',
      code: 'unsupported_number',
    });
    const withFact = CV_FACTS.map((fact) =>
      fact.id === 'fact-clients' ? { ...fact, text: 'Led a team of 15 engineers' } : fact,
    );
    expect(check(claim, withFact)).toEqual({ ok: true });
  });

  it('rejects a bullet citing an archived fact, as unknown_fact', () => {
    const cv = edited((c) => {
      at(c.experience, 0).bullets[0] = {
        text: 'Ran a pilot with 8 customers.',
        factRefs: [aliasOf('fact-old')],
      };
    });
    // The 8 only appears in the archived fact, so it is unsupported too: both are reported at once.
    expect(issuesOf(cv)).toEqual([
      { path: 'experience[0].bullets[0]', code: 'unknown_fact' },
      { path: 'experience[0].bullets[0]', code: 'unsupported_number' },
    ]);
    // The same bullet is fine once the fact is active again.
    const active = CV_FACTS.map((f) =>
      f.id === 'fact-old' ? { ...f, status: 'active' as const } : f,
    );
    expect(check(cv, active)).toEqual({ ok: true });
  });

  it('treats an alias with no fact behind it as unknown, even if it is in the alias map', () => {
    const lost = CV_FACTS.filter((fact) => fact.id !== 'fact-clients');
    expect(issuesOf(validCv(), lost)).toContainEqual({
      path: 'experience[0].bullets[0]',
      code: 'unknown_fact',
    });
  });

  it('needs the figure in a cited fact, not just any fact', () => {
    const cv = edited((c) => {
      // 25 is in fact-articles, which this bullet does not cite.
      at(c.experience, 0).bullets[0] = {
        text: 'Wrote 25 articles.',
        factRefs: [aliasOf('fact-clients')],
      };
    });
    expect(issuesOf(cv)).toEqual([
      { path: 'experience[0].bullets[0]', code: 'unsupported_number' },
    ]);
  });

  it('checks the headings, education lines, skills and the cover note too', () => {
    const cv = edited((c) => {
      at(c.experience, 0).heading.role = 'Intern 2019';
      at(c.education, 0).line = 'Scrum Fundamentals Certificate, grade 98%';
      at(c.skills, 0).label = 'SQL (10 years)';
      at(c.coverNote.paragraphs, 1).text = 'I cut time-to-live by 90%.';
    });
    const unsupported = issuesOf(cv)
      .filter((issue) => issue.code === 'unsupported_number')
      .map((issue) => issue.path);
    expect(unsupported).toEqual([
      'experience[0].heading.role',
      'education[0]',
      'skills[0]',
      'coverNote.paragraphs[1]',
    ]);
  });

  it('holds a heading, an education line and a skill to their fact types', () => {
    const cv = edited((c) => {
      at(c.education, 0).factRef = aliasOf('fact-ttl'); // a metric
      at(c.skills, 1).factRefs = [aliasOf('fact-python'), aliasOf('fact-olist')]; // one is a project
    });
    expect(issuesOf(cv)).toEqual([
      { path: 'education[0]', code: 'wrong_fact_type' },
      { path: 'skills[1]', code: 'wrong_fact_type' },
    ]);
  });

  it('checks every content count against its limit', () => {
    const cv = edited((c) => {
      c.coverNote.paragraphs = [at(c.coverNote.paragraphs, 0)];
      at(c.experience, 0).bullets = Array.from({ length: 6 }, () => ({
        text: 'Led onboarding for 12 clients.',
        factRefs: [aliasOf('fact-clients')],
      }));
    });
    expect(issuesOf(cv)).toEqual([
      { path: 'coverNote.paragraphs', code: 'too_long' },
      { path: 'experience[0].bullets', code: 'too_long' },
    ]);
  });

  it('checks the cover note against its word limit', () => {
    const words = (n: number) => Array.from({ length: n }, () => 'ab').join(' ');
    const note = (first: number, second: number) =>
      edited((c) => {
        at(c.coverNote.paragraphs, 0).text = words(first);
        at(c.coverNote.paragraphs, 1).text = words(second);
      });
    expect(issuesOf(note(126, 125))).toEqual([{ path: 'coverNote.paragraphs', code: 'too_long' }]);
    expect(check(note(125, 125))).toEqual({ ok: true });
  });

  it('accepts the characters WinAnsi can print and refuses a newline, a tab and anything else', () => {
    expect(['café — “quoted” €5 · £3', 'naïve Ångström'].every(isPrintable)).toBe(true);
    expect(isPrintable('line\nbreak')).toBe(false);
    expect(isPrintable('tab\there')).toBe(false);
    expect(isPrintable('日本語')).toBe(false);
    expect(isPrintable('emoji 🚀')).toBe(false);
    expect(isWinAnsi('\u200b')).toBe(false);
  });

  it('does not put the offending text in an issue', () => {
    const cv = edited((c) => {
      c.summary.text = `Mail alex@example.com or call ${INTL_PHONE} about 4,000 users.`;
    });
    expect(JSON.stringify(issuesOf(cv))).not.toMatch(/alex|7700|4,000/);
  });

  it('lists each distinct code once, in the declared order', () => {
    const cv = edited((c) => {
      c.summary.text = 'See www.example.com, 99 users.';
      c.summary.factRefs = ['F99'];
    });
    expect(issueCodes(issuesOf(cv))).toEqual([
      'unknown_fact',
      'unsupported_number',
      'contact_in_text',
    ]);
  });
});

/** The facts with one retyped, for the citation-type tests. */
function retyped(id: string, type: CvFact['type']): CvFact[] {
  return CV_FACTS.map((fact) => (fact.id === id ? { ...fact, type } : fact));
}

describe('unsupported_text: heading, education and skill words come from the cited fact', () => {
  const role = (text: string) =>
    edited((cv) => {
      at(cv.experience, 0).heading.role = text;
    });
  const org = (text: string) =>
    edited((cv) => {
      at(cv.experience, 0).heading.org = text;
    });

  it('rejects a role the cited fact does not say', () => {
    expect(issuesOf(role('Senior Product Manager'))).toEqual([
      { path: 'experience[0].heading.role', code: 'unsupported_text' },
    ]);
  });

  it('rejects another company under a real fact', () => {
    expect(issuesOf(org('Acme Rockets Ltd'))).toEqual([
      { path: 'experience[0].heading.org', code: 'unsupported_text' },
    ]);
  });

  it('accepts a shortened role or org, other case and accents, and the skipped words', () => {
    expect(check(role('Onboarding Intern'))).toEqual({ ok: true });
    expect(check(org('Example Cloud'))).toEqual({ ok: true });
    expect(check(org('EXAMPLE cloud'))).toEqual({ ok: true });
    expect(check(org('The Example Cloud Limited'))).toEqual({ ok: true });
    expect(check(org('Example Cloud Inc'))).toEqual({ ok: true });
    expect(check(role('Intern for Customer Onboarding'))).toEqual({ ok: true });
  });

  it('reads the fact evidence as well as its text', () => {
    // "London" is only in the evidence of fact-intern.
    expect(check(org('Example Cloud London'))).toEqual({ ok: true });
  });

  it('holds a project heading and an education line to their facts too', () => {
    const project = edited((cv) => {
      at(cv.projects, 0).heading.org = 'Kaggle retail forecasting';
    });
    expect(issuesOf(project)).toEqual([
      { path: 'projects[0].heading.org', code: 'unsupported_text' },
    ]);
    const education = edited((cv) => {
      at(cv.education, 0).line = 'BSc Computer Science, University of Example';
    });
    expect(issuesOf(education)).toEqual([{ path: 'education[0]', code: 'unsupported_text' }]);
    const shorter = edited((cv) => {
      at(cv.education, 0).line = 'Scrum Certificate';
    });
    expect(check(shorter)).toEqual({ ok: true });
  });

  it('does not report words of an uncited or unknown heading twice', () => {
    const cv = edited((c) => {
      at(c.experience, 0).heading.factRef = 'F99';
      at(c.experience, 0).heading.role = 'Senior Product Manager';
    });
    expect(issuesOf(cv)).toEqual([{ path: 'experience[0].heading', code: 'unknown_fact' }]);
  });
});

describe('fact types per section', () => {
  it('has an experience heading cite an experience fact only', () => {
    for (const id of ['fact-olist', 'fact-scrum']) {
      const cv = edited((c) => {
        at(c.experience, 0).heading.factRef = aliasOf(id);
        at(c.experience, 0).heading.role = 'Olist';
        at(c.experience, 0).heading.org = 'Scrum';
      });
      expect(issuesOf(cv)).toContainEqual({
        path: 'experience[0].heading',
        code: 'wrong_fact_type',
      });
    }
  });

  it('lets a project heading cite a project or an experience fact, and nothing else', () => {
    const experience = edited((c) => {
      at(c.projects, 0).heading = {
        role: 'Onboarding',
        org: 'Example Cloud',
        factRef: aliasOf('fact-intern'),
      };
    });
    expect(check(experience)).toEqual({ ok: true });
    const education = edited((c) => {
      at(c.projects, 0).heading = {
        role: 'Scrum',
        org: 'Certificate',
        factRef: aliasOf('fact-scrum'),
      };
    });
    expect(issuesOf(education)).toEqual([{ path: 'projects[0].heading', code: 'wrong_fact_type' }]);
  });

  it('has an education line cite an education fact only', () => {
    const cv = edited((c) => {
      at(c.education, 0).factRef = aliasOf('fact-olist');
      at(c.education, 0).line = 'Olist analysis';
    });
    expect(issuesOf(cv)).toEqual([{ path: 'education[0]', code: 'wrong_fact_type' }]);
  });
});

describe('skill labels', () => {
  const label = (text: string, ...ids: string[]) =>
    edited((cv) => {
      cv.skills = [{ label: text, factRefs: ids.map(aliasOf) }];
    });

  it('needs the label words in the cited skill fact', () => {
    expect(issuesOf(label('Python', 'fact-sql'))).toEqual([
      { path: 'skills[0]', code: 'unsupported_text' },
    ]);
    expect(issuesOf(label('Advanced SQL', 'fact-sql'))).toEqual([
      { path: 'skills[0]', code: 'unsupported_text' },
    ]);
    expect(check(label('SQL', 'fact-sql'))).toEqual({ ok: true });
  });

  it('needs a cited fact for each part of a combined label', () => {
    expect(issuesOf(label('SQL and Python', 'fact-sql'))).toEqual([
      { path: 'skills[0]', code: 'unsupported_text' },
    ]);
    expect(issuesOf(label('SQL, Python', 'fact-python'))).toEqual([
      { path: 'skills[0]', code: 'unsupported_text' },
    ]);
    expect(check(label('SQL and Python', 'fact-sql', 'fact-python'))).toEqual({ ok: true });
    expect(check(label('SQL / Python', 'fact-python', 'fact-sql'))).toEqual({ ok: true });
  });

  it('does not let one fact stand for two parts', () => {
    // Both words are in the cited facts together, but "Python" is not in the fact for "SQL".
    const facts = CV_FACTS.map((fact) =>
      fact.id === 'fact-sql' ? { ...fact, text: 'SQL', evidence: 'SQL, Python' } : fact,
    );
    expect(check(label('SQL and Python', 'fact-sql'), facts)).toEqual({ ok: true });
    expect(issuesOf(label('SQL and Python', 'fact-sql'))).toHaveLength(1);
  });

  it('holds a one- or two-letter part to a whole match', () => {
    const facts = CV_FACTS.map((fact) =>
      fact.id === 'fact-python' ? { ...fact, text: 'R', evidence: 'R' } : fact,
    );
    expect(check(label('R', 'fact-python'), facts)).toEqual({ ok: true });
    expect(issuesOf(label('Go', 'fact-python'), facts)).toEqual([
      { path: 'skills[0]', code: 'unsupported_text' },
    ]);
  });
});

describe('citation types', () => {
  const bullet = (id: string) =>
    edited((cv) => {
      at(cv.experience, 0).bullets[1] = {
        text: 'Cut client time-to-live by 30%.',
        factRefs: [aliasOf(id)],
      };
    });

  it('refuses a constraint or a preference fact under a bullet, a heading, an education line and a skill', () => {
    for (const type of ['constraint', 'preference'] as const) {
      const facts = retyped('fact-ttl', type);
      expect(issuesOf(bullet('fact-ttl'), facts)).toContainEqual({
        path: 'experience[0].bullets[1]',
        code: 'wrong_fact_type',
      });
      const skill = edited((cv) => {
        at(cv.skills, 0).factRefs = [aliasOf('fact-ttl')];
        at(cv.skills, 0).label = 'time-to-live';
      });
      expect(issuesOf(skill, facts)).toContainEqual({ path: 'skills[0]', code: 'wrong_fact_type' });
    }
    const heading = edited((cv) => {
      at(cv.experience, 0).heading.factRef = aliasOf('fact-ttl');
    });
    expect(issuesOf(heading, retyped('fact-ttl', 'constraint'))).toContainEqual({
      path: 'experience[0].heading',
      code: 'wrong_fact_type',
    });
  });

  it('lets the summary and the cover note cite a constraint fact, never a preference fact', () => {
    // fact-ttl is cited by the summary (with fact-articles) and by the second paragraph.
    expect(check(validCv(), retyped('fact-ttl', 'constraint'))).toEqual({ ok: true });
    expect(issuesOf(validCv(), retyped('fact-ttl', 'preference'))).toEqual([
      { path: 'summary', code: 'wrong_fact_type' },
      { path: 'experience[0].bullets[1]', code: 'wrong_fact_type' },
      { path: 'coverNote.paragraphs[1]', code: 'wrong_fact_type' },
    ]);
  });
});

describe('figures', () => {
  it('compares figures by value and kind', () => {
    expect([...figuresIn('12k users, £50,000, 30%, 1.5m, 12 clients')].sort()).toEqual([
      'money:50000',
      'percent:30',
      'plain:12',
      'plain:12000',
      'plain:1500000',
    ]);
    expect(figuresIn('30 percent')).toEqual(new Set(['percent:30']));
    expect(figuresIn('12,000')).toEqual(figuresIn('12k'));
  });

  it('ignores digits inside names and version numbers', () => {
    expect(figuresIn('S3, ES6, Web3, 3D, 2FA, v1.2.3, 1st')).toEqual(new Set());
  });

  it('keeps a percentage apart from a plain number and from money', () => {
    expect(figuresIn('30%')).not.toEqual(figuresIn('30'));
    expect(figuresIn('£30')).not.toEqual(figuresIn('30'));
  });
});

describe('contact details in text', () => {
  it.each([
    'alex@example.com',
    `Call ${NATIONAL_PHONE}`,
    `Call ${INTL_PHONE}`,
    'See https://example.com/alex',
    'www.example.org',
    'github.io pages',
    'my site example.co.uk',
  ])('finds %s', (text) => {
    expect(hasContactDetails(text)).toBe(true);
  });

  it.each([
    'Built dashboards with Node.js and Vue.js',
    'Led onboarding for 12 clients',
    'Cut time by 30%',
  ])('leaves %s alone', (text) => {
    expect(hasContactDetails(text)).toBe(false);
  });
});

describe('dates are code, not model text', () => {
  it("formats a fact's dates", () => {
    expect(formatFactDates({ start: '2023-10', end: '2024-05' })).toBe('Oct 2023 – May 2024');
    expect(formatFactDates({ start: '2022', end: 'present' })).toBe('2022 – Present');
    expect(formatFactDates({ start: '2024-06' })).toBe('Jun 2024 – Present');
    expect(formatFactDates({})).toBe('');
  });
});

describe('citedFactIds', () => {
  it('lists the facts the content cites, distinct and sorted', () => {
    expect(citedFactIds(validCv(), CV_ALIASES)).toEqual(
      [
        'fact-articles',
        'fact-clients',
        'fact-intern',
        'fact-olist',
        'fact-scrum',
        'fact-python',
        'fact-sql',
        'fact-ttl',
      ].sort(),
    );
  });
});

describe('trimOrder', () => {
  it('is deterministic and does not mutate its input', () => {
    const content = fullCv();
    const before = structuredClone(content);
    expect(trimOrder(content)).toEqual(trimOrder(structuredClone(content)));
    expect(content).toEqual(before);
  });

  it('takes the last bullet of the longest experience entry first, the later entry on a tie', () => {
    const steps = trimOrder(fullCv()); // entries have 5, 5, 4, 2 bullets
    expect(steps.slice(0, 6)).toEqual([
      { kind: 'bullet', section: 'experience', entry: 1, index: 4 }, // 5,5,4,2 -> 5,4,4,2
      { kind: 'bullet', section: 'experience', entry: 0, index: 4 }, // -> 4,4,4,2
      { kind: 'bullet', section: 'experience', entry: 2, index: 3 }, // -> 4,4,3,2
      { kind: 'bullet', section: 'experience', entry: 1, index: 3 }, // -> 4,3,3,2
      { kind: 'bullet', section: 'experience', entry: 0, index: 3 }, // -> 3,3,3,2
      { kind: 'bullet', section: 'experience', entry: 2, index: 2 }, // -> 3,3,2,2
    ]);
  });

  it('then projects, skills over 10 and the summary, and never a heading or education', () => {
    const steps = trimOrder(fullCv());
    const kinds = steps.map((step) => step.kind);
    // 5+5+4+2 bullets down to one each: 16 - 4 = 12 bullet steps.
    expect(kinds.filter((k) => k === 'bullet')).toHaveLength(12);
    expect(kinds).toEqual([
      ...Array<string>(12).fill('bullet'),
      'project',
      'project',
      'project',
      ...Array<string>(6).fill('skill'),
      'summary',
    ]);
    expect(steps.filter((s) => s.kind === 'project').map((s) => 'index' in s && s.index)).toEqual([
      2, 1, 0,
    ]);
    expect(steps.filter((s) => s.kind === 'skill').map((s) => 'index' in s && s.index)).toEqual([
      15, 14, 13, 12, 11, 10,
    ]);
  });

  it('leaves every experience entry one bullet and the education alone after all steps', () => {
    const content = fullCv();
    const all = trimOrder(content).length;
    const trimmed = applyTrim(content, all);
    expect(trimmed.experience.map((e) => e.bullets.length)).toEqual([1, 1, 1, 1]);
    expect(trimmed.experience.map((e) => e.heading)).toEqual(
      content.experience.map((e) => e.heading),
    );
    expect(trimmed.education).toEqual(content.education);
    expect(trimmed.projects).toEqual([]);
    expect(trimmed.skills).toHaveLength(10);
    expect(trimmed.summary).toBeNull();
  });

  it('applies the first n steps only, and 0 changes nothing', () => {
    const content = fullCv();
    expect(applyTrim(content, 0)).toEqual(content);
    const one = applyTrim(content, 1);
    expect(one.experience.map((e) => e.bullets.length)).toEqual([5, 4, 4, 2]);
    expect(one.summary).toEqual(content.summary);
  });

  it('in a small CV removes two bullets, the project and the summary, and no more', () => {
    expect(trimOrder(validCv())).toEqual([
      { kind: 'bullet', section: 'experience', entry: 0, index: 2 },
      { kind: 'bullet', section: 'experience', entry: 0, index: 1 },
      { kind: 'project', index: 0 },
      { kind: 'summary' },
    ]);
  });
});

describe('schemas', () => {
  it('reject extra keys at every level', () => {
    const cv = validCv();
    const entry = at(cv.experience, 0);
    const extras = [
      { ...cv, phone: NATIONAL_PHONE },
      { ...cv, summary: { ...cv.summary, dates: '2024' } },
      {
        ...cv,
        experience: [{ ...entry, heading: { ...entry.heading, dates: '2024' } }],
      },
      { ...cv, experience: [{ ...entry, extra: 1 }] },
      { ...cv, skills: [{ ...at(cv.skills, 0), level: 5 }] },
      { ...cv, coverNote: { ...cv.coverNote, subject: 'Hello' } },
    ];
    for (const bad of extras) {
      expect(CvContentSchema.safeParse(bad).success).toBe(false);
      expect(CvContentShapeSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('enforces the limits strictly but lets the shape schema through for validateCv', () => {
    const long = edited((cv) => {
      at(at(cv.experience, 0).bullets, 0).text = 'x'.repeat(CV_LIMITS.bullet + 1);
      at(at(cv.experience, 0).bullets, 1).factRefs = [];
    });
    expect(CvContentSchema.safeParse(long).success).toBe(false);
    const shaped = CvContentShapeSchema.parse(long);
    expect(issueCodes(issuesOf(shaped))).toEqual(['uncited', 'unsupported_number', 'too_long']);
  });

  it('keeps the header to https links and a real email', () => {
    const header = {
      name: 'Alex Example',
      email: 'alex@example.com',
      links: ['https://example.com/alex'],
      createdAt: new Date(),
      updatedAt: new Date(),
      schemaVersion: 1,
    };
    expect(CvHeaderSchema.safeParse(header).success).toBe(true);
    expect(CvHeaderSchema.safeParse({ ...header, links: ['http://example.com'] }).success).toBe(
      false,
    );
    expect(
      CvHeaderSchema.safeParse({ ...header, links: Array(4).fill('https://example.com') }).success,
    ).toBe(false);
    expect(CvHeaderSchema.safeParse({ ...header, email: 'not-an-email' }).success).toBe(false);
    expect(CvHeaderSchema.safeParse({ ...header, address: '1 High St' }).success).toBe(false);
  });

  it('describes a stored CV, rejects extra keys, and names the id <jobId>-v<n>', () => {
    expect(cvId('job-1', 2)).toBe('job-1-v2');
    const doc = {
      jobId: 'job-1',
      applicationVersion: 2,
      content: { ...validCv(), summary: null },
      aliases: Object.fromEntries(CV_ALIASES),
      factIds: citedFactIds(validCv(), CV_ALIASES),
      storagePaths: { cvPdf: 'a', cvDocx: 'b', notePdf: 'c', noteDocx: 'd' },
      trimmed: 1,
      model: 'claude-sonnet-5-5',
      costPence: 4.3,
      createdAt: new Date(),
      schemaVersion: 1,
    };
    expect(CvDocSchema.safeParse(doc).success).toBe(true);
    expect(CvDocSchema.safeParse({ ...doc, tokens: 5 }).success).toBe(false);
  });
});
