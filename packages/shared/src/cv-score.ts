import {
  CV_CRITERIA,
  figuresIn,
  wordCount,
  type CvContent,
  type CvCriterion,
  type CvFact,
  type TrimmedCvContent,
} from './cv.js';
import { makeFinding, type Finding } from './cv-findings.js';
import { lintCv } from './cv-lint.js';
import type { JobRequirement } from './funnel.js';
import { foldText, LEGAL_SUFFIXES } from './normalise.js';

/**
 * The CV quality score (CV quality plan §3, rubric v2): pure and deterministic, so it costs
 * nothing, replays, and injected text can't argue with it. It reads the content, the facts it
 * cites, the job's requirements and the layout metrics `fitPage` measured. Findings hold codes
 * and paths, never text.
 */

export const CV_RUBRIC_VERSION = 'rubric-v2';
/** A CV scores "good enough" at this total with no hard finding. */
export const CV_SCORE_TARGET = 8;
/** A hard finding caps the total here, below the target. */
export const CV_HARD_FINDING_CAP = 7.5;

/** Points each criterion is worth; they add up to 10. */
export const CV_WEIGHTS: Readonly<Record<CvCriterion, number>> = {
  fill: 2,
  writing: 2.5,
  numbers: 1,
  tailoring: 1,
  craft: 1.5,
  structure: 1,
  note: 1,
};

/** What `fitPage` measured (functions/src/cv/render/fit.ts `FitResult`). */
export interface CvLayoutMetrics {
  /** Used height ÷ usable height, after the spacing is spread. */
  fill: number;
  /** Rendered lines per bullet, in document order (Experience, then Projects). */
  bulletLines: readonly number[];
  /** Entry headings that need more than one line. */
  headingWraps: number;
}

export interface CvScoreInput {
  content: CvContent | TrimmedCvContent;
  facts: readonly CvFact[];
  /** Alias → fact ID, as stored on the `cvs` doc. */
  aliases: ReadonlyMap<string, string>;
  /** The job's S3 requirements, with fact IDs resolved. */
  requirements: readonly JobRequirement[];
  company: string;
  /** The job's title: its own words are not an inflated claim by the candidate. */
  jobTitle?: string | undefined;
  layout: CvLayoutMetrics;
  /** Defaults to `CV_SCORE_TARGET`. */
  target?: number | undefined;
}

export interface CvScore {
  rubric: typeof CV_RUBRIC_VERSION;
  /** 0 to 10, two decimals; at most `CV_HARD_FINDING_CAP` while a hard finding stands. */
  total: number;
  /** The criteria summed before the hard-finding cap, so two capped scores can still be ranked. */
  uncapped: number;
  criteria: Record<CvCriterion, number>;
  findings: Finding[];
  gatePassed: boolean;
}

// ---- Thresholds (rubric v2) ----

/** The empty band at which the fill criterion starts to lose points, and the band that loses all. */
export const FILL_FULL_BAND = 0.03;
export const FILL_ZERO_BAND = 0.25;
const HEADING_WRAP_COST = 0.25;
const HARD_COST = 1;
const SOFT_COST = 0.25;
/** What one finding takes off the total (a heading wrap costs the same as a soft one). */
export function findingCost(finding: Pick<Finding, 'severity'>): number {
  return finding.severity === 'hard' ? HARD_COST : SOFT_COST;
}
/** Coverage of the coverable requirements that earns full tailoring marks. */
const COVERAGE_FULL = 0.8;
const BULLET_WORDS = { min: 8, max: 28 } as const;
const BULLET_MAX_LINES = 2;
const SUMMARY_MAX_CHARS = 270; // about three lines at 10 pt
const SKILLS = { min: 6, max: 14 } as const;
const NOTE_WORDS = { min: 150, max: 250 } as const;
/** The note criterion's own band is the prompt's: 180 to 250 words. */
const NOTE_PROMPT_WORDS = { min: 180, max: 250 } as const;
const NOTE_STOCK_OPENER = /^\s*(?:i am (?:applying|writing)|i would like to apply)\b/i;
/** The most of the note's word trigrams the bullets may already hold. */
const NOTE_MAX_OVERLAP = 0.3;

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));
const round2 = (value: number): number => Math.round(value * 100) / 100;

type Content = CvContent | TrimmedCvContent;

interface Bullet {
  text: string;
  refs: readonly string[];
}

/** Experience bullets, then project bullets: the order `fitPage` reports their lines in. */
function bulletsOf(content: Content): Bullet[] {
  return [...content.experience, ...content.projects].flatMap((entry) =>
    entry.bullets.map((bullet) => ({ text: bullet.text, refs: bullet.factRefs })),
  );
}

