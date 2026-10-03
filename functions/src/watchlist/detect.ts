import { normaliseCompany, parseLocation, type AtsType, type CompanySeed } from '@hireframe/shared';
import { z } from 'zod';

import { HttpError, type HttpClient } from '../http/client.js';
import { ashbyBoardUrl, AshbyJobSchema, ashbyToRawJob } from '../sources/ashby.js';
import { arrayEnvelope, keyedEnvelope } from '../sources/ats.js';
import { GreenhouseJobSchema, greenhouseToRawJob } from '../sources/greenhouse.js';
import { leverBoardUrl, LeverPostingSchema, leverToRawJob } from '../sources/lever.js';
import { WorkableJobSchema, workableToRawJob } from '../sources/workable.js';

/**
 * Watchlist ATS detection (ADR-031). Candidates come from people; this only probes the official
 * job-board APIs for board tokens guessed from the name and domain, or parses a careers URL the
 * owner pasted. No careers page is ever fetched. Pure helpers plus one prober.
 */

export type DetectedAts = Exclude<AtsType, 'none'>;

export interface Candidate {
  name: string;
  domain: string;
  hq: string;
  careersUrl?: string;
}

export interface BoardHit {
  type: DetectedAts;
  token: string;
  host?: 'eu';
  /** The board's own name, when the API gives one (Greenhouse, Workable). */
  boardName?: string;
  jobs: number;
  ukJobs: number;
}

/** `unchecked`: a probe failed (rate limit, timeout), so "nothing found" can't be trusted. */
export type ReviewStatus = 'confirmed' | 'review' | 'not-found' | 'unchecked';

export interface Detection {
  candidate: Candidate;
  status: ReviewStatus;
  hit?: BoardHit;
  /** Every board found, when there was more than one. */
  others: BoardHit[];
  /** Probes that failed for a reason other than "no such board", e.g. `workable:acme`. */
  failed?: string[];
}

// ---- Pure helpers ----

/** A CSV cell with content, or undefined for missing and blank cells. */
export function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined;
}

export function slugify(name: string): string {
  return normaliseCompany(name).replace(/ /g, '-').slice(0, 80);
}

/** Likely board tokens: `acme`, `acmeanalytics`, `acme-analytics`, and the domain label. */
export function tokenCandidates(name: string, domain: string): string[] {
  const words = normaliseCompany(name).split(' ').filter(Boolean);
  const label =
    domain
      .toLowerCase()
      .replace(/^www\./, '')
      .split('.')[0] ?? '';
  const tokens = [words.join(''), words.join('-'), label, words[0] ?? ''];
  return [...new Set(tokens.filter((token) => /^[a-z0-9-]{2,60}$/.test(token)))].slice(0, 4);
}

/** A board token from a pasted careers or job URL on a known ATS host. No fetch. */
export function atsFromUrl(url: string): Pick<BoardHit, 'type' | 'token' | 'host'> | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const first = parsed.pathname.split('/').find((part) => part !== '');
  const forParam = parsed.searchParams.get('for');
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    const token = forParam ?? first;
    return token && token !== 'embed' ? { type: 'greenhouse', token } : null;
  }
  if (host === 'jobs.lever.co' && first) return { type: 'lever', token: first };
  if (host === 'jobs.eu.lever.co' && first) return { type: 'lever', token: first, host: 'eu' };
  if (host === 'jobs.ashbyhq.com' && first) return { type: 'ashby', token: first };
  if (host === 'apply.workable.com' && first && first !== 'j')
    return { type: 'workable', token: first };
  const sub = /^([a-z0-9-]+)\.workable\.com$/.exec(host)?.[1];
  if (sub && !['www', 'apply', 'jobs'].includes(sub)) return { type: 'workable', token: sub };
  return null;
}

/**
 * Exact match after normalisation (case, punctuation, legal suffixes, a trailing "Group",
 * a "Careers at" prefix, bracketed or " - " suffixes). A prefix is not enough: "Wise" is not
 * "Wise Worksite Field Sales", and "Peak" is not "Peak Physical Therapy" (review instead).
 */
