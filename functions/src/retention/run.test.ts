import { describe, expect, it } from 'vitest';

import { RETENTION } from '../config.js';
import {
  decidePurge,
  runRetention,
  type ChunkResult,
  type PageRow,
  type PurgeCandidate,
  type RetentionCursor,
  type RetentionStore,
} from './run.js';

const DAY = 86_400_000;
const NOW = new Date('2026-10-14T03:30:00Z');

interface FakeJob extends PurgeCandidate {
  id: string;
  hasDescription: boolean;
}

/** An in-memory store that applies `decidePurge` on its current state, as the transaction does. */
function fakeStore(jobs: FakeJob[], applications = new Set<string>()) {
  const state: {
    cursor: RetentionCursor | null;
    saves: RetentionCursor[];
    chunkSizes: number[];
    failOnChunk?: number;
    beforeChunk?: (ids: readonly string[]) => void;
  } = { cursor: null, saves: [], chunkSizes: [] };
  const store: RetentionStore = {
    readCursor: () => Promise.resolve(state.cursor),
    readPage(cutoff, after, limit) {
      const rows = jobs
        .filter((job) => job.verdict === 'skip' && job.judgedAt && job.judgedAt < cutoff)
        .flatMap((job): PageRow[] => (job.judgedAt ? [{ id: job.id, judgedAt: job.judgedAt }] : []))
        .sort((a, b) => a.judgedAt.getTime() - b.judgedAt.getTime() || a.id.localeCompare(b.id))
        .filter(
          (row) =>
            !after ||
            row.judgedAt.getTime() > after.purgedThrough.getTime() ||
            (row.judgedAt.getTime() === after.purgedThrough.getTime() && row.id > after.lastId),
        );
      return Promise.resolve(rows.slice(0, limit));
    },
    purgeChunk(ids, cutoff, now) {
      state.chunkSizes.push(ids.length);
      if (state.failOnChunk === state.chunkSizes.length) return Promise.reject(new Error('boom'));
      state.beforeChunk?.(ids);
      const out: ChunkResult = { purged: 0, skippedKept: 0, skippedApplication: 0 };
      for (const id of ids) {
        const job = jobs.find((candidate) => candidate.id === id) ?? null;
        const decision = decidePurge(job, applications.has(id), cutoff);
        if (decision === 'application') out.skippedApplication += 1;
        else if (decision === 'kept' || !job) out.skippedKept += 1;
        else {
          job.hasDescription = false;
          job.descriptionPurgedAt = now;
          out.purged += 1;
        }
      }
      return Promise.resolve(out);
    },
    saveCursor(cursor) {
      state.cursor = cursor;
      state.saves.push(cursor);
      return Promise.resolve();
    },
  };
  return { store, state };
}

function job(id: string, ageDays: number, extra: Partial<FakeJob> = {}): FakeJob {
  return {
    id,
    verdict: 'skip',
    judgedAt: new Date(NOW.getTime() - ageDays * DAY),
    status: 'new',
    descriptionKind: 'full',
    hasDescription: true,
    ...extra,
  };
}

function run(store: RetentionStore, now: () => Date = () => NOW) {
  return runRetention({ store, now });
}