/** Every alias the content cites, resolved to fact IDs. */
function citedIds(content: Content, aliases: ReadonlyMap<string, string>): Set<string> {
  const refs: string[] = [];
  if (content.summary !== null) refs.push(...content.summary.factRefs);
  for (const entry of [...content.experience, ...content.projects]) {
    refs.push(entry.heading.factRef);
    for (const bullet of entry.bullets) refs.push(...bullet.factRefs);
  }
  for (const line of content.education) {
    refs.push(line.factRef);
    if (line.achievementRef !== undefined) refs.push(line.achievementRef);
  }
  for (const skill of content.skills) refs.push(...skill.factRefs);
  for (const paragraph of content.coverNote.paragraphs) refs.push(...paragraph.factRefs);
  const ids = new Set<string>();
  for (const ref of refs) {
    const id = aliases.get(ref);
    if (id !== undefined) ids.add(id);
  }
  return ids;
}

// ---- 1. Page fill ----

function fillScore(layout: CvLayoutMetrics): number {
  const band = 1 - clamp(layout.fill, 0, 1);
  const filled =
    band <= FILL_FULL_BAND
      ? 1
      : band >= FILL_ZERO_BAND
        ? 0
        : (FILL_ZERO_BAND - band) / (FILL_ZERO_BAND - FILL_FULL_BAND);
  return Math.max(0, CV_WEIGHTS.fill * filled - HEADING_WRAP_COST * layout.headingWraps);
}

// ---- 2. Writing rules ----

function writingScore(findings: readonly Finding[]): number {
  // A heading wrap is a layout finding: criterion 1 already charges it.
  const counted = findings.filter((finding) => finding.code !== 'heading_wraps');
  const hard = counted.filter((finding) => finding.severity === 'hard').length;
  const soft = counted.length - hard;
  return Math.max(0, CV_WEIGHTS.writing - HARD_COST * hard - SOFT_COST * soft);
}

// ---- 3. Real numbers ----

/**
 * Of the bullets that cite a fact with a figure (in the fact's text, not its evidence, where a
 * year would count), the share that use one of those figures. */
function numbersScore(bullets: readonly Bullet[], factOf: (ref: string) => CvFact | undefined) {
  let eligible = 0;
  let used = 0;
  for (const bullet of bullets) {
    const figures = new Set<string>();
    for (const ref of bullet.refs) {
      const fact = factOf(ref);
      if (fact === undefined) continue;
      for (const figure of figuresIn(fact.text)) figures.add(figure);
    }
    if (figures.size === 0) continue;
    eligible += 1;
    if ([...figuresIn(bullet.text)].some((figure) => figures.has(figure))) used += 1;
  }
  return CV_WEIGHTS.numbers * (eligible === 0 ? 1 : used / eligible);
}

// ---- 4. Tailoring ----

/**
 * Weighted coverage of the requirements the CV can cover: must = 2, nice = 1, logistics out, and
 * only those with a matched active fact (a gap the profile can't fill is not the CV's fault).
 * Covered means the CV cites one of the requirement's facts.
 */
function tailoringScore(
  requirements: readonly JobRequirement[],
  activeIds: ReadonlySet<string>,
  cited: ReadonlySet<string>,
): number {
  let total = 0;
  let covered = 0;
  for (const requirement of requirements) {
    if (requirement.type === 'logistics') continue;
    const ids = requirement.factIds.filter((id) => activeIds.has(id));
    if (ids.length === 0) continue;
    const weight = requirement.level === 'must' ? 2 : 1;
    total += weight;
    if (ids.some((id) => cited.has(id))) covered += weight;
  }
  const coverage = total === 0 ? 1 : covered / total;
  return CV_WEIGHTS.tailoring * Math.min(1, coverage / COVERAGE_FULL);
}

// ---- 5. Bullet craft ----

/** First words that are not verbs, or not the plain verb a bullet should open with. */
const NOT_VERBS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'my', 'our', 'i', 'we', 'responsible', 'various', 'strong', 'key', 'main',
  'excellent', 'successful', 'involved', 'experience', 'duties', 'tasked', 'in', 'on', 'for',
  'with', 'as', 'at', 'by', 'to', 'of', 'and', 'also', 'both', 'all', 'some', 'many',
]); // prettier-ignore

/**
 * Whether a bullet opens with a plain verb, as far as a word list can tell: the first word is
 * not a stop word, a gerund (-ing) or a noun ending (-tion, -ment, -ness, -ity, -ly).
 */
function openingVerb(text: string): string | null {
  const first = /^[^A-Za-z]*([A-Za-z]+)/.exec(text)?.[1]?.toLowerCase();
  if (first === undefined || first.length < 2) return null;
  if (NOT_VERBS.has(first)) return null;
  if (/(?:ing|tion|ment|ness|ity|ly)$/.test(first)) return null;
  return first;
}

function craftScore(bullets: readonly Bullet[], lines: readonly number[]): number {
  if (bullets.length === 0) return CV_WEIGHTS.craft / 3;
  const half = CV_WEIGHTS.craft / 3;
  const verbs = bullets.map((bullet) => openingVerb(bullet.text));
  const verbFirst = verbs.filter((verb) => verb !== null).length / bullets.length;
  const sized =
    bullets.filter((bullet, i) => {
      const count = wordCount(bullet.text);
      return (
        count >= BULLET_WORDS.min &&
        count <= BULLET_WORDS.max &&
        (lines[i] ?? 1) <= BULLET_MAX_LINES
      );
    }).length / bullets.length;
  const counts = new Map<string, number>();
  for (const verb of verbs) if (verb !== null) counts.set(verb, (counts.get(verb) ?? 0) + 1);
  const repeated = [...counts.values()].filter((count) => count > 2).length;
  return half * verbFirst + half * sized + Math.max(0, half - (half / 2) * repeated);
}

