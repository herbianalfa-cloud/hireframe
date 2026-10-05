import type { CriteriaContent } from './criteria.js';
import type { ExperienceAsk, JobFlag } from './funnel.js';
import type { Country, RemoteMode } from './jobs.js';
import { foldText, normaliseCompany } from './normalise.js';
import type { WorkRights } from './profile.js';
import { checkTitle } from './titles.js';

/**
 * S1 hard rules (docs/FUNNEL.md "S1", ADR-033). Pure and free: every decision comes from the
 * criteria version, the owner's work rights and the job's own text. A skip carries a rule ID so
 * the job can show what stopped it (PRD R6). Unknown titles always pass, so wildcards survive.
 *
 * Rule IDs: `title:<id>`, `company`, `keyword:<term>`, `location`, `freshness`,
 * `blocker:sc-clearance`, `blocker:dv-clearance`, `blocker:driving-licence`,
 * `blocker:right-to-work`, `blocker:<slug>` (a custom blocker phrase), `experience`.
 */

export interface S1Job {
  title: string;
  company: string;
  country: Country;
  remote: RemoteMode;
  postedAt?: Date;
  firstSeenAt: Date;
}

export type S1Result =
  | { pass: true; flags: JobFlag[]; sortAt: Date; experienceAsk?: ExperienceAsk }
  | { pass: false; ruleId: string; flags: JobFlag[]; sortAt: Date; experienceAsk?: ExperienceAsk };

const DAY_MS = 24 * 60 * 60 * 1000;

/** Queue order and freshness: the posting date, else the first-seen date (a lower bound on age). */
export function sortDate(job: Pick<S1Job, 'postedAt' | 'firstSeenAt'>): Date {
  return job.postedAt ?? job.firstSeenAt;
}

/** Jobs whose `sortAt` is before this are stale: `now − freshness_days`. */
export function freshnessCutoff(
  criteria: Pick<CriteriaContent, 'freshness_days'>,
  now: Date,
): Date {
  return new Date(now.getTime() - criteria.freshness_days * DAY_MS);
}

/**
 * True when the job is older than `freshness_days`. Without a posting date the first-seen date is
 * used: a job first seen 20 days ago was posted at least 20 days ago. Used by S1, by the expiry
 * sweep and again when a queued job is taken off the S2/S3 queue.
 */
export function isExpired(
  job: Pick<S1Job, 'postedAt' | 'firstSeenAt'>,
  criteria: Pick<CriteriaContent, 'freshness_days'>,
  now: Date,
): boolean {
  return now.getTime() - sortDate(job).getTime() > criteria.freshness_days * DAY_MS;
}

// ---- Words and phrases ----

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word, case- and accent-insensitive phrase match on folded text. */
function hasPhrase(folded: string, phrase: string): boolean {
  const needle = foldText(phrase);
  return needle !== '' && new RegExp(`(^| )${escape(needle)}( |$)`).test(folded);
}

function slug(text: string): string {
  return foldText(text).replace(/ /g, '-').slice(0, 60) || 'custom';
}

// ---- Companies ----

/**
 * `excluded_companies` entries are company names, except these known group labels from the seed,
 * which expand to the companies they mean. A group can also need a title cue (graduate schemes).
 */
const COMPANY_GROUPS: readonly {
  label: RegExp;
  companies: readonly string[];
  titleCue?: RegExp;
}[] = [
  {
    label: /big four/i,
    companies: ['Deloitte', 'PwC', 'PricewaterhouseCoopers', 'EY', 'Ernst & Young', 'KPMG'],
    titleCue: /\b(graduate|grad|trainee|scheme|programme|program|intern|placement)\b/i,
  },
  {
    label: /train[- ]and[- ]deploy|sparta global/i,
    companies: [
      'Sparta Global',
      'FDM Group',
      'FDM',
      'mthree',
      'Wiley Edge',
      'Revature',
      'Grads in Tech',
      'Mthree Consulting',
    ],
  },
];

function companyExcluded(job: S1Job, criteria: CriteriaContent): boolean {
  const company = normaliseCompany(job.company);
  if (company === '') return false;
  for (const entry of criteria.excluded_companies) {
    const group = COMPANY_GROUPS.find((candidate) => candidate.label.test(entry));
    if (group) {
      const named = group.companies.some((name) => normaliseCompany(name) === company);
      if (named && (!group.titleCue || group.titleCue.test(job.title))) return true;
    } else if (normaliseCompany(entry) === company) {
      return true;
    }
  }
  return false;
}

// ---- Blockers ----

const SC =
  /\b(?:SC[- ]?(?:clearance|cleared|clearable|vetted|vetting)|security check(?:ed)?\s*\(\s*SC\s*\)|security clearance\s*\(\s*SC\s*\))/i;
