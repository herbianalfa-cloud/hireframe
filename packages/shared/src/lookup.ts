import { z } from 'zod';

import { canonicalAlertUrl, canonicalLinkedInJobUrl, linkedInJobId } from './alerts/links.js';
import { JOB_LIMITS } from './jobs.js';
import { keysFromUrl, parseLocation } from './normalise.js';
import { VERDICTS } from './funnel.js';

/**
 * Lookup (PRD R8, ADR-049), pure: what the owner pastes, the match keys it yields, the rows of a
 * pasted LinkedIn results page, and the `lookup` callable's input and output. Nothing here
 * fetches anything; LinkedIn pages are never requested (ADR-004), only text the owner pastes.
 */

export const LOOKUP_LIMITS = {
  /** URLs read from one paste box. */
  urls: 100,
  /** Jobs read from one pasted results page, and jobs one `add` may carry. */
  rows: 50,
  /** Characters of pasted text the callable accepts for a fallback parse. */
  pasteChars: 100_000,
  /** Anchors the paste handler may send with a fallback parse. */
  links: 200,
  /** A pasted description (the stored description limit). */
  description: JOB_LIMITS.description,
} as const;

// ---- Match: URLs → keys ----

export interface LookupTarget {
  /** The URL as stored on jobs: tracking parameters dropped, LinkedIn views reduced to `/jobs/view/{id}`. */
  url: string;
  /** Source keys the URL identifies (`linkedin:{id}`, `greenhouse:{id}`...); may be empty. */
  keys: string[];
  linkedinId?: string;
  ats?: AtsPosting;
}

export const ATS_POSTING_TYPES = ['greenhouse', 'lever', 'ashby', 'workable'] as const;
export type AtsPostingType = (typeof ATS_POSTING_TYPES)[number];

/** A job URL on one of the four public job boards: enough to ask the board's official API. */
export interface AtsPosting {
  type: AtsPostingType;
  token: string;
  /** The board's own posting ID (Greenhouse number, Lever/Ashby UUID, Workable shortcode). */
  id: string;
  /** Lever's EU-hosted boards. */
  host?: 'eu';
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** The board, token and posting ID in a job URL; null for anything else (never guessed). */
export function parseAtsUrl(url: string): AtsPosting | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;
  if (/^(boards|job-boards)(\.eu)?\.greenhouse\.io$/.test(host)) {
    const match = /^\/([A-Za-z0-9_-]+)\/jobs\/(\d+)/.exec(path);
    if (match?.[1] && match[2]) return { type: 'greenhouse', token: match[1], id: match[2] };
  } else if (/^jobs(\.eu)?\.lever\.co$/.test(host)) {
    const match = new RegExp(`^/([A-Za-z0-9_.-]+)/(${UUID})`, 'i').exec(path);
    if (match?.[1] && match[2]) {
      return {
        type: 'lever',
        token: match[1],
        id: match[2].toLowerCase(),
        ...(host === 'jobs.eu.lever.co' ? { host: 'eu' as const } : {}),
      };
    }
  } else if (host === 'jobs.ashbyhq.com') {
    const match = new RegExp(`^/([A-Za-z0-9_.%-]+)/(${UUID})`, 'i').exec(path);
    if (match?.[1] && match[2]) {
      return { type: 'ashby', token: decodeURIComponent(match[1]), id: match[2].toLowerCase() };
    }
  } else if (host === 'apply.workable.com') {
    const match = /^\/([A-Za-z0-9_-]+)\/j\/([A-Za-z0-9]+)/.exec(path);
    if (match?.[1] && match[2]) return { type: 'workable', token: match[1], id: match[2] };
  }
  return null;
}

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;

/**
 * Every URL in a paste, as match targets (at most `LOOKUP_LIMITS.urls`, repeats collapsed). A
 * LinkedIn job link is reduced to `https://www.linkedin.com/jobs/view/{id}`, which is how alert
 * jobs store theirs; a search page with `currentJobId` yields that ID's key.
 */
export function parseLookupInput(text: string): LookupTarget[] {
  const targets: LookupTarget[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = match[0].replace(/[.,;:!?)\]}>]+$/, '');
    const id = linkedInJobId(raw);
    const url = id ? canonicalLinkedInJobUrl(id) : canonicalAlertUrl(raw);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const keys = keysFromUrl(id ? url : raw);
    const linkedinKey = keys.find((key) => key.startsWith('linkedin:'));
    const linkedinId = linkedinKey?.slice('linkedin:'.length);
    const ats = parseAtsUrl(url);
    targets.push({
      url,
      keys,
      ...(linkedinId ? { linkedinId } : {}),
      ...(ats ? { ats } : {}),
    });
    if (targets.length >= LOOKUP_LIMITS.urls) break;
  }
  return targets;
}

// ---- A pasted LinkedIn results page ----

export const LinkedinId = z.string().regex(/^\d{6,20}$/);

