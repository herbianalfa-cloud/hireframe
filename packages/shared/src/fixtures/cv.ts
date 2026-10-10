import type { CvContent, CvFact } from '../cv.js';
import type { JobRequirement } from '../funnel.js';

/**
 * Fake candidate facts and a valid CV for the validator and trim tests (M7). The facts are a
 * subset of the fake CV in functions/src/fixtures; nothing here is a real person's data.
 */
export const CV_FACTS: readonly CvFact[] = [
  {
    id: 'fact-intern',
    type: 'experience',
    text: 'Customer Onboarding Intern at Example Cloud Ltd',
    evidence: 'Customer Onboarding Intern, Example Cloud Ltd, London',
    status: 'active',
  },
  {
    id: 'fact-clients',
    type: 'experience',
    text: 'Led onboarding for 12 clients',
    evidence: 'Led onboarding for 12 clients',
    status: 'active',
  },
  {
    id: 'fact-ttl',
    type: 'metric',
    text: 'Cut client time-to-live by 30%',
    evidence: 'cut time-to-live by 30%',
    status: 'active',
  },
  {
    id: 'fact-articles',
    type: 'metric',
    text: 'Wrote 25 help-centre articles for the self-serve setup flow',
    evidence: 'Wrote 25 help-centre articles for the self-serve setup flow',
    status: 'active',
  },
  {
    id: 'fact-olist',
    type: 'project',
    text: 'Olist e-commerce analysis',
    evidence: 'Olist e-commerce analysis (2024)',
    status: 'active',
  },
  {
    id: 'fact-scrum',
    type: 'education',
    text: 'Scrum Fundamentals Certificate',
    evidence: 'Scrum Fundamentals Certificate (2024)',
    status: 'active',
  },
  { id: 'fact-sql', type: 'skill', text: 'SQL', evidence: 'SQL', status: 'active' },
  { id: 'fact-python', type: 'skill', text: 'Python', evidence: 'Python', status: 'active' },
  {
    id: 'fact-old',
    type: 'metric',
    text: 'Ran a pilot with 8 customers',
    evidence: 'ran a pilot with 8 customers',
    status: 'archived',
  },
];

/** The aliases the model saw: `F1`… in factId order (shared/score.ts `factAliases`). */
export const CV_ALIASES: ReadonlyMap<string, string> = new Map(
  [...CV_FACTS]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((fact, i) => [`F${String(i + 1)}`, fact.id]),
);

export function aliasOf(factId: string): string {
  for (const [alias, id] of CV_ALIASES) if (id === factId) return alias;
  throw new Error(`no alias for ${factId}`);
}

const a = aliasOf;

/** A valid CV: every text cites a fact it can be traced to, every figure is in a cited fact. */
export function validCv(): CvContent {
  return {
    summary: {
      text: 'Customer-facing analyst who cut client time-to-live by 30% and writes clear documentation.',
      factRefs: [a('fact-ttl'), a('fact-articles')],
    },
    experience: [
      {
        heading: {
          role: 'Customer Onboarding Intern',
          org: 'Example Cloud Ltd',
          factRef: a('fact-intern'),
        },
        bullets: [
          { text: 'Led onboarding for 12 clients.', factRefs: [a('fact-clients')] },
          { text: 'Cut client time-to-live by 30%.', factRefs: [a('fact-ttl')] },
          {
            text: 'Wrote 25 help-centre articles for the self-serve setup flow.',
            factRefs: [a('fact-articles')],
          },
        ],
      },
    ],
    projects: [
      {
        heading: {
          role: 'Analysis project',
          org: 'Olist e-commerce analysis',
          factRef: a('fact-olist'),
        },
        bullets: [
          {
            text: 'Analysed an e-commerce dataset with SQL.',
            factRefs: [a('fact-olist'), a('fact-sql')],
          },
        ],
      },
    ],
    education: [{ line: 'Scrum Fundamentals Certificate', factRef: a('fact-scrum') }],
    skills: [
      { label: 'SQL', factRefs: [a('fact-sql')] },
      { label: 'Python', factRefs: [a('fact-python')] },
    ],
    coverNote: {
      paragraphs: [
        {
          text: 'I would like to apply for the role. I led onboarding for 12 clients.',
          factRefs: [a('fact-clients')],
        },
        {
          text: 'I cut client time-to-live by 30% and enjoy clear writing.',
          factRefs: [a('fact-ttl')],
        },
      ],
    },
  };
}

/**
 * A CV with every count at its ceiling (4 experience entries of 5, 5, 4 and 2 bullets, 3
 * projects, 16 skills) for the `trimOrder` tests. The texts are a few short words and its
 * headings are 'Role' and 'Org', so it does NOT pass `validateCv` (`unsupported_text`); it
 * cites facts that exist and is only for counts, not for wrapping or the validator.
 */
export function fullCv(): CvContent {
  const bullet = (n: number) => ({
    text: `Bullet number ${String(n)}`.replace(/\d/g, ''),
    factRefs: [a('fact-clients')],
  });
  const entry = (bullets: number) => ({
    heading: { role: 'Role', org: 'Org', factRef: a('fact-intern') },
    bullets: Array.from({ length: bullets }, (_, i) => bullet(i)),
  });
  return {
    ...validCv(),
    experience: [entry(5), entry(5), entry(4), entry(2)],
    projects: [entry(2), entry(1), entry(1)],
    skills: Array.from({ length: 16 }, (_, i) => ({
      label: `Skill ${'abcdefghijklmnop'[i] ?? ''}`,
      factRefs: [a('fact-sql')],
    })),
  };
}

/** S3 requirements for the question tests: invented, in the shape the funnel stores. */
export function requirement(text: string, overrides: Partial<JobRequirement> = {}): JobRequirement {
  return {
    text,
    level: 'must',
    type: 'skill',
    match: 'missing',
    gap: 'tool',
    factIds: [],
    ...overrides,
  };
}

/** The item at `index`, or a failing test: stands in for `items[index]!` in tests. */
export function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at ${String(index)}`);
  return item;
}