export function namesMatch(boardName: string, companyName: string): boolean {
  const clean = (name: string) =>
    normaliseCompany(
      name
        .replace(/\([^)]*\)/g, ' ')
        .replace(/\s[-–|]\s.*$/, '')
        .replace(/^\s*(careers|jobs)\s+at\s+/i, ''),
    )
      .replace(/ group$/, '')
      .replace(/ /g, '');
  const a = clean(boardName);
  const b = clean(companyName);
  return a !== '' && a === b;
}

/** The human-facing board page, for the owner's review. */
export function boardPageUrl(hit: Pick<BoardHit, 'type' | 'token' | 'host'>): string {
  switch (hit.type) {
    case 'greenhouse':
      return `https://job-boards.greenhouse.io/${hit.token}`;
    case 'lever':
      return `https://jobs${hit.host === 'eu' ? '.eu' : ''}.lever.co/${hit.token}`;
    case 'ashby':
      return `https://jobs.ashbyhq.com/${hit.token}`;
    case 'workable':
      return `https://apply.workable.com/${hit.token}`;
  }
}

const PRIORITY: readonly DetectedAts[] = ['greenhouse', 'ashby', 'lever', 'workable'];

/**
 * Boards with open jobs win over empty ones (a dormant account on another ATS). Among the
 * boards left, the one whose name matches wins, then the one with the most jobs.
 * - confirmed: exactly one live board (or, with none live, exactly one board), and its name
 *   matches or the owner pasted its URL.
 * - review: a tie (several live boards, or several empty ones), or a board whose name can't be
 *   confirmed.
 */
export function classify(
  candidate: Candidate,
  hits: readonly BoardHit[],
  fromUrl: boolean,
): Detection {
  const sorted = [...hits].sort(
    (a, b) => b.jobs - a.jobs || PRIORITY.indexOf(a.type) - PRIORITY.indexOf(b.type),
  );
  const live = sorted.filter((h) => h.jobs > 0);
  const pool = live.length > 0 ? live : sorted;
  const [first] = pool;
  if (!first) return { candidate, status: 'not-found', others: [] };
  const named = pool.find(
    (h) => h.boardName !== undefined && namesMatch(h.boardName, candidate.name),
  );
  const best = named ?? first;
  const tie = pool.length > 1;
  // An empty board is never confirmed: it's usually a dormant account, not where they hire.
  const confirmed = !tie && best.jobs > 0 && (fromUrl || named !== undefined);
  return {
    candidate,
    status: confirmed ? 'confirmed' : 'review',
    hit: best,
    others: sorted.filter((h) => h !== best),
  };
}

// ---- CSV ----

/** RFC 4180-ish: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i);
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => r.some((cell) => cell.trim() !== ''));
  const keys = (header ?? []).map((key) => key.trim().toLowerCase());
  return body.map((cells) =>
    Object.fromEntries(keys.map((key, index) => [key, (cells[index] ?? '').trim()])),
  );
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(
  header: readonly string[],
  rows: readonly (readonly (string | number)[])[],
): string {
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}

export const REVIEW_HEADER = [
  'name',
  'domain',
  'hq',
  'status',
  'ats',
  'token',
  'host',
  'board_name',
  'jobs',
  'uk_jobs',
  'board_url',
  'also_found',
  'failed_probes',
  'decision',
] as const;

export function reviewRow(detection: Detection): string[] {
  const { candidate, hit } = detection;
  return [
    candidate.name,
    candidate.domain,
    candidate.hq,
    detection.status,
    hit?.type ?? 'none',
    hit?.token ?? '',
    hit?.host ?? '',
    hit?.boardName ?? '',
    String(hit?.jobs ?? ''),
    String(hit?.ukJobs ?? ''),
    hit ? boardPageUrl(hit) : '',
    detection.others.map((other) => `${other.type}:${other.token}`).join(' '),
    (detection.failed ?? []).join(' '),
    // Confirmed rows are kept unless the owner says otherwise; the rest need a decision.
    detection.status === 'confirmed' ? 'keep' : '',
  ];
}

/**
 * Merges re-detected rows into a review file (`--recheck`): each re-detected company's row gets
 * the new detection fields and a fresh decision; every other row, and any extra columns the
 * owner added (e.g. `decisionReason`), stay exactly as they were. Order is kept.
 */