/** One job read from a pasted results page. */
export const LookupRowSchema = z.object({
  title: z.string().trim().min(1).max(JOB_LIMITS.title),
  company: z.string().trim().min(1).max(JOB_LIMITS.company),
  location: z.string().trim().max(JOB_LIMITS.location),
  /** The card's age text as shown ("3 days ago"); the server turns it into an approximate date. */
  age: z.string().trim().min(1).max(60).exactOptional(),
  /** From the card's title link, never from text. */
  linkedinId: LinkedinId.exactOptional(),
});
export type LookupRow = z.infer<typeof LookupRowSchema>;

/** An `<a>`'s `href` and text, as the paste handler reads them (nothing else leaves the helper). */
export const PasteLinkSchema = z.object({
  href: z.string().max(JOB_LIMITS.url),
  text: z.string().max(300),
});
export type PasteLink = z.infer<typeof PasteLinkSchema>;

/** Lines that decorate a card but carry no job data. */
const NOISE = [
  /^promoted$/i,
  /^viewed$/i,
  /^saved$/i,
  /^new$/i,
  /^applied$/i,
  /^easy apply$/i,
  /^actively (recruiting|reviewing applicants)$/i,
  /^be an early applicant$/i,
  /^top applicant$/i,
  /^dismiss\b/i,
  /^\d+\+? (applicants?|connections?|school alumni|alumni|people clicked apply)\b/i,
  /^\d+ (connection|alum)/i,
  /^(\d+ )?results?$/i,
  /^\d+ (new )?jobs?\b/i,
];
const SALARY_LINE = /^[£$€]\s?\d.*(\/(yr|hr|mo)|per (year|hour|month|annum|day)|\bk\b)/i;
const AGE_LINE =
  /^(?:(?:reposted|posted)\s+)?(just now|\d+\s*(?:second|minute|hour|day|week|month)s?\s+ago)\b/i;
const MODE_SUFFIX = /\((remote|hybrid|on-?site)\)\s*$/i;
const VERIFICATION_SUFFIX = /\s+with verification$/i;

function isNoise(line: string): boolean {
  return NOISE.some((pattern) => pattern.test(line)) || SALARY_LINE.test(line);
}

function isLocationLine(line: string): boolean {
  // A place, not a sentence that happens to name one.
  if (line.length > 80 || line.split(' ').length > 9 || /[.!?]$/.test(line)) return false;
  return MODE_SUFFIX.test(line) || parseLocation(line).country !== 'unknown';
}

function titleKey(text: string): string {
  return text.replace(VERIFICATION_SUFFIX, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Jobs on a pasted LinkedIn results page (plain text of "select all, copy"), at most 50. A card
 * is the lines around its location line: title (often shown twice), company, location, then
 * badges, salary and an age line such as "3 days ago", "Reposted 1 week ago" or "Just now".
 * `links` are the page's anchors (href and text) from the paste's HTML; each card's title is
 * paired with the first unused `/jobs/view/{id}` anchor of the same text, in page order, which is
 * the only way a LinkedIn ID is read. Without links the rows have no ID and match by title,
 * company and city. Pure and tolerant: a card that doesn't fit the shape is left out, not guessed.
 */
export function parseResultsPage(text: string, links: readonly PasteLink[] = []): LookupRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '' && !(isNoise(line) && !AGE_LINE.test(line)));

  const locations: number[] = [];
  lines.forEach((line, index) => {
    if (index >= 2 && !AGE_LINE.test(line) && isLocationLine(line)) locations.push(index);
  });

  const rows: LookupRow[] = [];
  let anchor = 0;
  locations.forEach((at, order) => {
    const company = lines[at - 1];
    const title = lines[at - 2];
    const location = lines[at];
    if (!company || !title || !location || company.length > 120 || title.length > 200) return;
    // A line just before the location that is itself a location or an age isn't a company.
    if (AGE_LINE.test(company) || AGE_LINE.test(title) || locations.includes(at - 1)) return;
    const nextTitleAt = (locations[order + 1] ?? lines.length + 3) - 3;
    const age = lines
      .slice(at + 1, Math.max(at + 1, nextTitleAt + 1))
      .map((line) => AGE_LINE.exec(line)?.[0])
      .find((found): found is string => found !== undefined);

    const wanted = titleKey(title);
    let linkedinId: string | undefined;
    for (let i = anchor; i < links.length; i += 1) {
      const link = links[i];
      if (!link || titleKey(link.text) !== wanted) continue;
      const id = linkedInJobId(link.href);
      if (!id) continue;
      linkedinId = id;
      anchor = i + 1;
      break;
    }

    const row = LookupRowSchema.safeParse({
      title: title.replace(VERIFICATION_SUFFIX, ''),
      company,
      location: location.replace(MODE_SUFFIX, '').trim(),
      ...(age ? { age } : {}),
      ...(linkedinId ? { linkedinId } : {}),
    });
    if (row.success) rows.push(row.data);
  });
  return rows.slice(0, LOOKUP_LIMITS.rows);
}

const AGE_MS: Readonly<Record<string, number>> = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
};

