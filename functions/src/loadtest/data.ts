import type { CompanySeed, RawJob } from '@hireframe/shared';

/**
 * The load test's fake data (pure, seeded; docs/plans/m8b-plan.md B4). Fake companies and
 * postings only. Never imported by `index.ts`, so none of it is in the deploy bundle.
 */
export interface LoadOptions {
  jobs: number;
  /** Postings that pass S1 (the approved peak is 105: ADR-032 amendment, f·P). */
  s1Passes: number;
  /** Share of S1 passes that pass S2 (q = 0.30 at the approved peak). */
  s2PassRate: number;
  seed: number;
  now: Date;
  boards: number;
  alerts: number;
  staleQueued: number;
}

export const LOAD_DEFAULTS: Omit<LoadOptions, 'now'> = {
  jobs: 1_000,
  s1Passes: 105,
  s2PassRate: 0.3,
  seed: 8_002,
  boards: 20,
  alerts: 12,
  staleQueued: 300,
};

/** A Greenhouse board posting, as the board API returns it. */
export interface BoardPosting {
  id: number;
  title: string;
  absolute_url: string;
  location: { name: string };
  company_name: string;
  first_published: string;
  updated_at: string;
  /** Entity-escaped HTML, as Greenhouse sends it. */
  content: string;
}

export type WaitingState = 's2' | 's3' | 'description';

export interface LoadData {
  companies: CompanySeed[];
  /** Board token → the board API's response body. */
  boards: Map<string, { jobs: BoardPosting[] }>;
  /** Alert jobs: no description, to be judged by S3 after a board read. */
  alerts: RawJob[];
  /** Jobs seeded straight into a queue, past `freshness_days` (the expiry sweep frees them). */
  stale: { raw: RawJob; state: WaitingState }[];
  expected: { s1Passes: number; s2Passes: number; boardJobs: number };
}

/** A small seeded PRNG (mulberry32): the same seed always gives the same data. */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Titles S1 passes and the fake S2 passes (funnel/fake-answers.ts). */
const S2_PASS_TITLES = [
  'Product Analyst',
  'Customer Onboarding Analyst',
  'Onboarding Specialist',
  'Solutions Consultant',
  'Implementation Analyst',
  'Product Operations Analyst',
] as const;
/** Titles S1 passes and the fake S2 skips. */
const S2_SKIP_TITLES = [
  'Operations Coordinator',
  'Office Coordinator',
  'Events Coordinator',
  'Content Coordinator',
] as const;
const UK_CITIES = ['London', 'Manchester', 'Bristol', 'Leeds', 'Edinburgh'] as const;

const SENTENCES = [
  'You will work with a small cross-functional team to turn customer questions into clear answers.',
  'Day to day you will build reports, review weekly metrics and explain what the numbers say.',
  'We are a B2B software company with customers across the UK and Europe.',
  'You will join an onboarding rota and help new customers reach their first useful result.',
  'We use SQL, spreadsheets and a modern dashboard tool; training is provided for the rest.',
  'The role suits someone early in their career who likes working with people and data.',
  'You will document what you learn so the next person starts further ahead.',
  'We review work together, share feedback openly and keep meetings short.',
];

function description(random: () => number, title: string, company: string): string {
  const picked = [...SENTENCES].sort(() => random() - 0.5).slice(0, 6);
  return `<p>${company} is hiring a ${title}.</p><ul>${picked
    .slice(0, 3)
    .map((s) => `<li>${s}</li>`)
    .join('')}</ul><p>${picked.slice(3).join(' ')}</p>`;
}

