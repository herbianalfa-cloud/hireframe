import { z } from 'zod';

import { CV_ISSUE_CODES, type CvIssueCode } from './applications.js';
import { foldText, LEGAL_SUFFIXES } from './normalise.js';
import { EMAIL, PHONE, isPhoneLike } from './pii.js';
import type { Fact, FactContent } from './profile.js';

/**
 * Generated CV content and the rules that gate it (M7, docs/plans/m7-plan.md; PRD R10, ADR-006).
 * The model writes `CvContent`, citing facts by their `F12` alias; code resolves the aliases,
 * checks every claim against the facts it cites (`validateCv`), takes dates from the facts and
 * contact details from the owner's header, and trims to one page (`trimOrder`). Pure: no I/O.
 */

export const CV_LIMITS = {
  summary: 300,
  role: 80,
  org: 80,
  bullet: 220,
  bulletsPerEntry: 5,
  experienceEntries: 4,
  projectEntries: 3,
  educationLine: 160,
  educationEntries: 3,
  skillLabel: 40,
  skills: 16,
  noteParagraph: 600,
  noteParagraphsMin: 2,
  noteParagraphsMax: 4,
  /** Words across the cover note's paragraphs (the note is one page). */
  noteWords: 250,
  /** Citations on one text. */
  refs: 8,
  /** Longest alias the model may write (`F999`); anything longer is cut by the schema. */
  alias: 8,
} as const;

/** The fact types each section may cite (`wrong_fact_type` otherwise). */
export const EXPERIENCE_HEADING_FACT_TYPES: readonly Fact['type'][] = ['experience'];
export const PROJECT_HEADING_FACT_TYPES: readonly Fact['type'][] = ['project', 'experience'];
export const EDUCATION_FACT_TYPES: readonly Fact['type'][] = ['education'];
export const SKILL_FACT_TYPES: readonly Fact['type'][] = ['skill'];

/**
 * Types no claim may cite: a preference is never evidence of anything done. A constraint (work
 * rights, location) may back a sentence in the summary or the cover note, and nothing else.
 */
const NEVER_CITED: readonly Fact['type'][] = ['preference'];
const NOT_IN_ENTRIES: readonly Fact['type'][] = ['constraint', 'preference'];

// ---- Schemas ----

/**
 * One builder, two strictness levels. `strict` is the stored shape (every limit enforced). The
 * loose one is what the model's output is parsed with: the structure is checked, the limits and
 * the minimum of one citation are left to `validateCv`, so a too-long or uncited output becomes
 * an issue code for the retry instead of an unusable parse.
 */
function contentSchema(strict: boolean) {
  const text = (max: number) =>
    strict ? z.string().trim().min(1).max(max) : z.string().max(max * 4);
  const ref = z.string().max(strict ? CV_LIMITS.alias : 40);
  const refs = strict
    ? z.array(ref).min(1).max(CV_LIMITS.refs)
    : z.array(ref).max(CV_LIMITS.refs * 4);
  const list = <T extends z.ZodType>(item: T, min: number, max: number) =>
    strict ? z.array(item).min(min).max(max) : z.array(item).max(max * 4);

  const cited = (max: number) => z.strictObject({ text: text(max), factRefs: refs });
  const entry = (maxEntries: number) =>
    list(
      z.strictObject({
        heading: z.strictObject({
          role: text(CV_LIMITS.role),
          org: text(CV_LIMITS.org),
          factRef: ref,
        }),
        bullets: list(cited(CV_LIMITS.bullet), 0, CV_LIMITS.bulletsPerEntry),
      }),
      0,
      maxEntries,
    );

  return z.strictObject({
    summary: cited(CV_LIMITS.summary),
    experience: entry(CV_LIMITS.experienceEntries),
    projects: entry(CV_LIMITS.projectEntries),
    education: list(
      z.strictObject({ line: text(CV_LIMITS.educationLine), factRef: ref }),
      0,
      CV_LIMITS.educationEntries,
    ),
    skills: list(
      z.strictObject({ label: text(CV_LIMITS.skillLabel), factRefs: refs }),
      0,
      CV_LIMITS.skills,
    ),
    coverNote: z.strictObject({
      paragraphs: list(
        cited(CV_LIMITS.noteParagraph),
        CV_LIMITS.noteParagraphsMin,
        CV_LIMITS.noteParagraphsMax,
      ),
    }),
  });
}

