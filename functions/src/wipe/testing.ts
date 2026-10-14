import type { LockHolder, WipeStep } from '@hireframe/shared';

import type { ResetDeps } from '../profile/reset.js';
import type { WipeLockResult } from '../scan/store.js';
import { planSourceDoc, type WipeDocStep } from './plan.js';
import type { WipeStore } from './run.js';

/**
 * An in-memory wipe store on a fake clock (ADR-057). Each page costs `pageMs` of the clock, so a
 * test can run a call past the deadline. It records every call so a test can say what was
 * touched, and its own lock follows the real rules: a live other holder refuses.
 */
export interface MemoryWipe {
  store: WipeStore;
  reset: ResetDeps;
  clock: { now: Date };
  /** Document IDs per step; a job's description goes with it. Sources hold raw data. */
  docs: Record<Exclude<WipeDocStep, 'sources'>, string[]>;
  sources: Map<string, Record<string, unknown>>;
  files: string[];
  lock: { holder: LockHolder | null };
  generating: boolean;
  parsing: unknown[];
  profile: { facts: number; documents: number; files: number };
  calls: string[];
  /** Runs just before a page of `step` is deleted; the `n`th page of that step (from 1). */
  beforePage?: (step: WipeStep, n: number) => void;
  /** A page of this step throws once (a store outage mid-wipe). */
  failOnce?: WipeDocStep;
  pageMs: number;
  /** When set, only pages of this step cost `pageMs`. */
  slow?: WipeStep;
}

export const NOW = new Date('2026-10-14T09:00:00Z');

export function memoryWipe(
  seed: Partial<Record<Exclude<WipeDocStep, 'sources'>, number>> = {},
  options: { files?: number } = {},
): MemoryWipe {
  const ids = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => `${prefix}-${String(i)}`);
  const w: MemoryWipe = {
    docs: {
      applications: ids('a', seed.applications ?? 0),
      cvs: ids('c', seed.cvs ?? 0),
      jobs: ids('j', seed.jobs ?? 0),
      runs: ids('r', seed.runs ?? 0),
      events: ids('e', seed.events ?? 0),
      alertMessages: ids('m', seed.alertMessages ?? 0),
      companies: ids('co', seed.companies ?? 0),
    },
    sources: new Map(),
    files: ids('cvs/f', options.files ?? 0),
    lock: { holder: null },
    generating: false,
    parsing: [],
    profile: { facts: 0, documents: 0, files: 0 },
    calls: [],
    clock: { now: NOW },
    pageMs: 0,
    store: undefined as unknown as WipeStore,
    reset: undefined as unknown as ResetDeps,
  };
  const pages = new Map<string, number>();
  const tick = (step: WipeStep) => {
    if (w.slow !== undefined && w.slow !== step) return;
    w.clock.now = new Date(w.clock.now.getTime() + w.pageMs);
  };
  const pageNumber = (step: WipeStep) => {
    const n = (pages.get(step) ?? 0) + 1;
    pages.set(step, n);
    return n;
  };

  w.store = {
    liveLockHolder: () => {
      w.calls.push('liveLockHolder');
      return Promise.resolve(w.lock.holder);
    },
    hasGenerating: () => {
      w.calls.push('hasGenerating');
      return Promise.resolve(w.generating);
    },
    acquire: (): Promise<WipeLockResult> => {
      w.calls.push('acquire');
      if (w.lock.holder && w.lock.holder !== 'wipe') {
        return Promise.resolve({ ok: false, holder: w.lock.holder });
      }
      w.lock.holder = 'wipe';
      return Promise.resolve({ ok: true });
    },
    release: () => {
      w.calls.push('release');
      w.lock.holder = null;
      return Promise.resolve();
    },
    deletePage: (step, limit) => {
      w.calls.push(`delete:${step}`);
      w.beforePage?.(step, pageNumber(step));
      if (w.failOnce === step) {
        delete w.failOnce;
        return Promise.reject(new Error('store unavailable'));
      }
      tick(step);
      if (step === 'sources') {
        let changed = 0;
        for (const [id, data] of [...w.sources]) {
          if (changed >= limit) break;
          const plan = planSourceDoc(data);
          if (plan.action === 'keep') continue;
          if (plan.action === 'delete') w.sources.delete(id);
          else w.sources.set(id, { ...plan.kept, updatedAt: w.clock.now, schemaVersion: 1 });
          changed += 1;
        }
        return Promise.resolve({ deleted: changed, exhausted: true });
      }
      const list = w.docs[step];
      const perDoc = step === 'jobs' ? 2 : 1;
      const take = Math.max(1, Math.floor(limit / perDoc));
      const removed = list.splice(0, take);
      return Promise.resolve({
        deleted: removed.length * perDoc,
        exhausted: removed.length < take,
      });
    },
    deleteFilesPage: (pageSize) => {
      w.calls.push('delete:cvFiles');
      w.beforePage?.('cvFiles', pageNumber('cvFiles'));
      tick('cvFiles');
      const removed = w.files.splice(0, pageSize);
      return Promise.resolve({ deleted: removed.length, exhausted: removed.length < pageSize });
    },
    hasAny: (step) => {
      w.calls.push(`has:${step}`);
      if (step === 'cvFiles') return Promise.resolve(w.files.length > 0);
      if (step === 'sources') {
        return Promise.resolve(
          [...w.sources.values()].some((data) => planSourceDoc(data).action !== 'keep'),
        );
      }
      return Promise.resolve(w.docs[step].length > 0);
    },
  };

  w.reset = {
    store: {
      parsingDocuments: () => {
        w.calls.push('parsingDocuments');
        return Promise.resolve(w.parsing);
      },
      deleteProfile: () => {
        w.calls.push('deleteProfile');
        const { facts, documents } = w.profile;
        w.profile = { facts: 0, documents: 0, files: w.profile.files };
        return Promise.resolve({ facts, documents });
      },
    },
    deleteFiles: () => {
      w.calls.push('deleteProfileFiles');
      const { files } = w.profile;
      w.profile.files = 0;
      return Promise.resolve(files);
    },
    now: () => w.clock.now,
  };
  return w;
}