const DV = /\b(?:DV[- ]?(?:clearance|cleared|clearable|vetted|vetting)|developed vetting)\b/i;
const DRIVING = new RegExp(
  [
    String.raw`\b(?:full|valid|clean)\s+(?:UK\s+)?driving\s+licen[cs]e\b[^.\n]{0,40}\b(?:required|essential|is a must|needed|mandatory)\b`,
    String.raw`\b(?:must|required to|need to|will need to)\s+(?:have|hold)\s+a\s+(?:full\s+|valid\s+|clean\s+)*(?:UK\s+)?driving\s+licen[cs]e\b`,
    String.raw`\bdriving\s+licen[cs]e\s+(?:is\s+)?(?:required|essential|mandatory)\b`,
  ].join('|'),
  'i',
);

/** Wording that excludes anyone without permanent or settled status. */
const INDEFINITE_RIGHT = new RegExp(
  [
    String.raw`\bindefinite\s+(?:leave\s+to\s+remain|right\s+to\s+(?:work|remain))\b`,
    String.raw`\bILR\b`,
    String.raw`\bsettled\s+status\s+(?:is\s+)?(?:required|essential)\b`,
    String.raw`\bmust\s+(?:have|hold)\s+(?:pre-?settled\s+or\s+)?settled\s+status\b`,
    String.raw`\b(?:British|UK)\s+(?:citizens?|nationals?|passport\s+holders?)\s+only\b`,
    String.raw`\bmust\s+be\s+a\s+(?:British|UK)\s+(?:citizen|national)\b`,
    String.raw`\bsole\s+(?:British|UK)\s+nationality\b`,
    String.raw`\b(?:unrestricted|permanent)\s+right\s+to\s+work\b`,
    String.raw`\b(?:not|unable\s+to|cannot|can't)\s+(?:accept|consider)\b[^.\n]{0,40}\b(?:graduate\s+visas?|time[- ]limited|temporary\s+visas?|visa\s+holders?)\b`,
  ].join('|'),
  'i',
);

/** Wording that excludes anyone who needs sponsorship. */
const NO_SPONSORSHIP = new RegExp(
  [
    String.raw`\b(?:no|not\s+able\s+to|unable\s+to|cannot|can't|can\s+not|do\s+not|don't|does\s+not|will\s+not|won't|are\s+not\s+able\s+to)\s+(?:currently\s+)?(?:offer|provide|support|consider)?\s*(?:visa\s+)?sponsor(?:ship|ing)?\b`,
    String.raw`\bsponsorship\s+(?:is\s+)?not\s+(?:available|offered|provided|possible)\b`,
    String.raw`\bwithout\s+(?:the\s+need\s+for\s+)?(?:visa\s+)?sponsorship\b`,
    String.raw`\bmust\s+(?:already\s+)?(?:have|hold)\s+(?:the\s+|a\s+)?(?:full\s+)?right\s+to\s+work\s+in\s+the\s+UK\b`,
    String.raw`\b(?:applicants|candidates|you)\s+must\s+(?:already\s+)?(?:have|hold)\s+(?:the\s+|a\s+)?right\s+to\s+work\b`,
  ].join('|'),
  'i',
);

const RIGHT_TO_WORK_WORDING = new RegExp(
  `${INDEFINITE_RIGHT.source}|${NO_SPONSORSHIP.source}`,
  'i',
);

/**
 * Whether the text's right-to-work wording excludes these work rights: time-limited permission
 * fails "indefinite/settled/citizens only"; needing sponsorship also fails "no sponsorship".
 */
export function rightToWorkBlocks(text: string, workRights: WorkRights): boolean {
  switch (workRights) {
    case 'unrestricted':
      return false;
    case 'time_limited':
      return INDEFINITE_RIGHT.test(text);
    case 'needs_sponsorship':
      return INDEFINITE_RIGHT.test(text) || NO_SPONSORSHIP.test(text);
  }
}

/** The patterns S1 skips on, for the S2 diagnostics to sort a model's blocker text the same way. */
export const BLOCKER_PATTERNS = {
  sc: SC,
  dv: DV,
  driving: DRIVING,
  rightToWork: RIGHT_TO_WORK_WORDING,
} as const;

/** Known blocker labels from the seed, by what they mean. Anything else is a literal phrase. */
function blockerKind(label: string): 'sc' | 'dv' | 'driving' | 'rtw' | null {
  const folded = foldText(label);
  if (/(^| )sc( |$)/.test(folded)) return 'sc';
  if (/(^| )dv( |$)/.test(folded)) return 'dv';
  if (folded.includes('driving')) return 'driving';
  if (folded.includes('sponsorship') || folded.includes('right to work')) return 'rtw';
  return null;
}

/**
 * True when `text` hits one of the criteria's blockers (the same patterns S1 skips on). S3's
 * hard-blocker cap applies only on such a match, never on the model's say-so (ADR-034).
 */
export function hitsCriteriaBlocker(
  text: string,
  criteria: Pick<CriteriaContent, 'blockers'>,
  workRights: WorkRights | null,
): boolean {
  const folded = foldText(text);
  return criteria.blockers.some((label) => {
    const kind = blockerKind(label);
    if (kind === 'sc') return SC.test(text);
    if (kind === 'dv') return DV.test(text);
    if (kind === 'driving') return DRIVING.test(text);
    if (kind === 'rtw') return workRights !== null && rightToWorkBlocks(text, workRights);
    return hasPhrase(folded, label);
  });
}

