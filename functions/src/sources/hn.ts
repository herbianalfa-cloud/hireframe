import {
  decodeEntities,
  foldText,
  htmlToText,
  parseLocation,
  UK_CITIES,
  type RawJob,
} from '@hireframe/shared';
import { z } from 'zod';

import { SOURCE_QUERIES } from '../config.js';
import { HttpError } from '../http/client.js';
import {
  emptyReport,
  parseDate,
  type Source,
  type SourceContext,
  type SourceReport,
} from './types.js';

/**
 * Hacker News "Who is hiring?" via the HN Algolia API (public): the latest thread by
 * `whoishiring`, then its comment tree in one request. Each top-level comment is one posting;
 * its first paragraph is usually `Company | Role | Location | …` in any order. Only postings
 * that mention the UK, a UK city, or remote work open to the UK/Europe/anywhere are kept
 * (ARCHITECTURE "Sources").
 */

const SearchSchema = z.object({
  hits: z.array(z.object({ objectID: z.string().regex(/^\d+$/), title: z.string().nullish() })),
});

const CommentSchema = z.object({
  id: z.number().int().positive(),
  text: z.string().nullish(),
  author: z.string().nullish(),
  created_at: z.string().nullish(),
});
type HnComment = z.infer<typeof CommentSchema>;

const ItemSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().nullish(),
  children: z.array(z.unknown()),
});

export const HN_SEARCH_URL =
  'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10';

export function hnItemUrl(id: string): string {
  return `https://hn.algolia.com/api/v1/items/${id}`;
}

/** The newest "Ask HN: Who is hiring?" story (not "Who wants to be hired?"). */
export function latestHiringThread(hits: z.infer<typeof SearchSchema>['hits']): string | null {
  return hits.find((hit) => /who is hiring\?/i.test(hit.title ?? ''))?.objectID ?? null;
}

const EMPLOYMENT =
  /^(full[ -]?time|part[ -]?time|contract(or)?|intern(ship)?|permanent|ft|pt|freelance)\b/i;
const MONEY = /[$£€]|\b\d+\s?k\b|\bsalary\b|\bequity\b/i;
const VISA = /\bvisa\b|\bsponsor/i;
const WORK_MODE = /\b(remote|onsite|on-site|hybrid|in[- ]person|office)\b/i;
const URLISH = /^(https?:\/\/|www\.)\S+$|^\S+\.(com|io|ai|co|org|net|dev|app)(\/\S*)?$/i;

const UK_WORDS = ['uk', 'united kingdom', 'england', 'scotland', 'wales', 'britain', 'gmt', 'bst'];
const REMOTE_OPEN = ['worldwide', 'anywhere', 'global', 'europe', 'eu', 'emea', 'cet'];

function isLocationSegment(segment: string): boolean {
  const location = parseLocation(segment);
  return (
    WORK_MODE.test(segment) ||
    location.country !== 'unknown' ||
    UK_CITIES.some((city) => foldText(segment).split(' ').includes(city))
  );
}

/** True when a posting is open to someone in the UK. */
export function isUkRelevant(firstParagraph: string): boolean {
  const folded = ` ${foldText(firstParagraph)} `;
  const has = (word: string) => folded.includes(` ${word} `);
  if (UK_WORDS.some(has) || UK_CITIES.some(has)) return true;
  return has('remote') && REMOTE_OPEN.some(has);
}

export interface ParsedHnPosting {
  company: string;
  title: string;
  locationText: string;
}

/** Splits the `Company | Role | Location | …` header. Null when there's no company. */
export function parseHnHeader(header: string): ParsedHnPosting | null {
  const segments = header
    .split('|')
    .map((segment) => segment.replace(/\(\s*https?:\/\/[^)]*\)/g, '').trim())
    .filter(Boolean);
  const [first, ...rest] = segments;
  const company =
    first
      ?.replace(/https?:\/\/\S+/g, '')
      .replace(/[*()]/g, '')
      .trim() ?? '';
  if (!company || company.length > 100) return null;
  const locations = rest.filter(isLocationSegment);
  const title = rest.find(
    (segment) =>
      !locations.includes(segment) &&
      !EMPLOYMENT.test(segment) &&
      !MONEY.test(segment) &&
      !VISA.test(segment) &&
      !URLISH.test(segment) &&
      segment.length <= 120,
  );
  const cleanTitle = title?.replace(/[*]/g, '').trim() ?? '';
  return {
    company,
    title: cleanTitle === '' ? 'Multiple roles' : cleanTitle,
    locationText: locations.join(' | ').slice(0, 300),
  };
}

/** Job links in the comment (`href`s, entity-decoded), for matching ATS postings. */
export function linksIn(html: string): string[] {
  const links = [...html.matchAll(/href="([^"]+)"/g)]
    .map((match) => decodeEntities(match[1] ?? ''))
    .filter((url) => /^https?:\/\//.test(url));
  return [...new Set(links)].slice(0, 20);
}

export function hnToRawJob(comment: HnComment): RawJob | null {
  if (!comment.text || !comment.author) return null;
  const firstParagraph = htmlToText(comment.text.split(/<p>/i)[0] ?? '');
  if (!isUkRelevant(firstParagraph)) return null;
  const parsed = parseHnHeader(firstParagraph);
  if (!parsed) return null;
  const postedAt = parseDate(comment.created_at);
  const extraUrls = linksIn(comment.text);
  return {
    sourceId: 'hn',
    externalId: String(comment.id),
    url: `https://news.ycombinator.com/item?id=${String(comment.id)}`,
    title: parsed.title,
    company: parsed.company,
    locationText: parsed.locationText,
    description: { kind: 'full', format: 'html', body: comment.text },
    ...(postedAt ? { postedAt } : {}),
    ...(extraUrls.length ? { extraUrls } : {}),
  };
}

export function createHnSource(): Source {
  let report: SourceReport = emptyReport();
  return {
    id: 'hn',
    health: () => report,
    async fetch(ctx: SourceContext) {
      report = emptyReport();
      try {
        const search = await ctx.http.getJson(HN_SEARCH_URL, SearchSchema, { label: 'hn.search' });
        const threadId = latestHiringThread(search.hits);
        if (!threadId) {
          report = { ...emptyReport('failing'), errors: 1, errorCode: 'no_thread' };
          return [];
        }
        const thread = await ctx.http.getJson(hnItemUrl(threadId), ItemSchema, {
          label: 'hn.thread',
        });
        const jobs: RawJob[] = [];
        for (const child of thread.children.slice(0, SOURCE_QUERIES.hn.maxComments)) {
          const parsed = CommentSchema.safeParse(child);
          if (!parsed.success) {
            report.invalid += 1;
            continue;
          }
          if (!parsed.data.text) continue; // deleted or flagged
          report.fetched += 1;
          const job = hnToRawJob(parsed.data);
          if (job) jobs.push(job);
        }
        return jobs;
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        report = { ...report, status: 'failing', errors: report.errors + 1, errorCode: error.code };
        return [];
      }
    },
  };
}