/** The model's output, limits enforced: also the shape of what is stored once validated. */
export const CvContentSchema = contentSchema(true);
export type CvContent = z.infer<typeof CvContentSchema>;

/** What the worker parses the model's output with; `validateCv` then applies the limits. */
export const CvContentShapeSchema = contentSchema(false);

/** Content after the one-page trim: the summary is the last thing `trimOrder` removes. */
export const TrimmedCvContentSchema = z.strictObject({
  ...CvContentSchema.shape,
  summary: CvContentSchema.shape.summary.nullable(),
});
export type TrimmedCvContent = z.infer<typeof TrimmedCvContentSchema>;

const HTTPS_URL = z
  .url({ protocol: /^https$/ })
  .max(200)
  .regex(/^https:\/\/\S+$/);

/**
 * `profile/cvHeader`: the contact block code puts at the top of every CV. The model never sees
 * it and never writes contact details (`contact_in_text`).
 */
export const CvHeaderSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  email: z.email().max(120),
  phone: z.string().trim().min(1).max(40).exactOptional(),
  location: z.string().trim().min(1).max(80).exactOptional(),
  links: z.array(HTTPS_URL).max(3).exactOptional(),
  createdAt: z.date(),
  updatedAt: z.date(),
  schemaVersion: z.literal(1),
});
export type CvHeader = z.infer<typeof CvHeaderSchema>;

export const CV_FILE_KINDS = ['cv', 'cover-note'] as const;
export type CvFileKind = (typeof CV_FILE_KINDS)[number];
export const CV_FILE_FORMATS = ['pdf', 'docx'] as const;
export type CvFileFormat = (typeof CV_FILE_FORMATS)[number];

/** `<jobId>-v<n>`. */
export function cvId(jobId: string, version: number): string {
  return `${jobId}-v${String(version)}`;
}

/** `cvs/{cvId}`: one generated CV and cover note, kept as a version. */
export const CvDocSchema = z.strictObject({
  jobId: z.string().min(1),
  /** The `n` in the `cvId`; counts up per job, and a regenerate adds one. */
  applicationVersion: z.int().min(1),
  /** The content as rendered, after any trim. */
  content: TrimmedCvContentSchema,
  /** Alias → fact ID, as the model saw it, so the citations can be traced later. */
  aliases: z.record(z.string(), z.string().min(1)),
  /** Every fact ID the content cites. */
  factIds: z.array(z.string().min(1)).max(200),
  storagePaths: z.strictObject({
    cvPdf: z.string().min(1),
    cvDocx: z.string().min(1),
    notePdf: z.string().min(1),
    noteDocx: z.string().min(1),
  }),
  /** `trimOrder` steps the one-page fit applied. */
  trimmed: z.int().min(0),
  notes: z.string().trim().min(1).max(500).exactOptional(),
  model: z.string().min(1),
  costPence: z.number().min(0),
  createdAt: z.date(),
  schemaVersion: z.literal(1),
});
export type CvDoc = z.infer<typeof CvDocSchema>;

// ---- Dates ----

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatPartialDate(value: string): string {
  const [year = '', month] = value.split('-');
  return month === undefined ? year : `${MONTHS[Number(month) - 1] ?? month} ${year}`;
}