/** An approximate posting date from an age such as "3 days ago" (a month counts as 30 days). */
export function ageToPostedAt(age: string, now: Date): Date | undefined {
  const match = AGE_LINE.exec(age.trim());
  const found = match?.[1]?.toLowerCase();
  if (!found) return undefined;
  if (found === 'just now') return new Date(now.getTime());
  const parts = /^(\d+)\s*([a-z]+?)s?\s+ago$/.exec(found);
  const unit = parts?.[2] ? AGE_MS[parts[2]] : undefined;
  if (!parts?.[1] || unit === undefined) return undefined;
  return new Date(now.getTime() - Number(parts[1]) * unit);
}

// ---- The `lookup` callable ----

const Text = (max: number) => z.string().trim().min(1).max(max);

export const LookupJobInputSchema = z.discriminatedUnion('kind', [
  LookupRowSchema.extend({ kind: z.literal('row') }),
  /** A job-board URL (Greenhouse, Lever, Ashby, Workable): fetched from the board's official API. */
  z.object({ kind: z.literal('url'), url: z.url({ protocol: /^https?$/ }).max(JOB_LIMITS.url) }),
]);
export type LookupJobInput = z.infer<typeof LookupJobInputSchema>;

export const LookupInputSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('add'),
    jobs: z.array(LookupJobInputSchema).min(1).max(LOOKUP_LIMITS.rows),
  }),
  z.object({
    action: z.literal('describe'),
    jobId: Text(200),
    text: Text(LOOKUP_LIMITS.description),
  }),
  /** The one cheap-model parse of a results page the deterministic parser couldn't read. */
  z.object({
    action: z.literal('parse'),
    text: Text(LOOKUP_LIMITS.pasteChars),
    links: z.array(PasteLinkSchema).max(LOOKUP_LIMITS.links),
  }),
]);
export type LookupInput = z.infer<typeof LookupInputSchema>;

/** Why a job is queued for the next scan instead of judged now. */
export const LOOKUP_QUEUE_REASONS = [
  'daily_cap',
  'monthly_cap',
  'no_profile',
  'time',
  'error',
] as const;
export type LookupQueueReason = (typeof LOOKUP_QUEUE_REASONS)[number];

export const LookupOutcomeSchema = z.discriminatedUnion('status', [
  /** Already known: nothing was created. */
  z.object({ status: z.literal('seen'), jobId: z.string() }),
  /** A verdict now (`apply`, `near_miss`, `wildcard` or `skip` from S3). */
  z.object({ status: z.literal('judged'), jobId: z.string(), verdict: z.enum(VERDICTS) }),
  /** S1 or S2 said no, for free or for a fraction of a penny. */
  z.object({
    status: z.literal('skipped'),
    jobId: z.string(),
    stage: z.enum(['s1', 's2']),
    ruleId: z.string().exactOptional(),
    note: z.string().exactOptional(),
  }),
  z.object({ status: z.literal('needs_description'), jobId: z.string() }),
  z.object({
    status: z.literal('queued'),
    jobId: z.string(),
    reason: z.enum(LOOKUP_QUEUE_REASONS),
  }),
  /** The model's output was unusable after one retry: the job is up for review. */
  z.object({ status: z.literal('review'), jobId: z.string() }),
  /** A URL that isn't a supported job board, or a posting the board no longer lists. */
  z.object({ status: z.literal('not_found') }),
  /** The row couldn't become a job (unusable text), or its write failed. Nothing was created. */
  z.object({ status: z.literal('invalid') }),
]);
export type LookupOutcome = z.infer<typeof LookupOutcomeSchema>;

export const LookupAddResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('done'),
    /** One per input job, in input order. */
    outcomes: z.array(LookupOutcomeSchema),
    /** Set when a cap stopped model calls: those jobs were queued for the next scan. */
    capReached: z.enum(['daily', 'monthly']).nullable(),
  }),
  /** A scan or import held the lock for the whole wait; nothing was created. */
  z.object({ status: z.literal('busy'), retryAfterSeconds: z.int().min(1) }),
]);
export type LookupAddResult = z.infer<typeof LookupAddResultSchema>;

export const LookupDescribeResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('judged'), verdict: z.enum(VERDICTS) }),
  z.object({
    status: z.literal('skipped'),
    stage: z.enum(['s1', 's2']),
    ruleId: z.string().exactOptional(),
    note: z.string().exactOptional(),
  }),
  /** A cap stopped the model: the text is saved and the next scan judges the job. */
  z.object({ status: z.literal('queued'), reason: z.enum(LOOKUP_QUEUE_REASONS) }),
  z.object({ status: z.literal('review') }),
  /** The job isn't waiting for a description (it moved on, or someone else is describing it). */
  z.object({ status: z.literal('refused') }),
]);
export type LookupDescribeResult = z.infer<typeof LookupDescribeResultSchema>;

export const LookupParseResultSchema = z.object({
  status: z.literal('parsed'),
  rows: z.array(LookupRowSchema).max(LOOKUP_LIMITS.rows),
  /** The daily Lookup cap or the monthly cap stopped the parse: paste a smaller page or wait. */
  capReached: z.enum(['daily', 'monthly']).nullable(),
});
export type LookupParseResult = z.infer<typeof LookupParseResultSchema>;

export type LookupResult = LookupAddResult | LookupDescribeResult | LookupParseResult;
