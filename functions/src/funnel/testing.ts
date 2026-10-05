import {
  CRITERIA_SEED_V1,
  JobSchema,
  type CriteriaVersion,
  type FunnelFact,
  type Job,
  type Usage,
  type WorkRightsSetting,
} from '@hireframe/shared';

import { FAKE_CV_EXTRACTION } from '../fixtures/fake-cv-response.js';
import {
  applyReserveUpTo,
  applySettleLease,
  emptyUsage,
  type LeaseStore,
} from '../llm/usage-store.js';
import type { JobPatch } from './judgement.js';
import type { CompanyInfo, FunnelStore, StoredJob } from './run.js';

/** Test doubles for the funnel: an in-memory store and lease store with Firestore's semantics. */

export const TEST_NOW = new Date('2026-10-05T08:00:00Z');

export function daysAgo(days: number, now = TEST_NOW): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

export function testCriteria(patch: Partial<CriteriaVersion> = {}): CriteriaVersion {
  return {
    ...CRITERIA_SEED_V1,
    version: 3,
    createdAt: daysAgo(10),
    schemaVersion: 1,
    ...patch,
  };
}

/** The fake CV's facts (Alex Example), with stable IDs `fact-01`… */
export const TEST_FACTS: FunnelFact[] = FAKE_CV_EXTRACTION.facts.map((fact, index) => ({
  id: `fact-${String(index + 1).padStart(2, '0')}`,
  type: fact.type,
  text: fact.text,
  dates: fact.dates,
  lanes: fact.lanes,
}));

let counter = 0;

export function testJob(patch: Partial<Job> = {}): Job {
  counter += 1;
  return {
    dedupeKey: `d:${String(counter)}`,
    keys: [`d:${String(counter)}`],
    title: 'Product Analyst',
    company: 'Northwind Ledger',
    location: 'London',
    city: 'london',
    country: 'GB',
    remote: 'hybrid',
    url: `https://jobs.example.com/${String(counter)}`,
    sources: [
      {
        id: 'greenhouse',
        url: `https://jobs.example.com/${String(counter)}`,
        externalId: String(counter),
        seenAt: daysAgo(1),
      },
    ],
    postedAt: daysAgo(2),
    firstSeenAt: daysAgo(1),
    descriptionRef: `jobs/${String(counter)}/description/raw`,
    descriptionKind: 'full',
    stage: 's0',
    status: 'new',
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
    schemaVersion: 1,
    ...patch,
  };
}

function applyPatch(job: Job, patch: JobPatch): Job {
  const cleared = new Set<string>(patch.clear);
  const next: Record<string, unknown> = Object.fromEntries(
    Object.entries({ ...job, ...patch.set }).filter(([name]) => !cleared.has(name)),
  );
  if (patch.addCostPence) next.costPence = (job.costPence ?? 0) + patch.addCostPence;
  next.updatedAt = TEST_NOW;
  return JobSchema.parse(next);
}

export interface MemoryFunnelStore extends FunnelStore {
  jobs: Map<string, Job>;
  texts: Map<string, string>;
  companiesById: Map<string, CompanyInfo>;
  facts: FunnelFact[];
  workRights: WorkRightsSetting | null;
  add(id: string, job: Job, text?: string): void;
  get(id: string): Job;
  /** Every patch applied, in order. */
  patches: { jobId: string; patch: JobPatch }[];
}

export function memoryFunnelStore(
  options: { facts?: FunnelFact[]; workRights?: WorkRightsSetting | null } = {},
): MemoryFunnelStore {
  const jobs = new Map<string, Job>();
  const texts = new Map<string, string>();
  const companiesById = new Map<string, CompanyInfo>();
  const patches: { jobId: string; patch: JobPatch }[] = [];
  const list = (filter: (job: Job) => boolean): StoredJob[] =>
    [...jobs.entries()].filter(([, job]) => filter(job)).map(([id, job]) => ({ id, job }));
  const time = (date: Date | undefined) => date?.getTime() ?? 0;

  const store: MemoryFunnelStore = {
    jobs,
    texts,
    companiesById,
    facts: options.facts ?? TEST_FACTS,
    workRights:
      options.workRights === undefined ? { workRights: 'time_limited' } : options.workRights,
    patches,
    add(id, job, text = 'Help the product team understand how customers use the app.') {
      jobs.set(id, JobSchema.parse(job));
      texts.set(id, text);
    },
    get(id) {
      const job = jobs.get(id);
      if (!job) throw new Error(`no job ${id}`);
      return job;
    },
    loadProfile: () => Promise.resolve({ facts: store.facts, workRights: store.workRights }),
    s0Jobs: (limit) =>
      Promise.resolve(
        list((job) => job.stage === 's0')
          .sort((a, b) => time(b.job.firstSeenAt) - time(a.job.firstSeenAt))
          .slice(0, limit),
      ),
    queued: (stage, limit) => {
      const waiting = list((job) => job.next === stage && job.sortAt !== undefined);
      waiting.sort((a, b) =>
        stage === 's3'
          ? (b.job.triage?.triageScore ?? 0) - (a.job.triage?.triageScore ?? 0) ||
            time(b.job.sortAt) - time(a.job.sortAt)
          : time(b.job.sortAt) - time(a.job.sortAt),
      );
      return Promise.resolve(waiting.slice(0, limit));
    },
    staleQueued: (stage, before, limit) =>
      Promise.resolve(
        list(
          (job) =>
            job.next === stage &&
            job.sortAt !== undefined &&
            job.sortAt.getTime() < before.getTime(),
        )
          .sort((a, b) => time(b.job.sortAt) - time(a.job.sortAt))
          .slice(0, limit),
      ),
    recentJobs: (since, limit) =>
      Promise.resolve(
        list((job) => job.firstSeenAt.getTime() >= since.getTime())
          .sort((a, b) => time(b.job.firstSeenAt) - time(a.job.firstSeenAt))
          .slice(0, limit),
      ),
    descriptions: (ids) =>
      Promise.resolve(
        new Map(ids.flatMap((id) => (texts.has(id) ? [[id, texts.get(id) ?? '']] : []))),
      ),
    companies: (ids) =>
      Promise.resolve(
        new Map(
          ids.flatMap((id) => (companiesById.has(id) ? [[id, companiesById.get(id) ?? {}]] : [])),
        ),
      ),
    apply: (updates) => {
      for (const update of updates) {
        patches.push(update);
        jobs.set(update.jobId, applyPatch(store.get(update.jobId), update.patch));
      }
      return Promise.resolve(0);
    },
    queueCounts: () =>
      Promise.resolve({
        s2: list((job) => job.next === 's2').length,
        s3: list((job) => job.next === 's3').length,
      }),
  };
  return store;
}

export interface MemoryLeaseStore extends LeaseStore {
  usage: () => Usage;
  set: (usage: Usage) => void;
}

export function memoryLeaseStore(initial?: Usage): MemoryLeaseStore {
  let usage = initial ?? emptyUsage(1_500, TEST_NOW);
  return {
    usage: () => usage,
    set: (next) => {
      usage = next;
    },
    reserveUpTo(input) {
      const result = applyReserveUpTo(usage, input);
      usage = result.usage;
      return Promise.resolve(result.grant);
    },
    settleLease(input) {
      usage = applySettleLease(usage, input);
      return Promise.resolve();
    },
  };
}
