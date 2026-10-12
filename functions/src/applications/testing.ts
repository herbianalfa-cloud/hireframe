import {
  ApplicationSchema,
  CvDocSchema,
  EventSchema,
  type Application,
  type AppEvent,
  type CvDoc,
  type CvHeader,
  type ExistingFact,
  type FactDraft,
  type JobRequirement,
  type Verdict,
} from '@hireframe/shared';

import type { NewFact } from '../profile/store.js';
import type { ApplicationStore, Change, CommitResult, JobForCv } from './store.js';
import type { JobForApplication } from './transitions.js';

/** Test support: an in-memory `ApplicationStore` with the production store's rules. */
export interface MemoryApplicationStore extends ApplicationStore {
  applications: Map<string, Application>;
  jobs: Map<string, JobForApplication>;
  /** `exists: false` is a missing or invalid header; `value` overrides `TEST_HEADER`. */
  header: { exists: boolean; value?: CvHeader };
  /** What `getJobForCv` returns; a job in `jobs` with no entry here has no deep read. */
  jobTexts: Map<string, JobForCv>;
  /** `cvs/{cvId}` documents written beside a ready move. */
  cvDocs: Map<string, CvDoc>;
  events: AppEvent[];
  /** Facts written by answers: the draft, its ID and the job it answered for. */
  facts: { id: string; draft: FactDraft; jobId: string }[];
  deletedCvDocs: string[];
  /** Runs before a commit reads the document, to simulate another call landing in between. */
  beforeCommit?: (change: Change, call: number) => void;
  commits: number;
}

export function memoryApplicationStore(): MemoryApplicationStore {
  let factCounter = 0;
  const store: MemoryApplicationStore = {
    applications: new Map(),
    jobs: new Map(),
    header: { exists: true },
    jobTexts: new Map(),
    cvDocs: new Map(),
    events: [],
    facts: [],
    deletedCvDocs: [],
    commits: 0,

    getApplication: (jobId) => Promise.resolve(store.applications.get(jobId) ?? null),
    getJob: (jobId) => Promise.resolve(store.jobs.get(jobId) ?? null),
    hasCvHeader: () => Promise.resolve(store.header.exists),
    getCvHeader: () =>
      Promise.resolve(store.header.exists ? (store.header.value ?? TEST_HEADER) : null),
    // Like the query: at most `readLimit` documents are read (in no order), then the oldest
    // `limit` of those are taken.
    listGenerating: (limit, readLimit) =>
      Promise.resolve(
        [...store.applications.values()]
          .filter((application) => application.stage === 'generating')
          .slice(0, Math.max(0, readLimit))
          .sort((a, b) => a.stageAt.getTime() - b.stageAt.getTime())
          .slice(0, limit),
      ),
    getJobForCv: (jobId) => Promise.resolve(store.jobTexts.get(jobId) ?? null),

    commit(change): Promise<CommitResult> {
      store.commits += 1;
      store.beforeCommit?.(change, store.commits);
      const current = store.applications.get(change.jobId) ?? null;
      const here = current ? { stage: current.stage, attempt: current.attempt } : null;
      const { expect } = change;
      if (here?.stage !== expect?.stage || here?.attempt !== expect?.attempt) {
        return Promise.resolve({ ok: false, reason: 'lost' });
      }
      const drafts: readonly NewFact[] = change.facts ?? [];
      const ids = drafts.map(() => `fact-${String((factCounter += 1))}`);
      const next = change.build(current, ids);
      if (!next) return Promise.resolve({ ok: false, reason: 'lost' });
      const valid = ApplicationSchema.parse(next);
      drafts.forEach((fact, index) => {
        store.facts.push({
          id: ids[index] ?? '',
          draft: fact.draft,
          jobId: change.jobId,
        });
      });
      if (change.cvDoc) {
        store.cvDocs.set(change.cvDoc.cvId, CvDocSchema.parse(change.cvDoc.doc));
      }
      store.applications.set(change.jobId, valid);
      const from = current?.stage ?? null;
      if (from !== valid.stage) {
        store.events.push(
          EventSchema.parse({
            type: 'application_stage',
            jobId: change.jobId,
            from,
            to: valid.stage,
            at: change.now,
            schemaVersion: 1,
          }),
        );
      }
      return Promise.resolve({ ok: true, application: valid, factIds: ids });
    },

    deleteCvDocs(cvIds) {
      store.deletedCvDocs.push(...cvIds);
      return Promise.resolve();
    },
  };
  return store;
}

export const TEST_JOB_ID = 'job-1';

/** The fake candidate's header: example addresses only. */
export const TEST_HEADER: CvHeader = {
  name: 'Alex Example',
  email: 'alex@example.com',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  schemaVersion: 1,
};

export function requirementOf(
  text: string,
  overrides: Partial<JobRequirement> = {},
): JobRequirement {
  return {
    text,
    level: 'must',
    type: 'skill',
    match: 'missing',
    gap: 'tool',
    factIds: [],
    ...overrides,
  };
}

/** A judged job with a deep read; `requirements` decide the questions. */
export function testJob(
  requirements: JobRequirement[],
  overrides: Partial<JobForApplication> & { verdict?: Verdict } = {},
): JobForApplication {
  return {
    title: 'Data Analyst',
    company: 'Northwind Analytics',
    verdict: 'apply',
    deep: { requirements },
    ...overrides,
  };
}

export const existingFact = (
  id: string,
  text: string,
  status: ExistingFact['status'] = 'active',
): ExistingFact => ({
  id,
  status,
  source: 'manual',
  content: { type: 'achievement', text, evidence: text, dates: {}, tags: [], lanes: [] },
});