/** Greenhouse entity-escapes its HTML once. */
function escapeOnce(html: string): string {
  return html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function companyId(index: number): string {
  return `load-co-${String(index + 1).padStart(2, '0')}`;
}
export function boardToken(index: number): string {
  return `loadboard${String(index + 1).padStart(2, '0')}`;
}
function companyName(index: number): string {
  return `Loadtest Company ${String(index + 1).padStart(2, '0')}`;
}

export function buildLoadData(options: LoadOptions): LoadData {
  const random = prng(options.seed);
  const day = 86_400_000;
  const recent = () => new Date(options.now.getTime() - Math.floor(random() * 3 * day));
  const stalePosted = () =>
    new Date(options.now.getTime() - (30 + Math.floor(random() * 30)) * day);

  const companies: CompanySeed[] = Array.from({ length: options.boards }, (_, index) => ({
    id: companyId(index),
    name: companyName(index),
    domain: `load-${String(index + 1)}.example.com`,
    ats: { type: 'greenhouse' as const, token: boardToken(index) },
    hq: 'London',
  }));
  const boards = new Map<string, { jobs: BoardPosting[] }>(
    companies.map((company) => [company.ats.token ?? '', { jobs: [] }]),
  );

  // Which postings pass S1, and which of those pass S2: a seeded shuffle, so they spread over boards.
  const order = Array.from({ length: options.jobs }, (_, index) => index).sort(
    () => random() - 0.5,
  );
  const s1Passes = Math.min(options.s1Passes, options.jobs);
  const s2Passes = Math.round(s1Passes * options.s2PassRate);
  const rank = new Map(order.map((jobIndex, position) => [jobIndex, position]));

  let nextId = 7_000_000;
  const perBoard = new Map<number, number>();
  for (let jobIndex = 0; jobIndex < options.jobs; jobIndex += 1) {
    const board = jobIndex % options.boards;
    const squad = (perBoard.get(board) ?? 0) + 1;
    perBoard.set(board, squad);
    const position = rank.get(jobIndex) ?? 0;
    const passesS1 = position < s1Passes;
    const passesS2 = position < s2Passes;
    const base = passesS2
      ? S2_PASS_TITLES[position % S2_PASS_TITLES.length]
      : passesS1
        ? S2_SKIP_TITLES[position % S2_SKIP_TITLES.length]
        : S2_PASS_TITLES[position % S2_PASS_TITLES.length];
    const title = `${base ?? 'Analyst'}, Squad ${String(squad)}`;
    const city = passesS1 ? (UK_CITIES[position % UK_CITIES.length] ?? 'London') : 'Berlin';
    const company = companyName(board);
    const posted = recent();
    nextId += 1;
    boards.get(boardToken(board))?.jobs.push({
      id: nextId,
      title,
      absolute_url: `https://job-boards.greenhouse.io/${boardToken(board)}/jobs/${String(nextId)}`,
      location: { name: passesS1 ? `${city}, UK` : 'Berlin, Germany' },
      company_name: company,
      first_published: posted.toISOString(),
      updated_at: posted.toISOString(),
      content: escapeOnce(description(random, title, company)),
    });
  }

  // Alert jobs at distinct watched companies; half have a posting with the same title on their
  // board, in another city so ingest does not merge the two.
  const alerts: RawJob[] = [];
  for (let index = 0; index < options.alerts; index += 1) {
    const board = index % options.boards;
    const title = `Customer Success Analyst, Alert ${String(index + 1)}`;
    const company = companyName(board);
    if (index % 2 === 0) {
      nextId += 1;
      const posted = recent();
      boards.get(boardToken(board))?.jobs.push({
        id: nextId,
        title,
        absolute_url: `https://job-boards.greenhouse.io/${boardToken(board)}/jobs/${String(nextId)}`,
        location: { name: 'Bristol, UK' },
        company_name: company,
        first_published: posted.toISOString(),
        updated_at: posted.toISOString(),
        content: escapeOnce(description(random, title, company)),
      });
    }
    alerts.push({
      sourceId: 'linkedin-alert',
      externalId: `load-alert-${String(index + 1)}`,
      url: `https://www.linkedin.com/jobs/view/${String(9_000_000 + index)}`,
      title,
      company,
      companyId: companyId(board),
      locationText: 'London, UK',
      description: { kind: 'none', format: 'text', body: '' },
      postedAt: recent(),
    });
  }

  // Stale queued jobs: past freshness_days, spread over the three wait states.
  const states: WaitingState[] = ['s2', 's3', 'description'];
  const stale = Array.from({ length: options.staleQueued }, (_, index) => {
    const board = index % options.boards;
    const title = `Product Analyst, Stale ${String(index + 1)}`;
    const company = companyName(board);
    const raw: RawJob = {
      sourceId: 'greenhouse',
      externalId: `load-stale-${String(index + 1)}`,
      url: `https://job-boards.greenhouse.io/${boardToken(board)}/jobs/${String(8_000_000 + index)}`,
      title,
      company,
      companyId: companyId(board),
      locationText: 'London, UK',
      description: {
        kind: 'full',
        format: 'html',
        body: description(random, title, company),
      },
      postedAt: stalePosted(),
    };
    return { raw, state: states[index % states.length] ?? 's2' };
  });

  return {
    companies,
    boards,
    alerts,
    stale,
    expected: {
      s1Passes,
      s2Passes,
      boardJobs: options.jobs,
    },
  };
}