/** "Oct 2023 – May 2024", from the cited heading fact's dates, never from model text. */
export function formatFactDates(dates: FactContent['dates']): string {
  const { start, end } = dates;
  if (start !== undefined && end !== undefined) {
    return `${formatPartialDate(start)} – ${end === 'present' ? 'Present' : formatPartialDate(end)}`;
  }
  if (start !== undefined) return `${formatPartialDate(start)} – Present`;
  if (end !== undefined) return end === 'present' ? 'Present' : formatPartialDate(end);
  return '';
}

// ---- Characters the PDF can print ----

/** What Windows-1252 (WinAnsi) maps 0x80–0x9F to; the standard PDF fonts can print these and nothing else outside Latin-1. */
const WIN_ANSI_EXTRA = new Set(
  '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'.split('').map((char) => char.codePointAt(0)),
);

/** Whether the standard PDF fonts (Helvetica) can print `char`: printable ASCII, Latin-1, or a WinAnsi extra. */
export function isWinAnsi(char: string): boolean {
  const code = char.codePointAt(0);
  if (code === undefined) return false;
  if (code >= 0x20 && code <= 0x7e) return true;
  if (code >= 0xa1 && code <= 0xff) return true;
  return code === 0xa0 || WIN_ANSI_EXTRA.has(code);
}

/** True when every character of `text` can be printed; a newline or tab is not printable. */
export function isPrintable(text: string): boolean {
  for (const char of text) if (!isWinAnsi(char)) return false;
  return true;
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => word !== '').length;
}

// ---- Validation ----

/** The part of a fact `validateCv` reads. `status` is there so an archived fact can't be cited. */
export type CvFact = Pick<Fact, 'type' | 'text' | 'evidence' | 'status'> & { id: string };

export interface CvIssue {
  /** Where, e.g. `experience[0].bullets[2]`. Never the offending text. */
  path: string;
  code: CvIssueCode;
}

export type CvValidation = { ok: true } | { ok: false; issues: CvIssue[] };

/**
 * A figure the way a reader would compare it: `12k` and `12,000` are the same, `30%` is not
 * `30`, and a multiplier (`10x`, `10-fold`), an ordinal (`2nd`), a plural (`100s`), a trailing
 * plus (`10+`) and each currency symbol is a kind of its own.
 */