export function mergeRechecked(
  rows: readonly Record<string, string>[],
  detections: readonly Detection[],
): { header: string[]; rows: Record<string, string>[] } {
  const fresh = new Map(
    detections.map((detection) => [
      detection.candidate.name,
      Object.fromEntries(
        REVIEW_HEADER.map((key, index) => [key, reviewRow(detection)[index] ?? '']),
      ),
    ]),
  );
  const header = [
    ...REVIEW_HEADER,
    ...Object.keys(rows[0] ?? {}).filter(
      (key) => !(REVIEW_HEADER as readonly string[]).includes(key),
    ),
  ];
  const merged = rows.map((row) => {
    const update = fresh.get(row.name ?? '');
    if (!update) return { ...row };
    const extra =
      'decisionreason' in row ? { decisionreason: `rechecked: ${update.status ?? ''}` } : {};
    return { ...row, ...update, ...extra };
  });
  return { header, rows: merged };
}

/**
 * Reviewed rows → seed entries. `keep` keeps the detected board; `keep-none` keeps the company
 * without one (aggregator matching only); `drop` removes it. A found board with no decision
 * is an error: every `review` row needs the owner's call.
 */
export function seedFromReview(rows: readonly Record<string, string>[]): {
  seed: CompanySeed[];
  undecided: string[];
} {
  const seed: CompanySeed[] = [];
  const undecided: string[] = [];
  for (const row of rows) {
    const name = row.name ?? '';
    const decision = (row.decision ?? '').toLowerCase();
    if (decision === 'drop') continue;
    const type = row.ats as AtsType | undefined;
    const hasBoard = type !== undefined && type !== 'none' && Boolean(row.token);
    const unchecked = row.status === 'unchecked';
    if ((hasBoard || unchecked) && decision !== 'keep' && decision !== 'keep-none') {
      undecided.push(name);
      continue;
    }
    if (!hasBoard && decision !== 'keep' && decision !== 'keep-none') continue;
    const useBoard = hasBoard && decision === 'keep';
    seed.push({
      id: slugify(name),
      name,
      domain: (row.domain ?? '').toLowerCase(),
      ats: useBoard
        ? { type, token: row.token ?? '', ...(row.host === 'eu' ? { host: 'eu' as const } : {}) }
        : { type: 'none' },
      hq: nonEmpty(row.hq) ?? 'London',
    });
  }
  return { seed: seed.sort((a, b) => a.id.localeCompare(b.id)), undecided };
}

export function seedModule(seed: readonly CompanySeed[]): string {
  return `import type { CompanySeed } from './jobs.js';

/**
 * Company watchlist seed (ADR-031): London/UK B2B SaaS companies and startups with their public
 * job-board tokens. Generated by \`node scripts/detect-ats.ts --write\` from the owner-reviewed
 * \`tmp/watchlist-review.csv\`; edit by re-running the script, not by hand. Public facts only
 * (name, domain, ATS type and board token), no personal data. \`scanNow\` creates any company
 * missing from Firestore and never overwrites one that exists.
 */
export const WATCHLIST_SEED: readonly CompanySeed[] = ${JSON.stringify(seed, null, 2)};
`;
}

// ---- Probing (official board APIs only) ----

const GreenhouseBoardSchema = z.object({ name: z.string() });
const WorkableAccountSchema = z.object({ name: z.string(), jobs: z.array(z.unknown()) });

function countUk(locations: readonly { locationText: string; remoteHint?: string }[]): number {
  return locations.filter((job) => {
    const location = parseLocation(job.locationText);
    return location.country === 'GB' || job.remoteHint === 'remote' || location.remote === 'remote';
  }).length;
}

const company = (token: string) => ({ id: token, name: token, ats: { type: 'none' as const } });