// ---- 6. Structure and note ----

function companyName(company: string): string {
  return foldText(company)
    .split(' ')
    .filter((word) => word !== '' && !LEGAL_SUFFIXES.has(word))
    .join(' ');
}

function structureScore(content: Content, company: string, findings: readonly Finding[]): number {
  const quarter = CV_WEIGHTS.structure / 4;
  let score = 0;

  const summary = content.summary?.text;
  const sentences = (summary ?? '').split(/(?<=[.!?])\s+/).filter((part) => part.trim() !== '');
  if (
    summary !== undefined &&
    sentences.length >= 1 &&
    sentences.length <= 2 &&
    summary.length <= SUMMARY_MAX_CHARS
  ) {
    score += quarter;
  }

  const newest = content.experience[0];
  const empty = [...content.experience, ...content.projects].some(
    (entry) => entry.bullets.length === 0,
  );
  if (!empty && (newest === undefined || newest.bullets.length >= 2)) score += quarter;

  if (content.skills.length >= SKILLS.min && content.skills.length <= SKILLS.max) score += quarter;

  const note = content.coverNote.paragraphs.map((paragraph) => paragraph.text).join(' ');
  const words = wordCount(note);
  const name = companyName(company);
  const namesCompany = name !== '' && ` ${foldText(note)} `.includes(` ${name} `);
  const clicheOpener = findings.some(
    (finding) => finding.code === 'cliche' && finding.path === 'coverNote.paragraphs[0]',
  );
  if (words >= NOTE_WORDS.min && words <= NOTE_WORDS.max && namesCompany && !clicheOpener) {
    score += quarter;
  }
  return score;
}

// ---- 7. The cover note (rubric v2) ----

function trigrams(text: string): Set<string> {
  const words = foldText(text)
    .split(' ')
    .filter((word) => word !== '');
  const out = new Set<string>();
  for (let i = 0; i + 2 < words.length; i += 1) out.add(words.slice(i, i + 3).join(' '));
  return out;
}

/** 0.25 for the prompt's length, 0.5 for no stock opener, 0.25 for not repeating the bullets. */
function noteScore(content: Content, bullets: readonly Bullet[]): number {
  const paragraphs = content.coverNote.paragraphs.map((paragraph) => paragraph.text);
  const note = paragraphs.join(' ');
  const words = wordCount(note);
  if (words === 0) return 0;
  let score = 0;
  if (words >= NOTE_PROMPT_WORDS.min && words <= NOTE_PROMPT_WORDS.max) {
    score += CV_WEIGHTS.note * 0.25;
  }
  if (!NOTE_STOCK_OPENER.test(paragraphs[0] ?? '')) score += CV_WEIGHTS.note * 0.5;
  const mine = trigrams(note);
  const theirs = trigrams(bullets.map((bullet) => bullet.text).join(' . '));
  const shared = [...mine].filter((gram) => theirs.has(gram)).length;
  if (mine.size === 0 || shared / mine.size <= NOTE_MAX_OVERLAP) {
    score += CV_WEIGHTS.note * 0.25;
  }
  return score;
}

// ---- Total ----

export function scoreCv(input: CvScoreInput): CvScore {
  const { content, facts, aliases, layout } = input;
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const factOf = (ref: string): CvFact | undefined => {
    const id = aliases.get(ref);
    return id === undefined ? undefined : byId.get(id);
  };
  const activeIds = new Set(facts.filter((fact) => fact.status === 'active').map((f) => f.id));

  const findings = lintCv(content, facts, aliases, { jobTitle: input.jobTitle });
  for (let i = 0; i < layout.headingWraps; i += 1) {
    findings.push(makeFinding('heading_wraps', 'headings'));
  }

  const bullets = bulletsOf(content);
  const raw: Record<CvCriterion, number> = {
    fill: fillScore(layout),
    writing: writingScore(findings),
    numbers: numbersScore(bullets, factOf),
    tailoring: tailoringScore(input.requirements, activeIds, citedIds(content, aliases)),
    craft: craftScore(bullets, layout.bulletLines),
    structure: structureScore(content, input.company, findings),
    note: noteScore(content, bullets),
  };
  const criteria = Object.fromEntries(
    CV_CRITERIA.map((name) => [name, round2(raw[name])]),
  ) as Record<CvCriterion, number>;

  const hard = findings.some((finding) => finding.severity === 'hard');
  const sum = CV_CRITERIA.reduce((total, name) => total + raw[name], 0);
  const total = round2(hard ? Math.min(sum, CV_HARD_FINDING_CAP) : sum);
  return {
    rubric: CV_RUBRIC_VERSION,
    total,
    uncapped: round2(sum),
    criteria,
    findings,
    gatePassed: !hard && total >= (input.target ?? CV_SCORE_TARGET),
  };
}