// ---- Experience ----

const YEARS = /\b(\d{1,2})\s*(?:\+|plus)?\s*(?:(?:-|–|to)\s*\d{1,2}\s*\+?\s*)?(?:years?|yrs)\b/gi;
const EXPERIENCE_CONTEXT =
  /\b(?:experience|experienced|background|track record|working in|in a similar role|in a .{0,30} role)\b/i;
const NICE =
  /\b(?:preferred|preferable|nice to have|nice-to-have|desirable|ideally|bonus|a plus|advantage|advantageous|beneficial|would be great|helpful)\b/i;
const REQUIRED =
  /\b(?:required|requires?|must|essential|minimum|at least|you have|you'll have|you will have|you bring|need|needs|proven)\b/i;

interface YearsAsk {
  years: number;
  kind: 'required' | 'preferred' | 'ambiguous';
}

/** Every "N years" ask that is about experience, with how it is phrased. */
export function experienceAsks(text: string): YearsAsk[] {
  const asks: YearsAsk[] = [];
  for (const sentence of text.split(/(?<=[.!?;])\s+|\n+|•/)) {
    if (!EXPERIENCE_CONTEXT.test(sentence)) continue;
    for (const match of sentence.matchAll(YEARS)) {
      const years = Number(match[1]);
      if (!Number.isFinite(years) || years > 30) continue;
      const kind = NICE.test(sentence)
        ? 'preferred'
        : REQUIRED.test(sentence)
          ? 'required'
          : 'ambiguous';
      asks.push({ years, kind });
    }
  }
  return asks;
}

// ---- The rules ----

export interface S1Input {
  job: S1Job;
  /** The description text (full or snippet). Untrusted, only pattern-matched. */
  text: string;
  criteria: CriteriaContent;
  /** Null until the owner sets it on the Profile screen; then no right-to-work skips. */
  workRights: WorkRights | null;
  now: Date;
  /** Seniority rule IDs for the title check; the default is `SENIORITY_TITLE_IDS`. */
  seniorityTitleIds?: readonly string[];
}

export function applyHardRules(input: S1Input): S1Result {
  const { job, text, criteria, workRights, now, seniorityTitleIds } = input;
  const flags: JobFlag[] = [];
  const sortAt = sortDate(job);
  if (job.postedAt === undefined) flags.push('freshness_unknown');

  const skip = (ruleId: string, experienceAsk?: ExperienceAsk): S1Result => ({
    pass: false,
    ruleId,
    flags,
    sortAt,
    ...(experienceAsk ? { experienceAsk } : {}),
  });

  const title = checkTitle(job.title, criteria, seniorityTitleIds);
  if (title.excludedBy) return skip(`title:${title.excludedBy}`);
  if (companyExcluded(job, criteria)) return skip('company');

  const foldedTitle = foldText(job.title);
  const foldedText = foldText(text);
  for (const keyword of criteria.excluded_keywords) {
    if (hasPhrase(foldedTitle, keyword) || hasPhrase(foldedText, keyword)) {
      return skip(`keyword:${slug(keyword)}`);
    }
  }

  // Remote jobs elsewhere ("Remote, Europe") go on to S2, which can tell whether the UK counts.
  if (job.country === 'other' && job.remote !== 'remote') return skip('location');
  if (isExpired(job, criteria, now)) return skip('freshness');

  for (const label of criteria.blockers) {
    const kind = blockerKind(label);
    if (kind === 'sc' && SC.test(text)) return skip('blocker:sc-clearance');
    if (kind === 'dv' && DV.test(text)) return skip('blocker:dv-clearance');
    if (kind === 'driving' && DRIVING.test(text)) return skip('blocker:driving-licence');
    if (kind === 'rtw') {
      if (workRights === null) {
        if (RIGHT_TO_WORK_WORDING.test(text)) flags.push('work_rights_unknown');
      } else if (rightToWorkBlocks(text, workRights)) {
        return skip('blocker:right-to-work');
      }
    }
    if (kind === null && hasPhrase(foldedText, label)) return skip(`blocker:${slug(label)}`);
  }

  const cap = criteria.experience_cap_years;
  const asks = experienceAsks(text);
  if (asks.some((ask) => ask.kind === 'required' && ask.years > cap)) {
    const highest = Math.max(...asks.filter((ask) => ask.kind === 'required').map((a) => a.years));
    return skip('experience', { years: highest, required: true });
  }
  if (asks.some((ask) => ask.kind === 'ambiguous' && ask.years > cap)) {
    flags.push('experience_ambiguous');
  }
  // The highest ask that survives drives the luck penalty (score.ts).
  const top = [...asks].sort((a, b) => b.years - a.years)[0];
  const experienceAsk = top ? { years: top.years, required: top.kind === 'required' } : undefined;
  return { pass: true, flags, sortAt, ...(experienceAsk ? { experienceAsk } : {}) };
}