const FIGURE =
  /(?<![A-Za-z0-9.])([£$€]?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(%|\s?per ?cent\b|-?fold|x|st|nd|rd|th|s|bn|mm|mn|k|m|b|\s(?:hundred|thousand|million|billion)\b)?(\+)?(?![A-Za-z0-9])/gi;

const UNIT_FACTOR: Readonly<Record<string, number>> = {
  k: 1e3,
  m: 1e6,
  mm: 1e6,
  mn: 1e6,
  b: 1e9,
  bn: 1e9,
  hundred: 100,
  thousand: 1e3,
  million: 1e6,
  billion: 1e9,
};

const FRACTIONS: Readonly<Record<string, number>> = { '¼': 0.25, '½': 0.5, '¾': 0.75 };

const SMALL_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
/** Words that multiply what came before (or stand for 1 of themselves): "two dozen", "a hundred". */
const SCALE_WORDS: Readonly<Record<string, number>> = {
  dozen: 12,
  hundred: 100,
  thousand: 1e3,
  million: 1e6,
  billion: 1e9,
};
/** Words that say a change or an amount without a value; each is a figure of its own kind. */
const KIND_WORDS: Readonly<Record<string, string>> = {
  tens: 'tens',
  dozens: 'dozens',
  hundreds: 'hundreds',
  thousands: 'thousands',
  millions: 'millions',
  billions: 'billions',
  half: 'half',
  halved: 'halved',
  double: 'double',
  doubled: 'double',
  triple: 'triple',
  tripled: 'triple',
  quadruple: 'quadruple',
  quadrupled: 'quadruple',
};

function isNumberWord(word: string | undefined): boolean {
  return word !== undefined && (word in SMALL_WORDS || word in SCALE_WORDS);
}

/** Number words in `text` as figures; "one" alone is not one (it is not a claim worth checking). */
function wordFigures(text: string, figures: Set<string>): void {
  const tokens = foldText(text).split(' ');
  for (let i = 0; i < tokens.length;) {
    const word = tokens[i] ?? '';
    const kindWord = KIND_WORDS[word];
    if (kindWord !== undefined) {
      figures.add(`word:${kindWord}`);
      i += 1;
      continue;
    }
    const afterDigits = /^\d+$/.test(tokens[i - 1] ?? '');
    if (!isNumberWord(word) || (afterDigits && word in SCALE_WORDS)) {
      i += 1;
      continue;
    }
    let total = 0;
    let current = 0;
    let onlyOne = true;
    let j = i;
    for (; j < tokens.length; j += 1) {
      const token = tokens[j] ?? '';
      const small = SMALL_WORDS[token];
      const scale = SCALE_WORDS[token];
      if (small !== undefined) {
        current += small;
        if (token !== 'one') onlyOne = false;
      } else if (scale !== undefined) {
        onlyOne = false;
        if (scale >= 1e3) {
          total += (current === 0 ? 1 : current) * scale;
          current = 0;
        } else {
          current = (current === 0 ? 1 : current) * scale;
        }
      } else if (token === 'and' && j > i && isNumberWord(tokens[j + 1])) {
        // "three hundred and fifty": the "and" joins the run.
      } else {
        break;
      }
    }
    const isPercent = tokens[j] === 'percent' || (tokens[j] === 'per' && tokens[j + 1] === 'cent');
    if (!onlyOne) figures.add(`${isPercent ? 'percent' : 'plain'}:${String(total + current)}`);
    i = Math.max(j, i + 1);
  }
}

/**
 * Every figure in `text`, as `kind:value`: `plain:12000`, `percent:30`, `£plain:50000`,
 * `times:10`, `ordinal:2`, `plural:100`, `fraction:0.5`, `plain:10+`, and number words by value
 * (`twelve` is `plain:12`) or as `word:halved`.
 */
export function figuresIn(text: string): Set<string> {
  const figures = new Set<string>();
  for (const match of text.matchAll(FIGURE)) {
    const [, currency = '', whole = '', fraction = '', unit = '', plus = ''] = match;
    const base = Number(`${whole.replaceAll(',', '')}${fraction}`);
    const lower = unit.trim().toLowerCase();
    let kind = 'plain';
    if (lower === '%' || lower.startsWith('per')) kind = 'percent';
    else if (lower === 'x' || lower.endsWith('fold')) kind = 'times';
    else if (['st', 'nd', 'rd', 'th'].includes(lower)) kind = 'ordinal';
    else if (lower === 's') kind = 'plural';
    const value = Number((base * (UNIT_FACTOR[lower] ?? 1)).toFixed(6));
    figures.add(`${currency}${kind}:${String(value)}${plus}`);
  }
  for (const char of text) {
    const fraction = FRACTIONS[char];
    if (fraction !== undefined) figures.add(`fraction:${String(fraction)}`);
  }
  wordFigures(text, figures);
  return figures;
}

/** A link: contact details come from the header, so this is never allowed, even from a fact. */
const LINK = /\b(?:https?:\/\/|www\.)\S+/i;

const LABEL = String.raw`[a-z0-9](?:[a-z0-9-]*[a-z0-9])?`;
const SEPARATOR = String.raw`(?:\.|\s*\[\.\]\s*|\s+dot\s+)`;
/** `label.tld` with 2–24 letters in the last part, the "[.]" and " dot " spellings, and an optional path. */
const ADDRESS = new RegExp(
  String.raw`(?<![\w@.-])${LABEL}(?:${SEPARATOR}${LABEL})*${SEPARATOR}[a-z]{2,24}(?![\w@-])(?:\/\S*)?`,
  'gi',
);

/** Top-level domains " dot " is read as (so "the dot product" is not an address). */
const DOT_TLDS = new Set(
  'com net org io co uk dev app ai me ly xyz info eu gov edu site online biz us ca de tech cloud link fr nl ie in au'.split(
    ' ',
  ),
);

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * An email, a phone number or a web address: contact details come only from the header. A bare
 * `label.tld` (ASP.NET, Booking.com) is allowed when the same token is in `allowed`, the text of
 * the cited facts (their text, not their evidence); an email, a phone number, a link and an obfuscated spelling never are.
 */
export function hasContactDetails(text: string, allowed = ''): boolean {
  if (text.match(EMAIL) !== null) return true;
  if ((text.match(PHONE) ?? []).some(isPhoneLike)) return true;
  if (LINK.test(text)) return true;
  for (const match of text.matchAll(ADDRESS)) {
    const token = match[0].replace(/[.,;:!?)\]"']+$/, '');
    const spelled = /\[\.\]|\s/.test(token.split('/')[0] ?? token);
    if (spelled) {
      const tld = (token.split('/')[0] ?? token).split(/\s*\[\.\]\s*|\s+dot\s+|\./i).pop() ?? '';
      if (token.includes('[.]') || DOT_TLDS.has(tld.toLowerCase())) return true;
      continue;
    }
    const literal = new RegExp(
      String.raw`(?<![\w@.-])${escapeRegExp(token)}(?![\w@-]|\.[a-z0-9])`,
      'i',
    );
    if (!literal.test(allowed)) return true;
  }
  return false;
}

interface Cite {
  /** For issues about the citation itself. */
  path: string;
  /**
   * How the words of `texts` are held to the cited facts (`unsupported_text`): `fact` for a
   * heading or an education line, `parts` for a skill label; none for prose.
   */
  words?: 'fact' | 'parts';
  /** Fact types that may never be cited here. */
  denied: readonly Fact['type'][];
  /** Model texts under this citation, each with its path (length limits are reported per text). */
  texts: { path: string; value: string; max: number }[];
  refs: readonly string[];
  /** Fact types the cited facts must have; `undefined` for any. */
  types?: readonly Fact['type'][];
  /** The most citations allowed. */
  maxRefs: number;
}

function cites(content: CvContent): Cite[] {
  const out: Cite[] = [
    {
      path: 'summary',
      texts: [{ path: 'summary', value: content.summary.text, max: CV_LIMITS.summary }],
      refs: content.summary.factRefs,
      denied: NEVER_CITED,
      maxRefs: CV_LIMITS.refs,
    },
  ];
  const entries = (section: 'experience' | 'projects') => {
    content[section].forEach((entry, i) => {
      const base = `${section}[${String(i)}]`;
      out.push({
        path: `${base}.heading`,
        texts: [
          { path: `${base}.heading.role`, value: entry.heading.role, max: CV_LIMITS.role },
          { path: `${base}.heading.org`, value: entry.heading.org, max: CV_LIMITS.org },
        ],
        refs: entry.heading.factRef === '' ? [] : [entry.heading.factRef],
        types:
          section === 'experience' ? EXPERIENCE_HEADING_FACT_TYPES : PROJECT_HEADING_FACT_TYPES,
        words: 'fact',
        denied: NOT_IN_ENTRIES,
        maxRefs: 1,
      });
      entry.bullets.forEach((bullet, j) => {
        const path = `${base}.bullets[${String(j)}]`;
        out.push({
          path,
          texts: [{ path, value: bullet.text, max: CV_LIMITS.bullet }],
          refs: bullet.factRefs,
          denied: NOT_IN_ENTRIES,
          maxRefs: CV_LIMITS.refs,
        });
      });
    });
  };
  entries('experience');
  entries('projects');
  content.education.forEach((entry, i) => {
    const path = `education[${String(i)}]`;
    out.push({
      path,
      texts: [{ path, value: entry.line, max: CV_LIMITS.educationLine }],
      refs: entry.factRef === '' ? [] : [entry.factRef],
      types: EDUCATION_FACT_TYPES,
      words: 'fact',
      denied: NOT_IN_ENTRIES,
      maxRefs: 1,
    });
  });
  content.skills.forEach((skill, i) => {
    const path = `skills[${String(i)}]`;
    out.push({
      path,
      texts: [{ path, value: skill.label, max: CV_LIMITS.skillLabel }],
      refs: skill.factRefs,
      types: SKILL_FACT_TYPES,
      words: 'parts',
      denied: NOT_IN_ENTRIES,
      maxRefs: CV_LIMITS.refs,
    });
  });
  content.coverNote.paragraphs.forEach((paragraph, i) => {
    const path = `coverNote.paragraphs[${String(i)}]`;
    out.push({
      path,
      texts: [{ path, value: paragraph.text, max: CV_LIMITS.noteParagraph }],
      refs: paragraph.factRefs,
      denied: NEVER_CITED,
      maxRefs: CV_LIMITS.refs,
    });
  });
  return out;
}

// ---- Words ----

/**
 * Words the word rule leaves out: connectives, the company suffixes `normaliseCompany` strips
 * (`plc`, `llc`, `gmbh`...) and the generic label for a project. `uk` is not one of them here:
 * "Example Cloud UK" claims a UK entity the fact may not name.
 */
const SKIPPED_WORDS: ReadonlySet<string> = new Set([
  ...[...LEGAL_SUFFIXES].filter((word) => word !== 'uk'),
  'and',
  'of',
  'the',
  'for',
  'project',
  'personal',
  'at',
  'in',
  'on',
  'to',
  'by',
  'an',
  'as',
  'or',
]);

/**
 * `foldText` for a claim: a single letter followed by `++` or `#` is one token, so `C++`, `C#`
 * and `F#` are three different skills and not all "c" and "f".
 */
function foldClaim(text: string): string {
  return foldText(
    text.replace(
      /\b([a-z])(\+\+|#)/gi,
      (_, letter: string, mark: string) => `${letter}${mark === '#' ? 'sharp' : 'plusplus'}`,
    ),
  );
}

/** The words of 2+ letters in `text`, folded, without the skipped ones. Single letters stay unchecked. */
function wordsOf(text: string): string[] {
  return [...foldClaim(text).matchAll(/\p{L}{2,}/gu)]
    .map((match) => match[0])
    .filter((word) => !SKIPPED_WORDS.has(word));
}

/** What a label or heading may borrow words from: one cited fact's text and evidence. */
function factWords(fact: CvFact): Set<string> {
  return new Set(wordsOf(`${fact.text}\n${fact.evidence}`));
}

/**
 * Where a skill label splits: a list mark, a `+` or a dash with a space on both sides (so `C++`
 * and `time-to-live` stay whole), a colon, and `and` or `or`.
 */
const LABEL_PARTS = /[,;/&|():\u2022]|\s\+\s|\s[-\u2013\u2014\u00b7]\s|\s(?:and|or)\s/i;

/**
 * Whether a skill label's parts are each backed by one cited fact: all the part's words are in
 * that fact's text or evidence. A part without a word of 2+ letters ("R") has to be a whole
 * word or phrase of a cited fact instead.
 */
function labelSupported(label: string, cited: readonly CvFact[]): boolean {
  const sets = cited.map(factWords);
  const phrases = cited.map((fact) => ` ${foldClaim(`${fact.text}\n${fact.evidence}`)} `);
  const parts = label.split(LABEL_PARTS).filter((part) => foldClaim(part) !== '');
  // A label of separators alone ("-") says nothing, so nothing backs it.
  if (parts.length === 0) return false;
  return parts.every((part) => {
    const words = wordsOf(part);
    if (words.length > 0) return sets.some((set) => words.every((word) => set.has(word)));
    const folded = foldClaim(part);
    return phrases.some((phrase) => phrase.includes(` ${folded} `));
  });
}

function countIssues(content: CvContent): CvIssue[] {
  const issues: CvIssue[] = [];
  const over = (path: string, count: number, max: number, min = 0) => {
    if ((count > max || count < min) && !issues.some((issue) => issue.path === path)) {
      issues.push({ path, code: 'too_long' });
    }
  };
  over('experience', content.experience.length, CV_LIMITS.experienceEntries);
  over('projects', content.projects.length, CV_LIMITS.projectEntries);
  over('education', content.education.length, CV_LIMITS.educationEntries);
  over('skills', content.skills.length, CV_LIMITS.skills);
  over(
    'coverNote.paragraphs',
    content.coverNote.paragraphs.length,
    CV_LIMITS.noteParagraphsMax,
    CV_LIMITS.noteParagraphsMin,
  );
  const noteWords = content.coverNote.paragraphs.reduce(
    (total, paragraph) => total + wordCount(paragraph.text),
    0,
  );
  over('coverNote.paragraphs', noteWords, CV_LIMITS.noteWords);
  for (const section of ['experience', 'projects'] as const) {
    content[section].forEach((entry, i) => {
      over(`${section}[${String(i)}].bullets`, entry.bullets.length, CV_LIMITS.bulletsPerEntry);
    });
  }
  return issues;
}

/**
 * Whether `content` may be rendered, given the aliases the model saw (alias → fact ID) and the
 * facts (archived ones included, so a fact archived since the call is caught). Pure; never throws.
 * Issues name a path and a code only, never the offending text, so they are safe to log and to
 * hand back to the model as codes.
 */
export function validateCv(
  content: CvContent,
  aliases: ReadonlyMap<string, string>,
  facts: readonly CvFact[],
): CvValidation {
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const issues: CvIssue[] = countIssues(content);
  const add = (path: string, code: CvIssueCode) => {
    if (!issues.some((issue) => issue.path === path && issue.code === code)) {
      issues.push({ path, code });
    }
  };

  for (const cite of cites(content)) {
    if (cite.refs.length === 0) add(cite.path, 'uncited');
    if (cite.refs.length > cite.maxRefs) add(cite.path, 'too_long');
    const allowedText = cite.refs
      .map((ref) => byId.get(aliases.get(ref) ?? ''))
      .filter((fact) => fact?.status === 'active')
      .map((fact) => fact?.text ?? '')
      .join('\n');
    for (const text of cite.texts) {
      if (text.value.length > text.max || text.value.trim() === '') add(text.path, 'too_long');
      if (hasContactDetails(text.value, allowedText)) add(text.path, 'contact_in_text');
      // Never dropped or swapped silently: the PDF fonts can't print it (ADR-054).
      // NFC first: "e" + a combining accent is the é the font has, written the long way.
      if (!isPrintable(text.value.normalize('NFC'))) add(text.path, 'unsupported_char');
    }

    const cited: CvFact[] = [];
    for (const ref of cite.refs) {
      const id = aliases.get(ref);
      const fact = id === undefined ? undefined : byId.get(id);
      if (fact?.status !== 'active') {
        add(cite.path, 'unknown_fact');
        continue;
      }
      const wrongType =
        cite.denied.includes(fact.type) ||
        (cite.types !== undefined && !cite.types.includes(fact.type));
      if (wrongType) add(cite.path, 'wrong_fact_type');
      cited.push(fact);
    }

    if (cite.words === 'fact' && cited.length > 0) {
      const allowed = new Set(cited.flatMap((fact) => [...factWords(fact)]));
      let checked = 0;
      for (const text of cite.texts) {
        const words = wordsOf(text.value);
        checked += words.length;
        if (words.some((word) => !allowed.has(word))) add(text.path, 'unsupported_text');
      }
      // Role and org together (or the line) must have one word the fact backs: all-skipped says nothing.
      if (checked === 0) add(cite.texts[0]?.path ?? cite.path, 'unsupported_text');
    }
    if (cite.words === 'parts' && cited.length > 0) {
      for (const text of cite.texts) {
        if (!labelSupported(text.value, cited)) add(text.path, 'unsupported_text');
      }
    }

    const supported = figuresIn(cited.map((fact) => `${fact.text}\n${fact.evidence}`).join('\n'));
    for (const text of cite.texts) {
      for (const figure of figuresIn(text.value)) {
        if (!supported.has(figure)) add(text.path, 'unsupported_number');
      }
    }
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/** The distinct codes of `issues`, in the order the codes are declared: what the retry appends. */
export function issueCodes(issues: readonly CvIssue[]): CvIssueCode[] {
  const present = new Set(issues.map((issue) => issue.code));
  return CV_ISSUE_CODES.filter((code) => present.has(code));
}

/** Every fact ID `content` cites, resolved through `aliases`, sorted and distinct. */
export function citedFactIds(content: CvContent, aliases: ReadonlyMap<string, string>): string[] {
  const ids = new Set<string>();
  for (const cite of cites(content)) {
    for (const ref of cite.refs) {
      const id = aliases.get(ref);
      if (id !== undefined) ids.add(id);
    }
  }
  return [...ids].sort();
}

// ---- One-page trim ----

export type TrimStep =
  | { kind: 'bullet'; section: 'experience'; entry: number; index: number }
  | { kind: 'project'; index: number }
  | { kind: 'skill'; index: number }
  | { kind: 'summary' };

const KEPT_SKILLS = 10;

/**
 * The removals that make a long CV shorter, in the order they are tried. Deterministic, so the
 * same content always trims the same way:
 *   1. the last bullet of the experience entry with the most bullets (the later entry on a tie),
 *      repeated until each entry has one bullet left;
 *   2. then projects, last first;
 *   3. then skills beyond the first 10, last first;
 *   4. then the summary.
 * Headings and education are never removed. Each step refers to the content as the steps before
 * it left it, so apply them in order (`applyTrim`).
 */
export function trimOrder(content: CvContent): TrimStep[] {
  const steps: TrimStep[] = [];
  const counts = content.experience.map((entry) => entry.bullets.length);
  for (;;) {
    let longest = -1;
    counts.forEach((count, entry) => {
      if (count > 1 && (longest === -1 || count >= (counts[longest] ?? 0))) longest = entry;
    });
    if (longest === -1) break;
    const index = (counts[longest] ?? 1) - 1;
    steps.push({ kind: 'bullet', section: 'experience', entry: longest, index });
    counts[longest] = index;
  }
  for (let index = content.projects.length - 1; index >= 0; index -= 1) {
    steps.push({ kind: 'project', index });
  }
  for (let index = content.skills.length - 1; index >= KEPT_SKILLS; index -= 1) {
    steps.push({ kind: 'skill', index });
  }
  steps.push({ kind: 'summary' });
  return steps;
}

/** `content` with the first `count` steps of `trimOrder(content)` applied. Does not mutate. */
export function applyTrim(content: CvContent, count: number): TrimmedCvContent {
  const steps = trimOrder(content).slice(0, Math.max(0, count));
  const experience = content.experience.map((entry) => ({
    ...entry,
    bullets: [...entry.bullets],
  }));
  let projects = [...content.projects];
  let skills = [...content.skills];
  let summary: CvContent['summary'] | null = content.summary;
  for (const step of steps) {
    if (step.kind === 'bullet') experience[step.entry]?.bullets.splice(step.index, 1);
    else if (step.kind === 'project') projects = projects.filter((_, i) => i !== step.index);
    else if (step.kind === 'skill') skills = skills.filter((_, i) => i !== step.index);
    else summary = null;
  }
  return { ...content, experience, projects, skills, summary };
}
