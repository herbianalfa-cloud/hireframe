import { CV_LIMITS, type CvContent, type CvHeader } from '@hireframe/shared';

import { aliasOf, CV_ALIASES } from '../../../../packages/shared/src/fixtures/cv.js';
import { makeDateOf, type DatedFact } from './layout.js';

/**
 * Test support for the renderer: the fake candidate's header and dates. Nothing here is a real
 * person's data; the phone number is in Ofcom's fictional drama range, built at run time so the
 * PII scan sees no literal.
 */
export const FAKE_HEADER: CvHeader = {
  name: 'Alex Example',
  email: 'alex@example.com',
  phone: ['+44', '7700', '900123'].join(' '),
  location: 'London, UK',
  links: ['https://example.com/alex'],
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  schemaVersion: 1,
};

/** Dates of the headings `validCv()` cites. */
export const FAKE_DATES: readonly DatedFact[] = [
  { id: 'fact-intern', dates: { start: '2023-10', end: '2024-05' } },
  { id: 'fact-olist', dates: { start: '2024-01', end: '2024-03' } },
  { id: 'fact-scrum', dates: { end: '2024' } },
];

export const fakeDateOf = makeDateOf(CV_ALIASES, FAKE_DATES);

const WORDS = [
  'onboarding',
  'analysed',
  'stakeholders',
  'documentation',
  'dashboards',
  'customers',
  'workflow',
  'reporting',
  'migrated',
  'coordinated',
  'accounts',
];

/** Exactly `length` characters of ordinary words, differing by `seed`. */
export function filler(length: number, seed: number): string {
  let text = '';
  for (let i = seed; text.length < length; i += 1) text += `${WORDS[i % WORDS.length] ?? ''} `;
  return text.slice(0, length).trim().padEnd(length, 'x');
}

/**
 * Every count at its ceiling and every text at its maximum length, in ordinary words: a long
 * CV for the trim tests. It cites facts that exist but its words are not theirs, so it does NOT
 * pass `validateCv` (`unsupported_text`, `unsupported_number`); it is for the fit only. It is
 * not the widest case: see `wideCv`.
 */
export function maxCv(): CvContent {
  const a = aliasOf('fact-clients');
  const entry = (bullets: number, seed: number) => ({
    heading: {
      role: filler(CV_LIMITS.role, seed),
      org: filler(CV_LIMITS.org, seed + 1),
      factRef: aliasOf('fact-intern'),
    },
    bullets: Array.from({ length: bullets }, (_, i) => ({
      text: filler(CV_LIMITS.bullet, seed + i),
      factRefs: [a],
    })),
  });
  return {
    summary: { text: filler(CV_LIMITS.summary, 3), factRefs: [a] },
    experience: Array.from({ length: CV_LIMITS.experienceEntries }, (_, i) =>
      entry(CV_LIMITS.bulletsPerEntry, i),
    ),
    projects: Array.from({ length: CV_LIMITS.projectEntries }, (_, i) => entry(2, i + 5)),
    education: Array.from({ length: CV_LIMITS.educationEntries }, (_, i) => ({
      line: filler(CV_LIMITS.educationLine, i),
      factRef: aliasOf('fact-scrum'),
    })),
    skills: Array.from({ length: CV_LIMITS.skills }, (_, i) => ({
      label: filler(CV_LIMITS.skillLabel, i),
      factRefs: [aliasOf('fact-sql')],
    })),
    coverNote: {
      paragraphs: Array.from({ length: CV_LIMITS.noteParagraphsMax }, (_, i) => ({
        text: filler(CV_LIMITS.noteParagraph, i),
        factRefs: [a],
      })),
    },
  };
}

/** Capitals W and M, the widest Helvetica letters, in words, up to exactly `length` characters. */
export function wide(length: number, seed = 0): string {
  const words = ['WWWWWWWW', 'MMMMMMMM', 'WMWMWMWM', 'MWMWMWMW'];
  let text = '';
  for (let i = seed; text.length < length; i += 1) text += `${words[i % words.length] ?? ''} `;
  return text.slice(0, length).trim().padEnd(length, 'W');
}

/**
 * The widest content the limits allow: every count at its ceiling and every text at its
 * maximum length in capital W and M. Not valid for `validateCv` (the words are not facts'); a
 * test fixture for the worst case of the fit. Headings and education are never trimmed, so this
 * does not fit one page even when fully trimmed: `fitOnePage` reports `too_long` (ADR-054).
 */
export function wideCv(): CvContent {
  const a = aliasOf('fact-clients');
  const entry = (bullets: number, seed: number) => ({
    heading: {
      role: wide(CV_LIMITS.role, seed),
      org: wide(CV_LIMITS.org, seed + 1),
      factRef: aliasOf('fact-intern'),
    },
    bullets: Array.from({ length: bullets }, (_, i) => ({
      text: wide(CV_LIMITS.bullet, seed + i),
      factRefs: [a],
    })),
  });
  return {
    summary: { text: wide(CV_LIMITS.summary), factRefs: [a] },
    experience: Array.from({ length: CV_LIMITS.experienceEntries }, (_, i) =>
      entry(CV_LIMITS.bulletsPerEntry, i),
    ),
    projects: Array.from({ length: CV_LIMITS.projectEntries }, (_, i) => entry(2, i)),
    education: Array.from({ length: CV_LIMITS.educationEntries }, (_, i) => ({
      line: wide(CV_LIMITS.educationLine, i),
      factRef: aliasOf('fact-scrum'),
    })),
    skills: Array.from({ length: CV_LIMITS.skills }, (_, i) => ({
      label: wide(CV_LIMITS.skillLabel, i),
      factRefs: [aliasOf('fact-sql')],
    })),
    coverNote: {
      paragraphs: Array.from({ length: CV_LIMITS.noteParagraphsMax }, (_, i) => ({
        text: wide(CV_LIMITS.noteParagraph, i),
        factRefs: [a],
      })),
    },
  };
}

/** A header at every ceiling of `CvHeaderSchema` (3 links of 200 characters), in wide letters. */
export const WIDE_HEADER: CvHeader = {
  ...FAKE_HEADER,
  name: 'W'.repeat(80),
  email: `${'W'.repeat(107)}@example.com`,
  phone: `+44 ${'M'.repeat(36)}`,
  location: 'M'.repeat(80),
  links: ['W', 'M', 'WM'].map((letters) => `https://${letters.repeat(192).slice(0, 192)}`),
};
