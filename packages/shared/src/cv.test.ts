import { describe, expect, it } from 'vitest';

import { CV_ISSUE_CODES, type CvIssueCode } from './applications.js';
import {
  applyTrim,
  clampCvCounts,
  dropUnsupportedSkills,
  CV_LIMITS,
  CvContentSchema,
  CvContentShapeSchema,
  CvDocSchema,
  CvHeaderSchema,
  cvId,
  citedFactIds,
  figuresIn,
  formatEducationDates,
  formatFactDates,
  hasContactDetails,
  isPrintable,
  isWinAnsi,
  normaliseCvText,
  issueCodes,
  factEndKey,
  orderEntries,
  scrubDashes,
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
    // Experience 5,5,4,2 down to 2 each (8 steps), and the 2-bullet project down to 1 (1 step).
    expect(kinds.filter((k) => k === 'bullet')).toHaveLength(9);
    expect(kinds).toEqual([
      ...Array<string>(9).fill('bullet'),
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

  it('takes bullets from Experience and Projects alike, the project first on a tie', () => {
    const content = fullCv();
    content.experience = [at(content.experience, 3)]; // 2 bullets: at its floor
    const bullets = (n: number) =>
      Array.from({ length: n }, () => ({ text: 'x', factRefs: [aliasOf('fact-clients')] }));
    const project = at(content.projects, 0);
    content.projects = [
      { ...project, bullets: bullets(3) },
      { ...project, bullets: bullets(3) },
    ];
    expect(trimOrder(content).slice(0, 4)).toEqual([
      { kind: 'bullet', section: 'projects', entry: 1, index: 2 },
      { kind: 'bullet', section: 'projects', entry: 0, index: 2 },
      { kind: 'bullet', section: 'projects', entry: 1, index: 1 },
      { kind: 'bullet', section: 'projects', entry: 0, index: 1 },
    ]);
  });

  it('keeps 2 bullets on every experience entry and 1 on every project until they are removed whole', () => {
    const content = fullCv();
    const lastBullet = trimOrder(content).findLastIndex((step) => step.kind === 'bullet');
    const trimmed = applyTrim(content, lastBullet + 1);
    expect(trimmed.experience.map((e) => e.bullets.length)).toEqual([2, 2, 2, 2]);
    expect(trimmed.projects.map((e) => e.bullets.length)).toEqual([1, 1, 1]);
  });

  it('removes projects oldest (last) first, keeping the newer ones', () => {
    const content = fullCv();
    const project = at(content.projects, 0);
    content.projects = ['A', 'B', 'C'].map((role) => ({
      ...project,
      heading: { ...project.heading, role },
    }));
    const firstProject = trimOrder(content).findIndex((step) => step.kind === 'project');
    expect(applyTrim(content, firstProject + 1).projects.map((p) => p.heading.role)).toEqual([
      'A',
      'B',
    ]);
    expect(applyTrim(content, firstProject + 2).projects.map((p) => p.heading.role)).toEqual(['A']);
  });

  it('leaves every experience entry two bullets and the education alone after all steps', () => {
    const content = fullCv();
    const all = trimOrder(content).length;
    const trimmed = applyTrim(content, all);
    expect(trimmed.experience.map((e) => e.bullets.length)).toEqual([2, 2, 2, 2]);
    expect(trimmed.experience.map((e) => e.heading)).toEqual(
      content.experience.map((e) => e.heading),
    );
    expect(trimmed.education).toEqual(content.education);
    expect(trimmed.projects).toEqual([]);
    expect(trimmed.skills).toHaveLength(10);
    expect(trimmed.summary).toBeNull();
  });

  it('never cuts an experience entry below 2 bullets, and an entry with fewer is left alone', () => {
    const content = fullCv();
    const one = at(content.experience, 0);
    content.experience = [{ ...one, bullets: one.bullets.slice(0, 1) }];
    expect(
      trimOrder(content).some((step) => step.kind === 'bullet' && step.section === 'experience'),
    ).toBe(false);
  });

  it('applies the first n steps only, and 0 changes nothing', () => {
    const content = fullCv();
    expect(applyTrim(content, 0)).toEqual(content);
    const one = applyTrim(content, 1);
    expect(one.experience.map((e) => e.bullets.length)).toEqual([5, 4, 4, 2]);
    expect(one.summary).toEqual(content.summary);
  });

  it('in a small CV removes one bullet, the project and the summary, and no more', () => {
    expect(trimOrder(validCv())).toEqual([
      { kind: 'bullet', section: 'experience', entry: 0, index: 2 },
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

  describe('quality', () => {
    const quality = {
      rubric: 'rubric-v1',
      total: 8.6,
      criteria: { fill: 2, writing: 2.25, numbers: 1, tailoring: 1.6, craft: 1.5, structure: 0.25 },
      findings: [{ code: 'intensifier', path: 'experience[0].bullets[1]' }],
      revised: true,
      draftTotal: 7.2,
      dashesReplaced: 2,
      layout: { bodySize: 10.5, fill: 0.97 },
    };
    const doc = {
      jobId: 'job-1',
      applicationVersion: 1,
      content: { ...validCv(), summary: null },
      aliases: Object.fromEntries(CV_ALIASES),
      factIds: [],
      storagePaths: { cvPdf: 'a', cvDocx: 'b', notePdf: 'c', noteDocx: 'd' },
      trimmed: 0,
      model: 'claude-sonnet-5-5',
      costPence: 4.3,
      createdAt: new Date(),
      schemaVersion: 1,
    };

    it('parses with a quality, and an old doc without one still parses', () => {
      expect(CvDocSchema.safeParse(doc).success).toBe(true);
      expect(CvDocSchema.safeParse({ ...doc, quality }).success).toBe(true);
      for (const revisionSkipped of ['not_fixable', 'output', 'invalid']) {
        expect(
          CvDocSchema.safeParse({ ...doc, quality: { ...quality, revisionSkipped } }).success,
        ).toBe(true);
      }
    });

    it('refuses a finding with text, an unknown code, 21 findings or a score over 10', () => {
      const bad = (override: object) =>
        CvDocSchema.safeParse({ ...doc, quality: { ...quality, ...override } }).success;
      expect(bad({ findings: [{ code: 'cliche', path: 'summary', text: 'x' }] })).toBe(false);
      expect(bad({ findings: [{ code: 'other', path: 'summary' }] })).toBe(false);
      expect(
        bad({ findings: Array.from({ length: 21 }, () => ({ code: 'cliche', path: 'summary' })) }),
      ).toBe(false);
      expect(bad({ total: 10.5 })).toBe(false);
      expect(bad({ revisionSkipped: 'because' })).toBe(false);
    });
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

/** The valid CV with one skill label citing one new skill fact per text; the result of `validateCv`. */
function skillCheck(label: string, ...factTexts: string[]) {
  const extra: CvFact[] = factTexts.map((text, i) => ({
    id: `fact-x${String(i)}`,
    type: 'skill',
    text,
    evidence: text,
    status: 'active',
  }));
  const aliases = new Map([
    ...CV_ALIASES,
    ...extra.map((f, i): [string, string] => [`F9${String(i)}`, f.id]),
  ]);
  const cv = edited((c) => {
    c.skills = [{ label, factRefs: extra.map((_, i) => `F9${String(i)}`) }];
  });
  return validateCv(cv, aliases, [...CV_FACTS, ...extra]);
}
const skillOk = (label: string, ...factTexts: string[]) => skillCheck(label, ...factTexts).ok;

describe('word rule: at least one checked word', () => {
  it('rejects a heading whose role and org are all skipped words', () => {
    expect(issuesOf(heading('The', 'Ltd'))).toContainEqual({
      path: 'experience[0].heading.role',
      code: 'unsupported_text',
    });
  });

  it('accepts "Personal project" with a real org, which has the words', () => {
    expect(check(heading('Personal project', 'Example Cloud'))).toEqual({ ok: true });
  });

  it('rejects an education line with no checked word', () => {
    const cv = edited((c) => {
      at(c.education, 0).line = 'of the';
    });
    expect(issuesOf(cv)).toEqual([{ path: 'education[0]', code: 'unsupported_text' }]);
  });

  it('rejects a skill label with no word, and accepts one real part', () => {
    expect(skillOk('-', 'SQL')).toBe(false);
    expect(skillOk(' , ; ', 'SQL')).toBe(false);
    expect(skillOk('SQL', 'SQL')).toBe(true);
    expect(skillOk('SQL,', 'SQL')).toBe(true);
  });
});

describe('skill tokens: C++, C#, F# and the separators', () => {
  it('does not read C# or C as C++, or the reverse', () => {
    expect(skillOk('C#', 'C++')).toBe(false);
    expect(skillOk('C', 'C++')).toBe(false);
    expect(skillOk('C++', 'C#')).toBe(false);
    expect(skillOk('C++', 'C')).toBe(false);
    expect(skillOk('F#', 'F')).toBe(false);
    expect(skillOk('C++', 'C++')).toBe(true);
    expect(skillOk('C#', 'C#')).toBe(true);
    expect(skillOk('F#', 'F#')).toBe(true);
  });

  it('splits on + only with a space on both sides', () => {
    expect(skillOk('SQL + Python', 'SQL', 'Python')).toBe(true);
    expect(skillOk('SQL+Python', 'SQL', 'Python')).toBe(false);
    expect(skillOk('C++ + Python', 'C++', 'Python')).toBe(true);
  });

  it.each(['SQL – Python', 'SQL: Python', 'SQL · Python', 'SQL - Python', 'SQL — Python'])(
    'splits "%s" into two parts',
    (label) => {
      expect(skillOk(label, 'SQL', 'Python')).toBe(true);
      expect(skillOk(label, 'SQL')).toBe(false);
    },
  );
});

describe('contact allowance comes from the fact text, not its evidence', () => {
  const bullet = (text: string, factText: string, evidence: string) => {
    const facts = CV_FACTS.map((fact) =>
      fact.id === 'fact-clients' ? { ...fact, text: factText, evidence } : fact,
    );
    const cv = edited((c) => {
      at(c.experience, 0).bullets[0] = { text, factRefs: [aliasOf('fact-clients')] };
    });
    return check(cv, facts);
  };

  it('refuses a token only the evidence has, and allows one the text has', () => {
    const text = 'Led onboarding for 12 clients on Booking.com.';
    expect(
      bullet(text, 'Led onboarding for 12 clients', 'Led onboarding for 12 clients on Booking.com'),
    ).toEqual({
      ok: false,
      issues: [{ path: 'experience[0].bullets[0]', code: 'contact_in_text' }],
    });
    expect(
      bullet(text, 'Led onboarding for 12 clients on Booking.com', 'Led onboarding for 12 clients'),
    ).toEqual({ ok: true });
  });
});

describe('org suffixes and NFC', () => {
  it.each(['plc', 'LLC', 'GmbH', 'llp'])('accepts "Example Cloud %s" as the org', (suffix) => {
    expect(check(heading('Customer Onboarding Intern', `Example Cloud ${suffix}`))).toEqual({
      ok: true,
    });
  });

  it('prints a decomposed é, normalised to NFC, instead of unsupported_char', () => {
    const cv = edited((c) => {
      c.summary.text = 'Café onboarding lead who cut client time-to-live by 30%.';
    });
    expect(check(cv)).toEqual({ ok: true });
  });

  it('still refuses a character with no precomposed WinAnsi form', () => {
    const cv = edited((c) => {
      c.summary.text = 'Onboarding lead who cut client time-to-live by 30% ́́ α.';
    });
    expect(issuesOf(cv)).toContainEqual({ path: 'summary', code: 'unsupported_char' });
  });
});

describe('normaliseCvText', () => {
  it('writes every text in NFC, so what is stored is what was checked and can be printed', () => {
    const cv = edited((c) => {
      c.summary.text = 'Café lead.';
      at(c.experience, 0).heading.org = 'Café Cloud';
    });
    const out = normaliseCvText(cv);
    expect(out.summary.text).toBe('Café lead.');
    expect(at(out.experience, 0).heading.org).toBe('Café Cloud');
    expect(isPrintable(out.summary.text)).toBe(true);
    expect(cv.summary.text).toBe('Café lead.');
    expect(normaliseCvText(validCv())).toEqual(validCv());
  });
});

describe('validateCv cost', () => {
  it('validates content at 4x the shape limits with 32 refs per text in under 1500 ms', () => {
    const refs = Array.from({ length: CV_LIMITS.refs * 4 }, (_, i) =>
      aliasOf(['fact-clients', 'fact-ttl', 'fact-articles', 'fact-sql'][i % 4] ?? 'fact-sql'),
    );
    const long = (n: number) =>
      'Led onboarding for 12 clients and cut time by 30% with SQL. '.repeat(40).slice(0, n);
    // Facts with long text and evidence, so the figure and word reads are not trivial.
    const facts = CV_FACTS.map((fact) => ({
      ...fact,
      text: `${fact.text}. ${long(1500)}`,
      evidence: `${fact.evidence}. ${long(1500)}`,
    }));
    const cited = (max: number) => ({ text: long(max * 4), factRefs: refs });
    const entry = {
      heading: {
        role: long(CV_LIMITS.role * 4),
        org: long(CV_LIMITS.org * 4),
        factRef: aliasOf('fact-intern'),
      },
      bullets: Array.from({ length: CV_LIMITS.bulletsPerEntry * 4 }, () => cited(CV_LIMITS.bullet)),
    };
    const cv: CvContent = {
      summary: cited(CV_LIMITS.summary),
      experience: Array.from({ length: CV_LIMITS.experienceEntries * 4 }, () => entry),
      projects: Array.from({ length: CV_LIMITS.projectEntries * 4 }, () => entry),
      education: Array.from({ length: CV_LIMITS.educationEntries * 4 }, () => ({
        line: long(CV_LIMITS.educationLine * 4),
        factRef: aliasOf('fact-scrum'),
      })),
      skills: Array.from({ length: CV_LIMITS.skills * 4 }, () => ({
        label: long(CV_LIMITS.skillLabel * 4),
        factRefs: refs,
      })),
      coverNote: {
        paragraphs: Array.from({ length: CV_LIMITS.noteParagraphsMax * 4 }, () =>
          cited(CV_LIMITS.noteParagraph),
        ),
      },
    };
    const started = performance.now();
    const result = validateCv(cv, CV_ALIASES, facts);
    const elapsed = performance.now() - started;
    expect(result.ok).toBe(false);
    // Local is about 86 ms, the uncached version was about 2.7 s, CI runs about 4x slower.
    expect(elapsed).toBeLessThan(1500);
  });

  it('reports 32 refs on one text as too_long, whatever they repeat', () => {
    const cv = edited((c) => {
      c.summary.factRefs = Array.from({ length: 32 }, () => aliasOf('fact-ttl'));
    });
    expect(issuesOf(cv)).toContainEqual({ path: 'summary', code: 'too_long' });
  });
});

describe('rules no other test pins', () => {
  const factsWith = (id: string, text: string, evidence = text) =>
    CV_FACTS.map((fact) => (fact.id === id ? { ...fact, text, evidence } : fact));

  it('skips personal, of and and in a heading, and each is the only difference', () => {
    expect(check(heading('Personal Customer Onboarding Intern', 'Example Cloud'))).toEqual({
      ok: true,
    });
    expect(check(heading('Intern of Customer Onboarding', 'Example Cloud'))).toEqual({ ok: true });
    expect(check(heading('Customer and Onboarding Intern', 'Example Cloud'))).toEqual({ ok: true });
    // Control: a word that is not skipped is refused in the same place.
    expect(issuesOf(heading('Senior Customer Onboarding Intern', 'Example Cloud'))).toEqual([
      { path: 'experience[0].heading.role', code: 'unsupported_text' },
    ]);
  });

  it.each([
    ['&', 'SQL & Python'],
    ['+', 'SQL + Python'],
    ['|', 'SQL | Python'],
    [';', 'SQL; Python'],
    ['(', 'SQL (Python)'],
    ['•', 'SQL • Python'],
    ['or', 'SQL or Python'],
    ['and', 'SQL and Python'],
    [',', 'SQL, Python'],
    ['/', 'SQL/Python'],
  ])('splits a skill label at %s', (_, label) => {
    expect(skillOk(label, 'SQL', 'Python')).toBe(true);
    expect(skillOk(label, 'SQL')).toBe(false);
  });

  it('does not let a fact with Booking.com.au allow Booking.com', () => {
    const cv = edited((c) => {
      at(c.experience, 0).bullets[0] = {
        text: 'Led onboarding for 12 clients on Booking.com.',
        factRefs: [aliasOf('fact-clients')],
      };
    });
    const facts = factsWith('fact-clients', 'Led onboarding for 12 clients on Booking.com.au');
    expect(issuesOf(cv, facts)).toContainEqual({
      path: 'experience[0].bullets[0]',
      code: 'contact_in_text',
    });
  });

  it('accepts "Booking.com." at the end of a sentence when the fact has it', () => {
    const cv = edited((c) => {
      at(c.experience, 0).bullets[0] = {
        text: 'Led onboarding for 12 clients on Booking.com.',
        factRefs: [aliasOf('fact-clients')],
      };
    });
    const facts = factsWith('fact-clients', 'Led onboarding for 12 clients on Booking.com');
    expect(check(cv, facts)).toEqual({ ok: true });
  });

  it('reads "ten per cent" as 10 percent', () => {
    const bullet = (text: string) =>
      edited((c) => {
        at(c.experience, 0).bullets[1] = { text, factRefs: [aliasOf('fact-ttl')] };
      });
    expect(issuesOf(bullet('Cut client time-to-live by ten per cent.'))).toEqual([
      { path: 'experience[0].bullets[1]', code: 'unsupported_number' },
    ]);
    const facts = factsWith('fact-ttl', 'Cut client time-to-live by 10 per cent');
    const left = issuesOf(bullet('Cut client time-to-live by ten per cent.'), facts);
    expect(left.filter((issue) => issue.path === 'experience[0].bullets[1]')).toEqual([]);
  });
});

describe('factEndKey and orderEntries', () => {
  it('keys a month, a bare year as its December, and present or no end date after everything', () => {
    expect(factEndKey({ start: '2023-10', end: '2024-05' })).toBe('2024-05');
    expect(factEndKey({ end: '2024' })).toBe('2024-12');
    expect(factEndKey({ start: '2024-01', end: 'present' })).toBe('9999-12');
    expect(factEndKey({ start: '2024-01' })).toBe('9999-12');
    expect(factEndKey({})).toBe('9999-12');
    expect(factEndKey(undefined)).toBe('9999-12');
    expect(factEndKey({ end: '2024-05' }) < factEndKey({ end: '2024' })).toBe(true);
  });

  const ends: Record<string, string> = { F1: '2022-06', F2: '2024-05', F3: '9999-12', F4: '2024' };
  const endKeyOf = (ref: string) => ends[ref] ?? '9999-12';
  const entry = (role: string, factRef: string) => ({
    heading: { role, org: 'Org', factRef },
    bullets: [],
  });

  it('sorts experience, projects and education newest first, ties in the model order', () => {
    const content = {
      ...validCv(),
      experience: [entry('old', 'F1'), entry('current', 'F3'), entry('mid', 'F2')],
      projects: [entry('p-old', 'F1'), entry('p-new', 'F2')],
      education: [
        { line: 'older', factRef: 'F1' },
        { line: 'newer', factRef: 'F2' },
      ],
    };
    const ordered = orderEntries(content, endKeyOf);
    expect(ordered.experience.map((e) => e.heading.role)).toEqual(['current', 'mid', 'old']);
    expect(ordered.projects.map((e) => e.heading.role)).toEqual(['p-new', 'p-old']);
    expect(ordered.education.map((e) => e.line)).toEqual(['newer', 'older']);

    const tied = {
      ...content,
      experience: [entry('b', 'F2'), entry('a', 'F2'), entry('c', 'F2')],
    };
    expect(orderEntries(tied, endKeyOf).experience.map((e) => e.heading.role)).toEqual([
      'b',
      'a',
      'c',
    ]);
  });

  it('does not mutate its input or touch the bullets, summary and skills', () => {
    const content = { ...validCv(), experience: [entry('x', 'F1'), entry('y', 'F2')] };
    const before = structuredClone(content);
    const ordered = orderEntries(content, endKeyOf);
    expect(content).toEqual(before);
    expect(ordered.summary).toEqual(content.summary);
    expect(ordered.skills).toEqual(content.skills);
    expect(ordered.coverNote).toEqual(content.coverNote);
  });
});

describe('scrubDashes', () => {
  const scrub = (text: string) =>
    scrubDashes({ ...validCv(), summary: { text, factRefs: ['F1'] } });
  const text = (value: string) => scrub(value).content.summary.text;

  it('turns a spaced em or en dash into a comma and an unspaced one into a hyphen', () => {
    expect(text('Built dashboards \u2014 and trained users')).toBe(
      'Built dashboards, and trained users',
    );
    expect(text('Built dashboards \u2013 and trained users')).toBe(
      'Built dashboards, and trained users',
    );
    expect(text('data\u2014driven and 2019\u20132021')).toBe('data-driven and 2019-2021');
  });

  it('leaves no doubled punctuation and no dash at an edge', () => {
    expect(text('Done. \u2014 Then more')).toBe('Done. Then more');
    expect(text('One \u2014, two')).toBe('One, two');
    expect(text('Two \u2014. Three')).toBe('Two. Three');
    expect(text('\u2014 starts here')).toBe('starts here');
    expect(text('ends here \u2014')).toBe('ends here');
  });

  it('counts what it replaced and reports 0 when there is nothing', () => {
    expect(scrub('a \u2014 b \u2013 c d\u2014e').replaced).toBe(3);
    const clean = scrub('Nothing to see, here.');
    expect(clean.replaced).toBe(0);
    expect(clean.content).toEqual({
      ...validCv(),
      summary: { text: 'Nothing to see, here.', factRefs: ['F1'] },
    });
  });

  it('leaves text without a dash byte for byte, including "e.g.," and hyphens', () => {
    expect(text('Used SQL, e.g., joins - and time-to-live: 30%.')).toBe(
      'Used SQL, e.g., joins - and time-to-live: 30%.',
    );
  });

  it('does not mutate its input, and leaves citations alone', () => {
    const content = validCv();
    const before = structuredClone(content);
    const { content: out } = scrubDashes(content);
    expect(content).toEqual(before);
    expect(out.summary.factRefs).toEqual(content.summary.factRefs);
  });

  it('keeps figures, skill label parts and headings valid: validateCv still passes', () => {
    const content = validCv();
    content.summary.text =
      'Customer-facing analyst \u2014 cut client time-to-live by 30% \u2013 and wrote clear documentation.';
    content.skills = [
      { label: 'SQL \u2014 Python', factRefs: [aliasOf('fact-sql'), aliasOf('fact-python')] },
    ];
    expect(check(content).ok).toBe(true);
    const { content: scrubbed, replaced } = scrubDashes(content);
    expect(replaced).toBe(3);
    expect(scrubbed.summary.text).toBe(
      'Customer-facing analyst, cut client time-to-live by 30%, and wrote clear documentation.',
    );
    expect(scrubbed.skills[0]?.label).toBe('SQL, Python');
    expect(check(scrubbed)).toEqual({ ok: true });
    expect(figuresIn(scrubbed.summary.text)).toEqual(figuresIn(content.summary.text));
  });

  it('works on trimmed content (a null summary) too', () => {
    const trimmed = applyTrim(validCv(), trimOrder(validCv()).length);
    expect(scrubDashes(trimmed).content).toEqual(trimmed);
  });
});

describe('a project with no organisation', () => {
  const noOrg = (section: 'projects' | 'experience') =>
    edited((cv) => {
      at(cv[section], 0).heading.org = '';
    });

  it('is allowed in the strict and the loose schema, and by validateCv', () => {
    const cv = noOrg('projects');
    expect(CvContentSchema.safeParse(cv).success).toBe(true);
    expect(CvContentShapeSchema.safeParse(cv).success).toBe(true);
    expect(check(cv)).toEqual({ ok: true });
  });

  it('is still refused on an experience entry, as too_long on the org', () => {
    const cv = noOrg('experience');
    expect(CvContentSchema.safeParse(cv).success).toBe(false);
    expect(issuesOf(cv)).toEqual([{ path: 'experience[0].heading.org', code: 'too_long' }]);
  });

  it('still needs a real role word from the fact, and a project org of whitespace is allowed', () => {
    const cv = edited((c) => {
      at(c.projects, 0).heading = { role: 'Rocket', org: '  ', factRef: aliasOf('fact-olist') };
    });
    expect(issuesOf(cv)).toEqual([{ path: 'projects[0].heading.role', code: 'unsupported_text' }]);
  });
});

describe('an education line citing a classification', () => {
  const DEGREE: CvFact = {
    id: 'fact-degree',
    type: 'education',
    text: 'BSc Business Information Systems, Example University',
    evidence: 'BSc Business Information Systems, Example University',
    status: 'active',
  };
  const HONOURS: CvFact = {
    id: 'fact-honours',
    type: 'achievement',
    text: 'Graduated with First Class Honours',
    evidence: 'First Class Honours',
    status: 'active',
  };
  const facts = [...CV_FACTS, DEGREE, HONOURS];
  const aliases = new Map([...CV_ALIASES, ['F10', 'fact-degree'], ['F11', 'fact-honours']]);
  const line = (edit: (entry: CvContent['education'][number]) => void): CvContent =>
    edited((cv) => {
      cv.education = [{ line: 'BSc Business Information Systems', factRef: 'F10' }];
      edit(at(cv.education, 0));
    });
  const verdict = (content: CvContent) => validateCv(content, aliases, facts);
  const issuesOfVerdict = (result: ReturnType<typeof verdict>): CvIssue[] =>
    result.ok ? [] : result.issues;

  it('may cite one education fact plus one achievement, and the word check uses both', () => {
    const both = line((e) => {
      e.line = 'BSc Business Information Systems, First Class Honours';
      e.achievementRef = 'F11';
    });
    expect(verdict(both)).toEqual({ ok: true });
    expect(CvContentSchema.safeParse(both).success).toBe(true);
    expect(citedFactIds(both, aliases)).toEqual(
      expect.arrayContaining(['fact-degree', 'fact-honours']),
    );
  });

  it("refuses an unrelated award and its figure, and another degree's classification", () => {
    const MSC: CvFact = {
      id: 'fact-msc',
      type: 'achievement',
      text: 'Awarded a Distinction for the MSc dissertation',
      evidence: 'Distinction, MSc dissertation',
      status: 'active',
    };
    const PRIZE: CvFact = {
      id: 'fact-prize',
      type: 'achievement',
      text: 'Won first prize at a 60-person hackathon with a fraud-detection model',
      evidence: 'first prize, 60-person hackathon',
      status: 'active',
    };
    const BA: CvFact = {
      id: 'fact-ba',
      type: 'education',
      text: 'BSc Economics, Example University',
      evidence: 'BSc Economics, Example University',
      status: 'active',
    };
    const many = [...facts, MSC, PRIZE, BA];
    const manyAliases = new Map([
      ...aliases,
      ['F12', 'fact-msc'],
      ['F13', 'fact-prize'],
      ['F14', 'fact-ba'],
    ]);
    const check = (text: string, ref: string) =>
      validateCv(
        edited((cv) => {
          cv.education = [{ line: text, factRef: 'F14', achievementRef: ref }];
        }),
        manyAliases,
        many,
      );
    expect(check('BSc Economics, Example University, Distinction', 'F12')).toMatchObject({
      ok: false,
    });
    expect(
      issuesOfVerdict(check('BSc Economics, first prize, 60-person hackathon', 'F13')),
    ).toContainEqual({ path: 'education[0]', code: 'unsupported_text' });
  });

  describe('the degree-token rule', () => {
    const fact = (id: string, type: CvFact['type'], text: string): CvFact => ({
      id,
      type,
      text,
      evidence: text,
      status: 'active',
    });
    const MSC_DEGREE = fact('fact-msc-degree', 'education', 'MSc Data Science, Example University');
    const CERTS = [
      fact('fact-cert-a', 'education', 'Google Data Analytics Certificate'),
      fact('fact-cert-b', 'education', 'Scrum Fundamentals Certificate'),
    ];
    const run = (extra: CvFact[], achievement: CvFact, factRef: string, text: string) =>
      validateCv(
        edited((cv) => {
          cv.education = [{ line: text, factRef, achievementRef: 'F20' }];
        }),
        new Map([...aliases, ['F20', achievement.id], ['F21', MSC_DEGREE.id]]),
        [...facts, ...extra, achievement],
      );

    it('(a) passes a BSc, two certificates and an honours achievement naming no degree', () => {
      expect(
        run(CERTS, HONOURS, 'F10', 'BSc Business Information Systems, First Class Honours'),
      ).toEqual({ ok: true });
    });

    it('(b) refuses an achievement that names neither of two degrees and shares no year', () => {
      const other = fact('fact-other', 'achievement', 'Graduated with Merit');
      expect(
        issuesOfVerdict(run([MSC_DEGREE], other, 'F10', 'BSc Business Information Systems, Merit')),
      ).toContainEqual({ path: 'education[0]', code: 'wrong_fact_type' });
    });

    it('(c) passes "MSc with Distinction" on the MSc line', () => {
      const distinction = fact('fact-dist', 'achievement', 'MSc with Distinction');
      expect(run([MSC_DEGREE], distinction, 'F21', 'MSc Data Science, Distinction')).toEqual({
        ok: true,
      });
    });
  });

  it('refuses the classification words when the achievement is not cited', () => {
    const alone = line((e) => {
      e.line = 'BSc Business Information Systems, First Class Honours';
    });
    expect(verdict(alone)).toEqual({
      ok: false,
      issues: [{ path: 'education[0]', code: 'unsupported_text' }],
    });
  });

  it('takes the second ref as an achievement only', () => {
    const wrong = line((e) => {
      e.achievementRef = 'F8';
    });
    expect(issuesOfVerdict(verdict(wrong))).toContainEqual({
      path: 'education[0]',
      code: 'wrong_fact_type',
    });
    const twoEducation = line((e) => {
      e.achievementRef = 'F7';
    });
    expect(issuesOfVerdict(verdict(twoEducation))).toContainEqual({
      path: 'education[0]',
      code: 'wrong_fact_type',
    });
    // The first ref may not be the achievement.
    const swapped = line((e) => {
      e.factRef = 'F11';
      e.achievementRef = 'F10';
    });
    expect(verdict(swapped)).toMatchObject({ ok: false });
  });

  it('counts an unknown achievement alias, and an empty one as no citation', () => {
    const unknown = line((e) => {
      e.achievementRef = 'F99';
    });
    expect(verdict(unknown)).toEqual({
      ok: false,
      issues: [{ path: 'education[0]', code: 'unknown_fact' }],
    });
    const empty = line((e) => {
      e.achievementRef = '';
    });
    expect(verdict(empty)).toEqual({ ok: true });
  });

  it('keeps old docs with a single factRef parsing, in both schemas', () => {
    const old = edited(() => undefined);
    expect(at(old.education, 0)).not.toHaveProperty('achievementRef');
    expect(CvContentSchema.safeParse(old).success).toBe(true);
    expect(CvContentShapeSchema.safeParse(old).success).toBe(true);
    const doc = CvDocSchema.safeParse({
      jobId: 'job-1',
      applicationVersion: 1,
      content: { ...old, summary: null },
      aliases: Object.fromEntries(CV_ALIASES),
      factIds: [],
      storagePaths: { cvPdf: 'a', cvDocx: 'b', notePdf: 'c', noteDocx: 'd' },
      trimmed: 0,
      model: 'claude-sonnet-5-5',
      costPence: 1,
      createdAt: new Date(),
      schemaVersion: 1,
    });
    expect(doc.success).toBe(true);
  });

  it('refuses a third key on the line, so there is still no free text', () => {
    const bad = {
      ...validCv(),
      education: [{ line: 'x', factRef: 'F7', achievementRefs: ['F1'] }],
    };
    expect(CvContentShapeSchema.safeParse(bad).success).toBe(false);
  });
});

describe('education order and dates', () => {
  const dated = new Map([
    ['F1', { start: '2021', end: '2024' }],
    ['F2', { end: '2022-06' }],
    ['F3', { start: '2023' }],
    ['F4', {}],
    ['F5', { start: '2024', end: 'present' }],
  ]);
  const line = (name: string, factRef: string) => ({ line: name, factRef });
  const keyOf = (ref: string) => factEndKey(dated.get(ref));
  const hasEnd = (ref: string) => dated.get(ref)?.end !== undefined;
  const order = (content: CvContent['education']) =>
    orderEntries({ ...validCv(), education: content }, keyOf, hasEnd).education.map((e) => e.line);

  it('puts dated lines first, newest first, then start-only and undated in the model order', () => {
    expect(
      order([
        line('start-only', 'F3'),
        line('older', 'F2'),
        line('undated', 'F4'),
        line('newer', 'F1'),
        line('still studying', 'F5'),
      ]),
    ).toEqual(['still studying', 'newer', 'older', 'start-only', 'undated']);
    expect(order([line('undated', 'F4'), line('start-only', 'F3')])).toEqual([
      'undated',
      'start-only',
    ]);
  });

  it('keeps the model order among equal end dates', () => {
    expect(order([line('b', 'F1'), line('a', 'F1')])).toEqual(['b', 'a']);
  });

  it('treats every line as dated when no end check is given (the old behaviour)', () => {
    const content = { ...validCv(), education: [line('start-only', 'F3'), line('older', 'F2')] };
    expect(orderEntries(content, keyOf).education.map((e) => e.line)).toEqual([
      'start-only',
      'older',
    ]);
  });

  it('shows the year only, and never "- Present"', () => {
    expect(formatEducationDates({ start: '2021', end: '2024' })).toBe('2024');
    expect(formatEducationDates({ start: '2023-10', end: '2024-05' })).toBe('2024');
    expect(formatEducationDates({ start: '2023' })).toBe('2023');
    expect(formatEducationDates({ start: '2023-10' })).toBe('2023');
    expect(formatEducationDates({ end: '2024' })).toBe('2024');
    expect(formatEducationDates({ start: '2024', end: 'present' })).toBe('Present');
    expect(formatEducationDates({})).toBe('');
    // Experience keeps its range, and "no end date = Present".
    expect(formatFactDates({ start: '2023-10' })).toBe('Oct 2023 – Present');
  });
});

describe('clampCvCounts', () => {
  const bullet = (i: number) => ({ text: `Bullet ${String(i)}`, factRefs: ['F1'] });
  const entry = (bullets: number) => ({
    heading: { role: 'Role', org: 'Org', factRef: 'F1' },
    bullets: Array.from({ length: bullets }, (_, i) => bullet(i)),
  });
  const big = (): CvContent => ({
    ...validCv(),
    experience: Array.from({ length: 6 }, () => entry(7)),
    projects: Array.from({ length: 5 }, () => entry(6)),
    education: Array.from({ length: 5 }, (_, i) => ({ line: `Line ${String(i)}`, factRef: 'F1' })),
    skills: Array.from({ length: 20 }, (_, i) => ({
      label: `Skill ${String(i)}`,
      factRefs: ['F1'],
    })),
    coverNote: {
      paragraphs: Array.from({ length: 6 }, (_, i) => ({
        text: `P${String(i)}`,
        factRefs: ['F1'],
      })),
    },
  });

  it('cuts every count to its limit, from the end', () => {
    const clamped = clampCvCounts(big());
    expect(clamped.experience).toHaveLength(CV_LIMITS.experienceEntries);
    expect(clamped.projects).toHaveLength(CV_LIMITS.projectEntries);
    expect(clamped.education).toHaveLength(CV_LIMITS.educationEntries);
    expect(clamped.skills).toHaveLength(CV_LIMITS.skills);
    expect(clamped.coverNote.paragraphs).toHaveLength(CV_LIMITS.noteParagraphsMax);
    for (const e of [...clamped.experience, ...clamped.projects]) {
      expect(e.bullets.map((b) => b.text)).toEqual([
        'Bullet 0',
        'Bullet 1',
        'Bullet 2',
        'Bullet 3',
        'Bullet 4',
      ]);
    }
    expect(clamped.skills.at(-1)?.label).toBe('Skill 15');
  });

  it('only removes: counts under the limits, the summary and the texts stay as they are', () => {
    const small = validCv();
    expect(clampCvCounts(small)).toEqual(small);
    const clamped = clampCvCounts(big());
    expect(clamped.summary).toEqual(big().summary);
    // Every kept item is the original item at the same place, so nothing was added or rewritten.
    expect(clamped.skills).toEqual(big().skills.slice(0, CV_LIMITS.skills));
    expect(clamped.experience[0]?.heading).toEqual(big().experience[0]?.heading);
  });

  it('does not mutate its input, and a clamped output passes the count checks', () => {
    const input = big();
    const before = structuredClone(input);
    const clamped = clampCvCounts(input);
    expect(input).toEqual(before);
    const counts = (check(clamped) as { issues?: CvIssue[] }).issues ?? [];
    expect(counts.filter((i) => i.code === 'too_long')).toEqual([]);
  });
});

describe('dropUnsupportedSkills', () => {
  const sql = aliasOf('fact-sql');
  const python = aliasOf('fact-python');
  const intern = aliasOf('fact-intern');
  const withSkills = (skills: CvContent['skills']): CvContent => ({ ...validCv(), skills });

  it('drops a skill with no citation and one citing a fact that is not a skill', () => {
    const cv = withSkills([
      { label: 'SQL', factRefs: [sql] },
      { label: 'Zendesk', factRefs: [intern] },
      { label: 'Excel', factRefs: [] },
      { label: 'Python', factRefs: [python] },
      { label: 'Mixed', factRefs: [sql, intern] },
    ]);
    const { content, dropped } = dropUnsupportedSkills(cv, CV_ALIASES, CV_FACTS);
    expect(content.skills.map((skill) => skill.label)).toEqual(['SQL', 'Python']);
    expect(dropped).toBe(3);
    // Removal only: nothing else changed, and the input is untouched.
    expect(content.experience).toEqual(cv.experience);
    expect(cv.skills).toHaveLength(5);
  });

  it('leaves an unresolvable citation for the validator, and returns the same object when none go', () => {
    const cv = withSkills([
      { label: 'SQL', factRefs: [sql] },
      { label: 'Unknown', factRefs: ['F999'] },
    ]);
    const result = dropUnsupportedSkills(cv, CV_ALIASES, CV_FACTS);
    expect(result.dropped).toBe(0);
    expect(result.content).toBe(cv);
    expect(check(result.content).ok).toBe(false);
  });

  it('turns a list of only unsupported skills into an empty one, which still validates', () => {
    const { content } = dropUnsupportedSkills(
      withSkills([{ label: 'Zendesk', factRefs: [intern] }]),
      CV_ALIASES,
      CV_FACTS,
    );
    expect(content.skills).toEqual([]);
    expect(check(content).ok).toBe(true);
  });
});
