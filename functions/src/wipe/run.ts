import {
  DeleteAllDataInputSchema,
  WIPE_STEPS,
  type DeleteAllDataResult,
  type LockHolder,
  type WipeStep,
} from '@hireframe/shared';
import { HttpsError } from 'firebase-functions/https';

import { WIPE } from '../config.js';
import { log } from '../log.js';
import { assertNoCvBeingRead, resetProfileCore, type ResetDeps } from '../profile/reset.js';
import { busyMessage } from '../scan/handler.js';
import type { WipeLockResult } from '../scan/store.js';
import type { WipeDocStep } from './plan.js';

/**
 * Delete all my data (ADR-057). One call is one bounded pass: it deletes what is there now, step
 * by step in a fixed order, then re-reads every step (reads only) to say what is left. It never
 * stores progress and never calls itself; the client repeats it until `done`, which only a call
 * that deleted nothing and found every step empty returns.
 */
export interface WipeStore {
  /** The live (not stale) holder of the scan lock, or null. */
  liveLockHolder(now: Date): Promise<LockHolder | null>;
  /** Whether any application is at stage `generating`. */
  hasGenerating(): Promise<boolean>;
  /** Takes the lock as `wipe`, or refreshes it when `wipe` already holds it. */
  acquire(now: Date): Promise<WipeLockResult>;
  /** Releases the lock as a short holder: no scan cooldown starts. */
  release(now: Date): Promise<void>;
  /** Deletes up to `limit` documents of one step (a job's description counts as one). */
  deletePage(step: WipeDocStep, limit: number): Promise<{ deleted: number; exhausted: boolean }>;
  /** Deletes one Storage listing page of generated CV files. */
  deleteFilesPage(pageSize: number): Promise<{ deleted: number; exhausted: boolean }>;
  /** Whether a step still has anything to delete (a cheap read). */
  hasAny(step: WipeStep): Promise<boolean>;
}

export interface WipeDeps {
  store: WipeStore;
  /** The Reset profile core's dependencies, used when the owner ticked "also reset profile". */
  reset: ResetDeps;
  now: () => Date;
  /** Test seam: smaller bounds than `WIPE`. */
  limits?: Partial<Record<keyof typeof WIPE, number>>;
}

function refuse(holder: LockHolder): never {
  log.warn('wipe.refused', { holder });
  throw new HttpsError('failed-precondition', busyMessage(holder));
}

export async function deleteAllDataHandler(
  data: unknown,
  deps: WipeDeps,
): Promise<DeleteAllDataResult> {
  const input = DeleteAllDataInputSchema.safeParse(data);
  if (!input.success) {
    throw new HttpsError('invalid-argument', 'Type DELETE to confirm.');
  }
  const { store } = deps;
  const limits: Record<keyof typeof WIPE, number> = { ...WIPE, ...deps.limits };

  // Refusals come before any delete, and are checked on every call so a partial wipe can't
  // start while something is writing.
  const holder = await store.liveLockHolder(deps.now());
  if (holder !== null && holder !== 'wipe') refuse(holder);
  if (await store.hasGenerating()) {
    log.warn('wipe.refused', { reason: 'generating' });
    throw new HttpsError('failed-precondition', 'Wait for the CV being written.');
  }
  if (input.data.resetProfile) await assertNoCvBeingRead(deps.reset.store, deps.now());

  const lock = await store.acquire(deps.now());
  if (!lock.ok) refuse(lock.holder);

  const startedAt = deps.now().getTime();
  const timeLeft = () => deps.now().getTime() - startedAt < limits.deadlineMs;
  let documents = 0;
  let files = 0;
  let docsLeft: number = limits.maxDocuments;
  let pagesLeft: number = limits.maxStoragePages;
  const unfinished = new Set<WipeStep>();

  // The delete pass. A step stops short only on the document cap, the page cap or the deadline.
  for (const step of WIPE_STEPS) {
    if (step === 'cvFiles') {
      for (;;) {
        if (pagesLeft <= 0 || !timeLeft()) {
          unfinished.add(step);
          break;
        }
        pagesLeft -= 1;
        const page = await store.deleteFilesPage(limits.storagePageSize);
        files += page.deleted;
        if (page.exhausted) break;
      }
      continue;
    }
    for (;;) {
      if (docsLeft <= 0 || !timeLeft()) {
        unfinished.add(step);
        break;
      }
      const page = await store.deletePage(step, Math.min(limits.pageSize, docsLeft));
      documents += page.deleted;
      docsLeft -= page.deleted;
      if (page.exhausted) break;
    }
  }

  // The check pass (reads only): what is still there now, including anything written meanwhile.
  const remaining: WipeStep[] = [];
  for (const step of WIPE_STEPS) {
    if (unfinished.has(step) || !timeLeft() || (await store.hasAny(step))) remaining.push(step);
  }

  // The profile goes last, and only from a pass that found everything else empty.
  let profile: DeleteAllDataResult['profile'];
  if (input.data.resetProfile && remaining.length === 0) {
    profile = await resetProfileCore(deps.reset);
    documents += profile.facts + profile.documents;
    files += profile.files;
  }

  const done = remaining.length === 0 && documents === 0 && files === 0;
  if (done) {
    await store.release(deps.now());
  } else {
    // Keep the lock alive for the next call; if a scan took a stale one, the next call refuses.
    await store.acquire(deps.now());
  }
  log.info('wipe.pass', { documents, files, remaining: remaining.length, done });
  return { done, deleted: { documents, files }, remaining, ...(profile ? { profile } : {}) };
}