async function probe(
  http: HttpClient,
  type: DetectedAts,
  token: string,
  host?: 'eu',
): Promise<BoardHit | { failed: string } | null> {
  try {
    switch (type) {
      case 'greenhouse': {
        const base = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}`;
        const items = await http.getJson(`${base}/jobs`, keyedEnvelope('jobs'), {
          label: 'detect.greenhouse',
        });
        const board = await http.getJson(base, GreenhouseBoardSchema, {
          label: 'detect.greenhouse',
        });
        const jobs = items.flatMap((raw) => {
          const parsed = GreenhouseJobSchema.safeParse(raw);
          return parsed.success ? [greenhouseToRawJob(parsed.data, company(token))] : [];
        });
        return { type, token, boardName: board.name, jobs: items.length, ukJobs: countUk(jobs) };
      }
      case 'lever': {
        const items = await http.getJson(leverBoardUrl(token, host), arrayEnvelope, {
          label: 'detect.lever',
        });
        const jobs = items.flatMap((raw) => {
          const parsed = LeverPostingSchema.safeParse(raw);
          return parsed.success ? [leverToRawJob(parsed.data, company(token))] : [];
        });
        return {
          type,
          token,
          ...(host ? { host } : {}),
          jobs: items.length,
          ukJobs: countUk(jobs),
        };
      }
      case 'ashby': {
        const items = await http.getJson(ashbyBoardUrl(token), keyedEnvelope('jobs'), {
          label: 'detect.ashby',
        });
        const jobs = items.flatMap((raw) => {
          const parsed = AshbyJobSchema.safeParse(raw);
          const job = parsed.success ? ashbyToRawJob(parsed.data, company(token)) : null;
          return job ? [job] : [];
        });
        return { type, token, jobs: jobs.length, ukJobs: countUk(jobs) };
      }
      case 'workable': {
        const account = await http.getJson(
          `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(token)}`,
          WorkableAccountSchema,
          { label: 'detect.workable' },
        );
        const jobs = account.jobs.flatMap((raw) => {
          const parsed = WorkableJobSchema.safeParse(raw);
          return parsed.success ? [workableToRawJob(parsed.data, company(token))] : [];
        });
        return {
          type,
          token,
          boardName: account.name,
          jobs: account.jobs.length,
          ukJobs: countUk(jobs),
        };
      }
    }
  } catch (error) {
    // Only "no such board" means not found; anything else (rate limit, timeout) is a failed probe.
    if (error instanceof HttpError && error.code === 'not_found') return null;
    if (error instanceof HttpError && error.code !== 'deadline') {
      return { failed: `${type}${host ? '-eu' : ''}:${token}` };
    }
    throw error;
  }
}

/**
 * Detects one candidate. A pasted careers URL is checked first (one probe). Otherwise each
 * guessed token is tried on every ATS at once (different hosts), stopping at the first token
 * that finds anything.
 */
export async function detectCandidate(http: HttpClient, candidate: Candidate): Promise<Detection> {
  const failed: string[] = [];
  const keep = (result: BoardHit | { failed: string } | null): BoardHit | null => {
    if (result && 'failed' in result) {
      failed.push(result.failed);
      return null;
    }
    return result;
  };
  const withFailures = (detection: Detection): Detection => {
    if (failed.length === 0) return detection;
    // A failed probe might have been the real board, so nothing found can't be trusted.
    const status: ReviewStatus =
      detection.status === 'not-found'
        ? 'unchecked'
        : detection.status === 'confirmed'
          ? 'review'
          : detection.status;
    return { ...detection, status, failed: [...failed] };
  };
  const fromUrl = candidate.careersUrl ? atsFromUrl(candidate.careersUrl) : null;
  if (fromUrl) {
    const hit = keep(await probe(http, fromUrl.type, fromUrl.token, fromUrl.host));
    if (hit) return withFailures(classify(candidate, [hit], true));
  }
  for (const token of tokenCandidates(candidate.name, candidate.domain)) {
    const results = await Promise.all([
      probe(http, 'greenhouse', token),
      probe(http, 'ashby', token),
      probe(http, 'lever', token),
      probe(http, 'lever', token, 'eu'),
      probe(http, 'workable', token),
    ]);
    const hits = results.map(keep).filter((hit): hit is BoardHit => hit !== null);
    if (hits.length > 0) return withFailures(classify(candidate, hits, false));
  }
  return withFailures({ candidate, status: 'not-found', others: [] });
}