describe('runRetention (ADR-057)', () => {
  it('purges at 61 days, not at 59', async () => {
    const jobs = [job('old', 61), job('young', 59)];
    const { store } = fakeStore(jobs);
    const result = await run(store);
    expect(result.purged).toBe(1);
    expect(jobs[0]?.hasDescription).toBe(false);
    expect(jobs[1]?.hasDescription).toBe(true);
  });

  it('keeps a job judged exactly 60 days ago and purges one 1 ms older', async () => {
    const at = (ageMs: number) => new Date(NOW.getTime() - ageMs);
    const jobs = [
      job('edge', 0, { judgedAt: at(60 * DAY) }),
      job('past', 0, { judgedAt: at(60 * DAY + 1) }),
    ];
    const { store } = fakeStore(jobs);
    expect(RETENTION.skipAgeDays).toBe(60);
    expect((await run(store)).purged).toBe(1);
    expect(jobs[0]?.hasDescription).toBe(true);
    expect(jobs[1]?.hasDescription).toBe(false);
  });

  it.each(['new', 'skipped'])('purges a %s job', async (status) => {
    const jobs = [job('a', 70, { status })];
    const { store } = fakeStore(jobs);
    expect((await run(store)).purged).toBe(1);
    expect(jobs[0]?.descriptionPurgedAt).toEqual(NOW);
  });

  it.each(['saved', 'applied', 'interview', 'offer', 'rejected'])(
    'leaves a %s job alone and moves the cursor past it',
    async (status) => {
      const jobs = [job('a', 70, { status })];
      const { store, state } = fakeStore(jobs);
      const result = await run(store);
      expect(result.purged).toBe(0);
      expect(result.skippedKept).toBe(1);
      expect(jobs[0]?.hasDescription).toBe(true);
      expect(state.cursor?.lastId).toBe('a');
    },
  );

  it('leaves a job with an application alone, whatever its stage', async () => {
    const jobs = [job('a', 70), job('b', 70)];
    const { store, state } = fakeStore(jobs, new Set(['a']));
    const result = await run(store);
    expect(result).toMatchObject({ purged: 1, skippedApplication: 1 });
    expect(jobs[0]?.hasDescription).toBe(true);
    expect(state.cursor?.lastId).toBe('b');
  });

  it('leaves a job whose application appears between the page read and the transaction', async () => {
    const jobs = [job('a', 70)];
    const applications = new Set<string>();
    const { store, state } = fakeStore(jobs, applications);
    state.beforeChunk = () => applications.add('a');
    expect((await run(store)).skippedApplication).toBe(1);
    expect(jobs[0]?.hasDescription).toBe(true);
  });

  it('leaves a job whose status changes between the page read and the transaction', async () => {
    const jobs = [job('a', 70, { status: 'skipped' })];
    const { store, state } = fakeStore(jobs);
    state.beforeChunk = () => {
      for (const each of jobs) each.status = 'saved';
    };
    expect((await run(store)).purged).toBe(0);
    expect(jobs[0]?.hasDescription).toBe(true);
  });

  it('leaves a job that was re-scored (no longer old) or deleted since the page read', async () => {
    const jobs = [job('a', 70), job('b', 70)];
    const { store, state } = fakeStore(jobs);
    state.beforeChunk = () => {
      for (const each of jobs) if (each.id === 'a') each.judgedAt = NOW;
      jobs.splice(1, 1);
    };
    const result = await run(store);
    expect(result).toMatchObject({ purged: 0, skippedKept: 2 });
  });

  it('skips already-purged and no-description jobs', async () => {
    const jobs = [
      job('a', 70, { descriptionPurgedAt: new Date(NOW.getTime() - DAY) }),
      job('b', 70, { descriptionKind: 'none' }),
    ];
    const { store } = fakeStore(jobs);
    expect(await run(store)).toMatchObject({ purged: 0, skippedKept: 2 });
  });

  it('considers at most 500 jobs a run and reports the page as full', async () => {
    const jobs = Array.from({ length: 700 }, (_, i) => job(`j${String(i).padStart(4, '0')}`, 90));
    const { store, state } = fakeStore(jobs);
    const result = await run(store);
    expect(result).toMatchObject({ read: RETENTION.maxJobsPerRun, purged: 500, full: true });
    expect(Math.max(...state.chunkSizes)).toBeLessThanOrEqual(RETENTION.chunkJobs);
    // The next run continues after the cursor with the rest.
    const second = await run(store);
    expect(second).toMatchObject({ read: 200, purged: 200, full: false });
  });

  it('stops starting transactions after 240 s', async () => {
    const jobs = Array.from({ length: 300 }, (_, i) => job(`j${String(i).padStart(3, '0')}`, 90));
    const { store, state } = fakeStore(jobs);
    let calls = 0;
    // The first call fixes the start; every later one is past the deadline after chunk 1.
    const now = () => new Date(NOW.getTime() + (calls++ < 4 ? 0 : RETENTION.deadlineMs));
    const result = await run(store, now);
    expect(result.timedOut).toBe(true);
    expect(state.chunkSizes.length).toBeLessThan(3);
    expect(result.purged).toBeLessThan(300);
  });

  it('loses no job across two runs when many share one judgedAt (ties at a page boundary)', async () => {
    const same = new Date(NOW.getTime() - 90 * DAY);
    const jobs = Array.from({ length: 650 }, (_, i) =>
      job(`t${String(i).padStart(4, '0')}`, 90, { judgedAt: same }),
    );
    const { store } = fakeStore(jobs);
    await run(store);
    await run(store);
    expect(jobs.filter((j) => j.hasDescription)).toHaveLength(0);
  });

  it('saves the cursor after each committed transaction', async () => {
    const jobs = Array.from({ length: 250 }, (_, i) => job(`j${String(i).padStart(3, '0')}`, 90));
    const { store, state } = fakeStore(jobs);
    await run(store);
    expect(state.saves.map((cursor) => cursor.lastId)).toEqual(['j099', 'j199', 'j249']);
  });

  it('keeps the cursor at the last commit when the store fails', async () => {
    const jobs = Array.from({ length: 250 }, (_, i) => job(`j${String(i).padStart(3, '0')}`, 90));
    const { store, state } = fakeStore(jobs);
    state.failOnChunk = 2;
    const result = await run(store);
    expect(result.failed).toBe(true);
    expect(state.cursor?.lastId).toBe('j099');
  });

  it('keeps every transaction within 200 writes', () => {
    expect(RETENTION.chunkJobs * 2).toBeLessThanOrEqual(200);
  });
});
