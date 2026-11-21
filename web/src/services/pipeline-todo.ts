import { TODO_COUNT_LIMIT } from '@hireframe/shared';

import { getFirebase } from './firebase';
import { errorCode, logError } from './log';

/**
 * The pipeline's "things to do" count (M7 7D.4): applications waiting on the owner (a question to
 * answer, or a CV to send). The nav badge and the summary bar's slot both show it, so they share
 * one listener. The read is a snapshot listener with a limit (`TODO_COUNT_LIMIT`), not a loop and
 * not a poll; a count at the limit is shown as "n+". It starts only when something subscribes,
 * and the callers subscribe only after `hf:usable`.
 */

export type TodoCount =
  { status: 'loading' } | { status: 'ready'; count: number; capped: boolean } | { status: 'error' };

type Listener = (state: TodoCount) => void;

const listeners = new Set<Listener>();
let current: TodoCount = { status: 'loading' };
let stop: (() => void) | undefined;

function publish(next: TodoCount): void {
  current = next;
  for (const listener of [...listeners]) listener(next);
}

function start(): () => void {
  let cancelled = false;
  let unsubscribe: (() => void) | undefined;
  // The listener module (and the Firestore query helpers it brings) is a lazy chunk (ADR-066).
  Promise.all([getFirebase(), import('./pipeline-todo-listen')]).then(
    ([{ db }, listen]) => {
      if (cancelled) return;
      unsubscribe = listen.listenTodoApplications(
        db,
        (count) => {
          publish({ status: 'ready', count, capped: count >= TODO_COUNT_LIMIT });
        },
        (code) => {
          logError('pipeline.todo_failed', { code });
          publish({ status: 'error' });
        },
      );
    },
    (error: unknown) => {
      logError('pipeline.todo_failed', { code: errorCode(error) ?? 'unknown' });
      if (!cancelled) publish({ status: 'error' });
    },
  );
  return () => {
    cancelled = true;
    unsubscribe?.();
  };
}

/** Subscribe to the count; the one shared listener runs while anything is subscribed. */
export function watchTodoCount(callback: Listener): () => void {
  listeners.add(callback);
  callback(current);
  if (listeners.size === 1) stop = start();
  return () => {
    listeners.delete(callback);
    if (listeners.size === 0) {
      stop?.();
      stop = undefined;
      current = { status: 'loading' };
    }
  };
}
