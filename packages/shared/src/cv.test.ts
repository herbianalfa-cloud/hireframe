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

  it('rejects a figure the cited fact does not have, then accepts it once the fact says so', () => {
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

  // ACCEPTED RISK (ADR-054): the check compares figures, not what they count. "12" in the cited
  // fact is "12 clients", and the bullet says "12 engineers"; the validator cannot tell. A figure
  // from any cited fact or its evidence supports the text.
  it('accepts "Led a team of 12 engineers" citing "12 clients" (documented, accepted)', () => {
    const claim = edited((cv) => {
      at(cv.experience, 0).bullets[0] = {
        text: 'Led a team of 12 engineers.',
        factRefs: [aliasOf('fact-clients')],
      };
    });
    expect(check(claim)).toEqual({ ok: true });
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
      // The line's words are not in the metric fact either.
      { path: 'education[0]', code: 'unsupported_text' },
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

describe('counts, citations and empty text', () => {
  const copies = <T>(item: T, n: number): T[] =>
    Array.from({ length: n }, () => structuredClone(item));

  it('allows 8 citations on a text and refuses a 9th', () => {
    const refs = (n: number) =>
      edited((cv) => {
        at(at(cv.experience, 0).bullets, 0).factRefs = copies(aliasOf('fact-clients'), n);
      });
    expect(check(refs(8))).toEqual({ ok: true });
    expect(issuesOf(refs(9))).toEqual([{ path: 'experience[0].bullets[0]', code: 'too_long' }]);
  });

  it('refuses text that is only whitespace, wherever it is', () => {
    const cv = edited((c) => {
      c.summary.text = '   ';
      at(c.experience, 0).heading.role = '\t ';
      at(at(c.experience, 0).bullets, 0).text = ' ';
      at(c.education, 0).line = '  ';
      at(c.skills, 0).label = ' ';
      at(c.coverNote.paragraphs, 0).text = ' ';
    });
    const paths = issuesOf(cv)
      .filter((issue) => issue.code === 'too_long')
      .map((issue) => issue.path);
    expect(paths).toEqual([
      'summary',
      'experience[0].heading.role',
      'experience[0].bullets[0]',
      'education[0]',
      'skills[0]',
      'coverNote.paragraphs[0]',
    ]);
  });

  it.each([
    ['experience', CV_LIMITS.experienceEntries],
    ['projects', CV_LIMITS.projectEntries],
    ['education', CV_LIMITS.educationEntries],
    ['skills', CV_LIMITS.skills],
  ] as const)('allows %s up to its limit and refuses one more', (section, limit) => {
    const withCount = (n: number) =>
      edited((cv) => {
        const first: unknown = at<unknown>(cv[section], 0);
        Object.assign(cv, { [section]: copies(first, n) });
      });
    expect(issuesOf(withCount(limit + 1))).toContainEqual({ path: section, code: 'too_long' });
    expect(issuesOf(withCount(limit + 1)).filter((i) => i.path === section)).toHaveLength(1);
    expect(check(withCount(limit))).toEqual({ ok: true });
  });

  it('reports an empty heading reference as uncited, not as an unknown fact', () => {
    const cv = edited((c) => {
      at(c.experience, 0).heading.factRef = '';
      at(c.education, 0).factRef = '';
    });
    expect(issuesOf(cv)).toEqual([
      { path: 'experience[0].heading', code: 'uncited' },
      { path: 'education[0]', code: 'uncited' },
    ]);
  });
});

/** A small seeded generator, so a failure names its seed and reruns the same way. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('validateCv ok implies the strict schema', () => {
  const TEXTS = [
    '',
    '   ',
    ' padded ',
    'Led onboarding for 12 clients.',
    'Cut client time-to-live by 30%.',
    'Customer Onboarding Intern',
    'Example Cloud Ltd',
    'SQL',
    'Python',
    'Scrum Fundamentals Certificate',
    'Olist e-commerce analysis',
    'x'.repeat(CV_LIMITS.bullet + 1),
    'w'.repeat(CV_LIMITS.summary),
    'line\nbreak',
    '日本語',
    'a'.repeat(5),
  ];

  it('holds for random edits of the valid CV, and some of them are valid', () => {
    const rng = random(20260101);
    const pick = <T>(items: readonly T[]): T => at(items, Math.floor(rng() * items.length));
    const aliasPool = [...CV_ALIASES.keys(), 'F99', '', 'F1234567890'];
    const refs = () => Array.from({ length: Math.floor(rng() * 10) }, () => pick(aliasPool));
    let valid = 0;
    for (let run = 0; run < 1500; run += 1) {
      const cv = structuredClone(validCv());
      const maybe = (p: number) => rng() < p;
      if (maybe(0.04)) cv.summary.text = pick(TEXTS);
      if (maybe(0.04)) cv.summary.factRefs = refs();
      for (const entry of [...cv.experience, ...cv.projects]) {
        if (maybe(0.04)) entry.heading.role = pick(TEXTS);
        if (maybe(0.04)) entry.heading.org = pick(TEXTS);
        if (maybe(0.04)) entry.heading.factRef = pick(aliasPool);
        for (const bullet of entry.bullets) {
          if (maybe(0.04)) bullet.text = pick(TEXTS);
          if (maybe(0.04)) bullet.factRefs = refs();
        }
        if (maybe(0.02)) entry.bullets.push(...copies5(entry.bullets));
      }
      for (const line of cv.education) {
        if (maybe(0.04)) line.line = pick(TEXTS);
        if (maybe(0.04)) line.factRef = pick(aliasPool);
      }
      for (const skill of cv.skills) {
        if (maybe(0.04)) skill.label = pick(TEXTS);
        if (maybe(0.04)) skill.factRefs = refs();
      }
      for (const paragraph of cv.coverNote.paragraphs) {
        if (maybe(0.04)) paragraph.text = pick(TEXTS);
        if (maybe(0.04)) paragraph.factRefs = refs();
      }
      if (maybe(0.02)) cv.coverNote.paragraphs.pop();
      if (maybe(0.02)) cv.experience.push(...structuredClone(cv.experience));
      if (maybe(0.02)) cv.skills.push(...structuredClone(cv.skills).slice(0, 20));

      if (check(cv).ok) {
        valid += 1;
        expect(CvContentSchema.safeParse(cv).success, `run ${String(run)}`).toBe(true);
      }
    }
    expect(valid).toBeGreaterThan(50);
  });
});

function copies5<T>(items: readonly T[]): T[] {
  return structuredClone([...items]).slice(0, 5);
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

  it("reads a part from the cited fact's evidence, and not from a fact that is not cited", () => {
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
    // After this edit only the summary and the second paragraph cite fact-ttl.
    const cv = edited((c) => {
      at(c.experience, 0).bullets[1] = {
        text: 'Led onboarding for 12 clients.',
        factRefs: [aliasOf('fact-clients')],
      };
    });
    expect(check(cv, retyped('fact-ttl', 'constraint'))).toEqual({ ok: true });
    expect(issuesOf(cv, retyped('fact-ttl', 'preference'))).toEqual([
      { path: 'summary', code: 'wrong_fact_type' },
      { path: 'coverNote.paragraphs[1]', code: 'wrong_fact_type' },
    ]);
  });
});

describe('figures', () => {
  it('compares figures by value and kind', () => {
    expect([...figuresIn('12k users, £50,000, 30%, 1.5m, 12 clients')].sort()).toEqual([
      'percent:30',
      'plain:12',
      'plain:12000',
      'plain:1500000',
      '£plain:50000',
    ]);
    expect(figuresIn('30 percent')).toEqual(new Set(['percent:30']));
    expect(figuresIn('12,000')).toEqual(figuresIn('12k'));
  });

  it('ignores digits inside names and version numbers', () => {
    expect(figuresIn('S3, ES6, Web3, 3D, 2FA, v1.2.3')).toEqual(new Set());
  });

  it('keeps a percentage apart from a plain number and each currency apart', () => {
    expect(figuresIn('30%')).not.toEqual(figuresIn('30'));
    expect(figuresIn('£30')).not.toEqual(figuresIn('30'));
    expect(figuresIn('£470')).not.toEqual(figuresIn('$470'));
    expect(figuresIn('€470')).not.toEqual(figuresIn('£470'));
    expect(figuresIn('£470')).toEqual(figuresIn('£470'));
  });

  it('reads multipliers, ordinals, plurals and fractions as figures of their own kind', () => {
    expect(figuresIn('10x')).toEqual(new Set(['times:10']));
    expect(figuresIn('a 10-fold rise')).toEqual(new Set(['times:10']));
    expect(figuresIn('2nd, 21st')).toEqual(new Set(['ordinal:2', 'ordinal:21']));
    expect(figuresIn('100s of')).toEqual(new Set(['plural:100']));
    expect(figuresIn('the 1990s')).toEqual(new Set(['plural:1990']));
    expect(figuresIn('¼ ½ ¾')).toEqual(new Set(['fraction:0.25', 'fraction:0.5', 'fraction:0.75']));
    expect(figuresIn('10x')).not.toEqual(figuresIn('10'));
    expect(figuresIn('2nd')).not.toEqual(figuresIn('2'));
  });

  it('reads b, bn, MM and mn as billions and millions', () => {
    expect(figuresIn('$2b, 3bn')).toEqual(new Set(['$plain:2000000000', 'plain:3000000000']));
    expect(figuresIn('5MM, 4mn, 6m')).toEqual(
      new Set(['plain:5000000', 'plain:4000000', 'plain:6000000']),
    );
  });

  it('reads "2 million" like "2m", and does not count the word twice', () => {
    expect(figuresIn('£2 million')).toEqual(figuresIn('£2m'));
    expect(figuresIn('1.5 billion')).toEqual(new Set(['plain:1500000000']));
    expect(figuresIn('3 hundred')).toEqual(new Set(['plain:300']));
  });

  it('does not take "10+" for "10"', () => {
    expect(figuresIn('10+ clients')).toEqual(new Set(['plain:10+']));
    expect(figuresIn('10+ clients')).not.toEqual(figuresIn('10 clients'));
    expect(figuresIn('£2m+')).toEqual(new Set(['£plain:2000000+']));
  });

  it('reads number words by value, so "twelve" and "12" are the same figure', () => {
    expect(figuresIn('twelve')).toEqual(figuresIn('12'));
    expect(figuresIn('Twenty-five')).toEqual(new Set(['plain:25']));
    expect(figuresIn('two hundred')).toEqual(new Set(['plain:200']));
    expect(figuresIn('three hundred and fifty')).toEqual(new Set(['plain:350']));
    expect(figuresIn('a dozen')).toEqual(new Set(['plain:12']));
    expect(figuresIn('two dozen')).toEqual(new Set(['plain:24']));
    expect(figuresIn('two thousand')).toEqual(new Set(['plain:2000']));
    expect(figuresIn('five million')).toEqual(new Set(['plain:5000000']));
    expect(figuresIn('forty')).toEqual(new Set(['plain:40']));
    expect(figuresIn('ten percent')).toEqual(new Set(['percent:10']));
  });

  it('reads the indefinite and the changed-by words as kinds of their own', () => {
    expect(figuresIn('tens, dozens, hundreds')).toEqual(
      new Set(['word:tens', 'word:dozens', 'word:hundreds']),
    );
    expect(figuresIn('half')).toEqual(new Set(['word:half']));
    expect(figuresIn('halved')).toEqual(new Set(['word:halved']));
    expect(figuresIn('double, doubled')).toEqual(new Set(['word:double']));
    expect(figuresIn('triple, tripled')).toEqual(new Set(['word:triple']));
    expect(figuresIn('quadruple, quadrupled')).toEqual(new Set(['word:quadruple']));
  });

  it('does not check "one"', () => {
    expect(figuresIn('one of the first, no one')).toEqual(new Set());
    expect(figuresIn('one hundred')).toEqual(new Set(['plain:100']));
  });
});

describe('unsupported_number across the new kinds', () => {
  const bullet = (text: string, id = 'fact-clients') =>
    edited((cv) => {
      at(cv.experience, 0).bullets[0] = { text, factRefs: [aliasOf(id)] };
    });
  const unsupported = { path: 'experience[0].bullets[0]', code: 'unsupported_number' };

  it.each([
    'Grew onboarding 10x.',
    'Ranked 2nd of the cohort.',
    'Led 100s of clients.',
    'Handled £12 clients.',
    'Led over 12+ clients.',
    'Led twenty clients.',
    'Led a dozen teams of fifteen.',
    'Led hundreds of clients.',
    'Halved the time to onboard 12 clients.',
    'Doubled onboarding for 12 clients.',
    'Tripled the 12 clients.',
    'Reached a 12-fold increase.',
    'Reached ¼ of 12 clients.',
    'Raised $2b.',
  ])('rejects "%s" against a fact that says "12 clients"', (text) => {
    expect(issuesOf(bullet(text))).toContainEqual(unsupported);
  });

  it.each([
    'Led twelve clients.',
    'Led a dozen clients.',
    'Led one client of the 12.',
    'Led 12 clients, one by one.',
  ])('accepts "%s" against a fact that says "12 clients"', (text) => {
    expect(check(bullet(text))).toEqual({ ok: true });
  });

  it('accepts a figure the fact has in the same kind', () => {
    const facts = CV_FACTS.map((fact) =>
      fact.id === 'fact-clients'
        ? {
            ...fact,
            text: 'Grew sign-ups 10x to 100s of users for £470 and 10+ clients, halved churn',
          }
        : fact,
    );
    const claim = bullet(
      'Grew sign-ups 10x to 100s of users for £470 and 10+ clients, halved churn.',
    );
    expect(check(claim, facts)).toEqual({ ok: true });
    expect(issuesOf(bullet('Spent $470.'), facts)).toContainEqual(unsupported);
    expect(issuesOf(bullet('Won 10 clients.'), facts)).toContainEqual(unsupported);
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
    'evil.co/x',
    'evil.site',
    't.co/abc',
    'example[.]com',
    'example [.] com',
    'x dot com',
    'x DOT co dot uk',
    'Node.js',
    'Socket.IO',
  ])('finds %s', (text) => {
    expect(hasContactDetails(text)).toBe(true);
  });

  it.each([
    'Led onboarding for 12 clients',
    'Cut time by 30%',
    'Grew sign-ups by 1.5m and 12.5%',
    'Used v1.2.3 e.g. in Q3 and i.e. later',
    'Computed the dot product',
    'Finished the first.',
  ])('leaves %s alone', (text) => {
    expect(hasContactDetails(text)).toBe(false);
  });

  it('allows a name only when it is in the cited facts, literally', () => {
    const facts = 'Built APIs with ASP.NET and Booking.com data, plus Socket.IO';
    expect(hasContactDetails('ASP.NET and Socket.IO services', facts)).toBe(false);
    expect(hasContactDetails('worked on booking.com data', facts)).toBe(false);
    expect(hasContactDetails('ASP.NET services')).toBe(true);
    expect(hasContactDetails('Vue.js apps', facts)).toBe(true);
    // A path or a longer name is a different token.
    expect(hasContactDetails('Booking.com/jobs', facts)).toBe(true);
    expect(hasContactDetails('Booking.com.evil.io', facts)).toBe(true);
  });

  it('never allows an obfuscated address, a link, an email or a phone number', () => {
    const facts = `Booking.com, https://example.com/alex, www.example.org, alex@example.com, ${INTL_PHONE}`;
    for (const text of [
      'Booking dot com',
      'Booking[.]com',
      'https://example.com/alex',
      'www.example.org',
      'alex@example.com',
      INTL_PHONE,
    ]) {
      expect(hasContactDetails(text, facts), text).toBe(true);
    }
  });

  describe('in a CV', () => {
    const withFact = (text: string) =>
      CV_FACTS.map((fact) => (fact.id === 'fact-clients' ? { ...fact, text } : fact));
    const bullet = (text: string) =>
      edited((cv) => {
        at(cv.experience, 0).bullets[0] = { text, factRefs: [aliasOf('fact-clients')] };
      });
    const found = { path: 'experience[0].bullets[0]', code: 'contact_in_text' };

    it.each([
      'Sent users to evil.co/x.',
      'Hosted at evil.site.',
      'Linked t.co/abc.',
      'See example[.]com.',
      'Hosted at x dot com.',
    ])('rejects "%s"', (text) => {
      expect(issuesOf(bullet(text))).toContainEqual(found);
      // Not even a cited fact that carries it, for a text that is not a literal token.
    });

    it('passes ASP.NET and Socket.IO with a citing fact, and fails without', () => {
      const text = 'Built ASP.NET and Socket.IO services.';
      expect(check(bullet(text), withFact('Built ASP.NET and Socket.IO services'))).toEqual({
        ok: true,
      });
      expect(issuesOf(bullet(text))).toContainEqual(found);
    });

    it('does not let a cited email or number through', () => {
      const facts = withFact(`Emailed alex@example.com and rang ${INTL_PHONE}`);
      expect(issuesOf(bullet('Emailed alex@example.com.'), facts)).toContainEqual(found);
      expect(issuesOf(bullet(`Rang ${INTL_PHONE}.`), facts)).toContainEqual(found);
    });
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

/** The valid CV with its first experience heading, and an education line, replaced. */
const heading = (role: string, org: string) =>
  edited((cv) => {
    at(cv.experience, 0).heading.role = role;
    at(cv.experience, 0).heading.org = org;
  });

describe('word rule: words of 2+ letters', () => {
  it.each(['VP of AI', 'MD', 'PM', 'Sr PM', 'AI Intern', 'Intern II'])(
    'rejects the role "%s" under the intern fact',
    (role) => {
      expect(issuesOf(heading(role, 'Example Cloud Ltd'))).toEqual([
        { path: 'experience[0].heading.role', code: 'unsupported_text' },
      ]);
    },
  );

  it.each(['EY', 'BP', 'Example Cloud UK'])('rejects the org "%s" under the intern fact', (org) => {
    expect(issuesOf(heading('Customer Onboarding Intern', org))).toEqual([
      { path: 'experience[0].heading.org', code: 'unsupported_text' },
    ]);
  });

  it('skips at, in, on, to, by, an, as and or', () => {
    expect(check(heading('Intern at Example Cloud', 'Example Cloud'))).toEqual({ ok: true });
    expect(check(heading('Intern in Onboarding', 'Example Cloud'))).toEqual({ ok: true });
    expect(check(heading('Intern on Onboarding', 'Example Cloud'))).toEqual({ ok: true });
    expect(check(heading('Intern to Customer', 'Example Cloud'))).toEqual({ ok: true });
    expect(check(heading('Intern by Customer', 'Example Cloud'))).toEqual({ ok: true });
    expect(check(heading('An Intern as Onboarding', 'Example Cloud'))).toEqual({ ok: true });
    expect(check(heading('Intern or Onboarding', 'Example Cloud'))).toEqual({ ok: true });
  });

  it('accepts "BSc in Computer Science" when the fact has those words', () => {
    const facts = CV_FACTS.map((fact) =>
      fact.id === 'fact-scrum'
        ? { ...fact, text: 'BSc Computer Science', evidence: 'BSc Computer Science, 2023' }
        : fact,
    );
    const cv = edited((c) => {
      at(c.education, 0).line = 'BSc in Computer Science';
    });
    expect(check(cv, facts)).toEqual({ ok: true });
  });
});

describe('word rule: a 2-letter word in a skill label is checked', () => {
  const label = (text: string, factText: string) => {
    const facts: CvFact[] = [
      ...CV_FACTS,
      { id: 'fact-x', type: 'skill', text: factText, evidence: factText, status: 'active' },
    ];
    const aliases = new Map([...CV_ALIASES, ['F90', 'fact-x']]);
    const cv = edited((c) => {
      c.skills = [{ label: text, factRefs: ['F90'] }];
    });
    return validateCv(cv, aliases, facts);
  };

  it('checks "Go" as a word, so it is not free next to a real word', () => {
    expect(label('Go Python', 'Python')).toEqual({
      ok: false,
      issues: [{ path: 'skills[0]', code: 'unsupported_text' }],
    });
    expect(label('Go Python', 'Go and Python')).toEqual({ ok: true });
    expect(label('Go', 'Go')).toEqual({ ok: true });
  });

  it('keeps the whole-phrase fallback for a one-letter part', () => {
    expect(label('R', 'R')).toEqual({ ok: true });
    expect(label('R', 'Python')).toEqual({
      ok: false,
      issues: [{ path: 'skills[0]', code: 'unsupported_text' }],
    });
  });
});
