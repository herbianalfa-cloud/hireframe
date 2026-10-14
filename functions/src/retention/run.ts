import { DESCRIPTION_KINDS, type DescriptionKind, type JobStatus } from '@hireframe/shared';

import { RETENTION } from '../config.js';
import { errorFields, log } from '../log.js';

/**
 * Retention (ADR-057): deletes the stored description of skipped jobs older than 60 days. A pure
 * pass over a store, so the tests drive it with a fake clock and no network. It never calls
 * itself and starts no new transaction after `RETENTION.deadlineMs`.
 */

/** `(judgedAt, id)`: one run stamps one `judgedAt` on many jobs, so time alone would skip ties. */
export interface RetentionCursor {
  purgedThrough: Date;
  lastId: string;
}

export interface PageRow {
  id: string;
  judgedAt: Date;
}

/** The fields the purge decision reads, from a fresh read inside the transaction. */
export interface PurgeCandidate {
  verdict?: string;
  judgedAt?: Date;
  status?: string;
  descriptionKind?: string;
  descriptionPurgedAt?: Date;
}

export type PurgeDecision = 'purge' | 'kept' | 'application';

/** Statuses that may lose their description: nothing the owner acted on. */
const PURGEABLE_STATUSES: readonly JobStatus[] = ['new', 'skipped'];

/**
 * Whether one job's description may go. Used on the fresh reads inside the transaction, so a job
 * that changed since the page read (a re-score, a status change, a new application, a wipe) is
 * left alone. `job` is null for a document that no longer exists.
 */
export function decidePurge(
  job: PurgeCandidate | null,
  hasApplication: boolean,
  cutoff: Date,
): PurgeDecision {
  if (!job) return 'kept';
  if (job.verdict !== 'skip') return 'kept';
  if (!job.judgedAt || job.judgedAt.getTime() >= cutoff.getTime()) return 'kept';
  if (!PURGEABLE_STATUSES.includes(job.status as JobStatus)) return 'kept';
  if (hasApplication) return 'application';
  if (job.descriptionPurgedAt) return 'kept';
  if (!DESCRIPTION_KINDS.includes(job.descriptionKind as DescriptionKind)) return 'kept';
  if (job.descriptionKind === 'none') return 'kept';
  return 'purge';
}

export interface ChunkResult {
  purged: number;
  skippedKept: number;
  skippedApplication: number;
}

export interface RetentionStore {
  readCursor(): Promise<RetentionCursor | null>;
  /** Old skips after the cursor, `judgedAt` ascending then ID, at most `limit`. */
  readPage(cutoff: Date, after: RetentionCursor | null, limit: number): Promise<PageRow[]>;
  /** One transaction: re-reads the jobs and their applications, re-checks, deletes, stamps. */
  purgeChunk(ids: readonly string[], cutoff: Date, now: Date): Promise<ChunkResult>;
  saveCursor(cursor: RetentionCursor, now: Date): Promise<void>;
}

export interface RetentionDeps {
  store: RetentionStore;
  now: () => Date;
}

export interface RetentionResult {
  read: number;
  purged: number;
  skippedKept: number;
  skippedApplication: number;
  /** The page was full: more may be waiting (a backlog if this is true every day). */
  full: boolean;
  /** A store error stopped the run; the cursor stays at the last commit. */
  failed: boolean;
  /** The 240 s deadline stopped the run before the page was finished. */
  timedOut: boolean;
}

export async function runRetention(deps: RetentionDeps): Promise<RetentionResult> {
  const result: RetentionResult = {
    read: 0,
    purged: 0,
    skippedKept: 0,
    skippedApplication: 0,
    full: false,
    failed: false,
    timedOut: false,
  };
  const started = deps.now();
  const cutoff = new Date(started.getTime() - RETENTION.skipAgeDays * 86_400_000);
  try {
    const cursor = await deps.store.readCursor();
    const page = await deps.store.readPage(cutoff, cursor, RETENTION.maxJobsPerRun);
    result.read = page.length;
    result.full = page.length >= RETENTION.maxJobsPerRun;
    for (let start = 0; start < page.length; start += RETENTION.chunkJobs) {
      if (deps.now().getTime() - started.getTime() >= RETENTION.deadlineMs) {
        result.timedOut = true;
        break;
      }
      const chunk = page.slice(start, start + RETENTION.chunkJobs);
      const outcome = await deps.store.purgeChunk(
        chunk.map((row) => row.id),
        cutoff,
        deps.now(),
      );
      result.purged += outcome.purged;
      result.skippedKept += outcome.skippedKept;
      result.skippedApplication += outcome.skippedApplication;
      const last = chunk[chunk.length - 1];
      // The cursor moves past every job in the chunk, purged or left alone.
      if (last) {
        await deps.store.saveCursor({ purgedThrough: last.judgedAt, lastId: last.id }, deps.now());
      }
    }
  } catch (error) {
    result.failed = true;
    log.error('retention.failed', errorFields(error));
    return result;
  }
  log.info('retention.done', {
    read: result.read,
    purged: result.purged,
    skippedKept: result.skippedKept,
    skippedApplication: result.skippedApplication,
    full: result.full,
    timedOut: result.timedOut,
  });
  return result;
}
