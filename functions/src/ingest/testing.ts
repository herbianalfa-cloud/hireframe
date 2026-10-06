import {
  buildNewJob,
  JobDescriptionSchema,
  PATHS,
  type ExistingJobKeys,
  type IngestPlan,
  type Job,
  type JobDescription,
  type LockHolder,
  type SourceHealth,
} from '@hireframe/shared';

import type { LockResult } from '../scan/run.js';
import type { AlertMessageRecord, IngestStore } from './run.js';

/** An in-memory `IngestStore` with the real store's lock and write semantics, for unit tests. */
export interface MemoryIngestStore extends IngestStore {
  jobs: Map<string, Job>;
  descriptions: Map<string, JobDescription>;
  messages: Map<string, AlertMessageRecord>;
  companies: { id: string; name: string }[];
  health: () => SourceHealth | undefined;
  lock: { holder: LockHolder | null; startedAt?: Date };
  /** How many `writePlan` calls to fail (each counts one failed write). */
  failWrites: number;
  holdLock(holder: LockHolder): void;
}

export function memoryIngestStore(): MemoryIngestStore {
  let counter = 0;
  let health: SourceHealth | undefined;
  const store: MemoryIngestStore = {
    jobs: new Map(),
    descriptions: new Map(),
    messages: new Map(),
    companies: [],
    health: () => health,
    lock: { holder: null },
    failWrites: 0,
    holdLock(holder) {
      store.lock = { holder, startedAt: new Date() };
    },
    newRunId: () => `run-${String((counter += 1))}`,
    acquireLock(_runId, now, _cooldown, holder = 'scan'): Promise<LockResult> {
      if (store.lock.holder !== null) {
        return Promise.resolve({ ok: false, reason: 'running', holder: store.lock.holder });
      }
      store.lock = { holder, startedAt: now };
      return Promise.resolve({ ok: true });
    },
    releaseLock: () => {
      store.lock = { holder: null };
      return Promise.resolve();
    },
    watchedCompanies: () =>
      Promise.resolve(
        store.companies.map((company) => ({
          company: { id: company.id, name: company.name, ats: { type: 'none' as const } },
        })),
      ),
    findJobsByKeys(keys) {
      const wanted = new Set(keys);
      const found: ExistingJobKeys[] = [];
      for (const [id, job] of store.jobs) {
        if (!job.keys.some((key) => wanted.has(key))) continue;
        found.push({
          id,
          keys: job.keys,
          firstSeenAt: job.firstSeenAt,
          sourceCount: job.sources.length,
          descriptionKind: job.descriptionKind,
          ...(job.next === undefined ? {} : { next: job.next }),
          ...(job.postedAt ? { postedAt: job.postedAt } : {}),
        });
      }
      return Promise.resolve(found);
    },
    writePlan(plan: IngestPlan, now) {
      if (store.failWrites > 0) {
        store.failWrites -= 1;
        return Promise.resolve({ failedWrites: 1 });
      }
      for (const group of plan.creates) {
        const id = `job-${String((counter += 1))}`;
        const { job, description } = buildNewJob(group, PATHS.jobDescription(id), now);
        store.jobs.set(id, job);
        store.descriptions.set(id, JobDescriptionSchema.parse(description));
      }
      for (const update of plan.updates) {
        const job = store.jobs.get(update.jobId);
        if (!job) continue;
        const next: Job = {
          ...job,
          sources: [
            ...job.sources,
            ...update.addSources.map((added) => ({
              id: added.sourceId,
              url: added.unverifiedUrl ?? added.url,
              externalId: added.externalId,
              seenAt: now,
              ...(added.easyApply ? { easyApply: true as const } : {}),
              ...(added.unverifiedUrl ? { unverified: true as const } : {}),
              ...(added.searchLink ? { searchLink: true as const } : {}),
            })),
          ],
          keys: [...job.keys, ...update.addKeys],
          updatedAt: now,
        };
        if (update.upgrade) {
          next.descriptionKind = 'full';
          if (update.upgrade.postedAt) next.postedAt = update.upgrade.postedAt;
          if (update.upgrade.release) {
            next.next = 's3';
            next.flags = (job.flags ?? []).filter((flag) => flag !== 'needs_description');
          }
          store.descriptions.set(update.jobId, {
            text: update.upgrade.text,
            kind: 'full',
            sourceId: update.upgrade.sourceId,
            fetchedAt: now,
            schemaVersion: 1,
          });
        }
        store.jobs.set(update.jobId, next);
      }
      return Promise.resolve({ failedWrites: 0 });
    },
    seenMessages: (hashes) =>
      Promise.resolve(new Set(hashes.filter((hash) => store.messages.has(hash)))),
    recordMessage(hash, record) {
      store.messages.set(hash, record);
      return Promise.resolve();
    },
    readEmailHealth: () => Promise.resolve(health),
    writeEmailHealth(next) {
      health = next;
      return Promise.resolve();
    },
  };
  return store;
}
