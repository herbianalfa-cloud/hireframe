/**
 * What the CV writing check can find, as codes and plain words (CV quality plan, §2). Kept apart
 * from `cv-lint.ts` so the web can show a finding in words without pulling in the rule tables.
 * A finding names a place and a code, never the text it found, so it is safe to log and to hand
 * back to the model, as the issue codes are.
 */

export const FINDING_CODES = [
  'contrast_pattern',
  'buzzword_stack',
  'inflated_claim',
  'cliche',
  'buzzword',
  'intensifier',
  'weak_opener',
  'first_person',
  'long_sentence',
  'exclamation',
  'note_greeting',
  'heading_wraps',
] as const;
export type FindingCode = (typeof FINDING_CODES)[number];

/** `hard` findings cap the score below the target; `soft` ones only cost a little. */
export type FindingSeverity = 'hard' | 'soft';

export interface Finding {
  code: FindingCode;
  /** Where, e.g. `experience[0].bullets[2]`, as `validateCv` names paths. Never the text. */
  path: string;
  severity: FindingSeverity;
  /** Whether a rewrite of the text can clear it (every code here is). */
  fixable: boolean;
}

interface FindingInfo {
  severity: FindingSeverity;
  fixable: boolean;
  /** For the owner: what is wrong, in words. */
  label: string;
  /** For the model, in a revision request: what to do. Fixed text, never the found text. */
  guidance: string;
}

export const FINDING_INFO: Readonly<Record<FindingCode, FindingInfo>> = {
  contrast_pattern: {
    severity: 'hard',
    fixable: true,
    label: 'uses a "not this, but that" contrast',
    guidance: 'Say what was done directly. No "not X, but Y" or "it is not X, it is Y".',
  },
  buzzword_stack: {
    severity: 'hard',
    fixable: true,
    label: 'stacks buzzwords or vague adjectives',
    guidance: 'Replace the stacked buzzwords or adjectives with one plain, specific statement.',
  },
  inflated_claim: {
    severity: 'hard',
    fixable: true,
    label: 'claims more seniority or scale than the facts show',
    guidance:
      'Use a plain verb that matches the cited fact. Drop leadership and superlative words the fact does not use.',
  },
  cliche: {
    severity: 'hard',
    fixable: true,
    label: 'uses a stock CV phrase',
    guidance: 'Remove the stock phrase and say something specific from the facts.',
  },
  buzzword: {
    severity: 'soft',
    fixable: true,
    label: 'uses a buzzword',
    guidance: 'Replace the buzzword with a plain word.',
  },
  intensifier: {
    severity: 'soft',
    fixable: true,
    label: 'uses an empty intensifier',
    guidance: 'Remove adverbs such as successfully, effectively and significantly.',
  },
  weak_opener: {
    severity: 'soft',
    fixable: true,
    label: 'opens a bullet with a weak phrase',
    guidance: 'Start the bullet with a plain past-tense verb.',
  },
  first_person: {
    severity: 'soft',
    fixable: true,
    label: 'writes in the first person in the CV',
    guidance: 'Write the CV without I, me or my. First person belongs in the cover note.',
  },
  long_sentence: {
    severity: 'soft',
    fixable: true,
    label: 'has a sentence over 30 words',
    guidance: 'Split or shorten the sentence to 30 words or fewer.',
  },
  exclamation: {
    severity: 'soft',
    fixable: true,
    label: 'uses an exclamation mark',
    guidance: 'Remove the exclamation mark.',
  },
  note_greeting: {
    severity: 'soft',
    fixable: true,
    label: 'writes a greeting or sign-off into the cover note',
    guidance: 'Leave out the greeting and the sign-off. They are added for you.',
  },
  heading_wraps: {
    severity: 'soft',
    fixable: true,
    label: 'has an entry heading that runs over one line',
    guidance: 'Shorten the role or organisation so the heading and its dates fit on one line.',
  },
};

export const FINDING_SEVERITY: Readonly<Record<FindingCode, FindingSeverity>> = Object.fromEntries(
  FINDING_CODES.map((code) => [code, FINDING_INFO[code].severity]),
) as Record<FindingCode, FindingSeverity>;

export function makeFinding(code: FindingCode, path: string): Finding {
  const { severity, fixable } = FINDING_INFO[code];
  return { code, path, severity, fixable };
}

/** A finding in words for the owner. */
export function findingLabel(code: FindingCode): string {
  return FINDING_INFO[code].label;
}
