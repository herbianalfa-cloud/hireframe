import {
  normaliseCompany,
  normaliseRawJob,
  normaliseTitle,
  type AtsPosting,
  type NormalisedJob,
  type RawJob,
} from '@hireframe/shared';

import { HttpError, type HttpClient } from '../http/client.js';
import { log } from '../log.js';
import { ashbyBoard } from '../sources/ashby.js';
import type { AtsBoardReader } from '../sources/ats.js';
import {
  GreenhouseJobSchema,
  greenhouseBoard,
  greenhouseJobUrl,
  greenhouseToRawJob,
} from '../sources/greenhouse.js';
import {
  LeverPostingSchema,
  leverBoard,
  leverPostingUrl,
  leverToRawJob,
} from '../sources/lever.js';
import type { WatchedCompany } from '../sources/types.js';
import { workableBoard } from '../sources/workable.js';

/**
 * The ATS board search (ADR-049): given a job's title, company and city, find its full posting on
 * the board of a watched company, through the same official board APIs, schemas and HTTP client
 * (robots, User-Agent, per-host spacing) a scan uses. One request per board, cached for the life
 * of the search. A match must be unique: zero or several postings that fit is no match, never a
 * guess. LinkedIn is never requested; the client refuses that host before any fetch.
 */

const READERS: Readonly<Record<WatchedCompany['ats']['type'], AtsBoardReader | null>> = {
  greenhouse: greenhouseBoard,
  lever: leverBoard,
  ashby: ashbyBoard,
  workable: workableBoard,
  none: null,
};

export interface SearchedJob {
  title: string;
  company: string;
  companyId?: string;
  /** Comparison form of the city (`Job.city`); '' when unknown. */
  city: string;
}

export interface AtsMatch {
  /** The watched company the board belongs to, when it is one. */
  companyId?: string;
  /** The posting, normalised: its source key and keys, full text and posting date. */
  posting: NormalisedJob;
}

export interface AtsFindResult {
  match: AtsMatch | null;
  /** A watched company's board was looked up (or tried): the job had somewhere to be found. */
  searched: boolean;
  /** The board could not be read. */
  failed: boolean;
}

export interface AtsSearch {
  /** The one posting on a watched company's board that fits the job. Never throws on HTTP errors. */
  find(job: SearchedJob): Promise<AtsFindResult>;
  /** A posting from a job-board URL (single-posting endpoint where one exists), or null. */
  fetchPosting(posting: AtsPosting): Promise<AtsMatch | null>;
  /** Board and posting requests made so far. */
  requests(): number;
}

export interface AtsSearchDeps {
  http: HttpClient;
  /** Watched companies; read lazily, once. */
  watched: () => Promise<readonly WatchedCompany[]>;
  /** Boards this search may fetch; `find` returns null once it is spent. */
  maxBoards: number;
}

function withAts(company: WatchedCompany): company is WatchedCompany & { ats: { token: string } } {
  return company.ats.type !== 'none' && Boolean(company.ats.token);
}

export function createAtsSearch(deps: AtsSearchDeps): AtsSearch {
  let watched: Promise<readonly WatchedCompany[]> | undefined;
  const boards = new Map<string, Promise<NormalisedJob[] | null>>();
  let boardFetches = 0;

  const watchedList = () => (watched ??= deps.watched());

  async function loadBoard(company: WatchedCompany): Promise<NormalisedJob[] | null> {
    const reader = READERS[company.ats.type];
    if (!reader) return null;
    try {
      const items = await deps.http.getJson(reader.boardUrl(company), reader.envelope, {
        label: `${company.ats.type}.board`,
      });
      const { jobs } = reader.read(items, company);
      return jobs.flatMap((raw) => normaliseRawJob(raw) ?? []);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      log.warn('lookup.ats_failed', { ats: company.ats.type, code: error.code });
      return null;
    }
  }

  function board(company: WatchedCompany): Promise<NormalisedJob[] | null> {
    const cached = boards.get(company.id);
    if (cached) return cached;
    boardFetches += 1;
    const loading = loadBoard(company);
    boards.set(company.id, loading);
    return loading;
  }

  return {
    async find(job) {
      const none: AtsFindResult = { match: null, searched: false, failed: false };
      const list = await watchedList();
      const company = job.companyId
        ? list.find((candidate) => candidate.id === job.companyId)
        : list.find(
            (candidate) =>
              normaliseCompany(candidate.name) !== '' &&
              normaliseCompany(candidate.name) === normaliseCompany(job.company),
          );
      if (!company || !withAts(company)) return none;
      if (!boards.has(company.id) && boardFetches >= deps.maxBoards) return none;
      const postings = await board(company);
      if (!postings) return { match: null, searched: true, failed: true };

      const wanted = normaliseTitle(job.title);
      let fits = wanted === '' ? [] : postings.filter((p) => normaliseTitle(p.title) === wanted);
      // Several fit: the job's city decides, and only if it leaves exactly one.
      if (fits.length > 1 && job.city !== '') {
        fits = fits.filter((posting) => posting.city === job.city);
      }
      const [only] = fits;
      if (fits.length !== 1 || !only) return { match: null, searched: true, failed: false };
      return {
        match: { companyId: company.id, posting: { ...only, companyId: company.id } },
        searched: true,
        failed: false,
      };
    },

    async fetchPosting(target) {
      try {
        const raw = await fetchOne(deps.http, target);
        const posting = raw ? normaliseRawJob(raw) : null;
        if (!posting) return null;
        const list = await watchedList();
        const known = list.find(
          (candidate) =>
            candidate.ats.type === target.type &&
            candidate.ats.token?.toLowerCase() === target.token.toLowerCase(),
        );
        return {
          ...(known ? { companyId: known.id } : {}),
          posting: known ? { ...posting, companyId: known.id } : posting,
        };
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        log.warn('lookup.ats_failed', { ats: target.type, code: error.code });
        return null;
      }
    },

    requests: () => deps.http.requests(),
  };
}

/**
 * The posting a job-board URL names. Greenhouse and Lever have a single-posting endpoint; Ashby and
 * Workable only list a board, so their board is read and filtered by ID. The company name falls
 * back to the board token when the board doesn't carry one (watched companies are renamed on match).
 */
async function fetchOne(http: HttpClient, target: AtsPosting): Promise<RawJob | null> {
  const company: WatchedCompany = {
    id: '',
    name: target.token,
    ats: { type: target.type, token: target.token, ...(target.host ? { host: target.host } : {}) },
  };
  if (target.type === 'greenhouse') {
    const job = await http.getJson(greenhouseJobUrl(target.token, target.id), GreenhouseJobSchema, {
      label: 'greenhouse.posting',
    });
    return greenhouseToRawJob(job, { ...company, name: job.company_name ?? target.token });
  }
  if (target.type === 'lever') {
    const posting = await http.getJson(
      leverPostingUrl(target.token, target.id, target.host),
      LeverPostingSchema,
      { label: 'lever.posting' },
    );
    return leverToRawJob(posting, company);
  }
  const reader = target.type === 'ashby' ? ashbyBoard : workableBoard;
  const items = await http.getJson(reader.boardUrl(company), reader.envelope, {
    label: `${target.type}.board`,
  });
  const { jobs } = reader.read(items, company);
  return jobs.find((job) => job.externalId.toLowerCase() === target.id.toLowerCase()) ?? null;
}
