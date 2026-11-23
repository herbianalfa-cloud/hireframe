import { COLLECTIONS, TODO_COUNT_LIMIT, todoApplicationsSpec } from '@hireframe/shared';
import { collection, limit, query, type Firestore } from 'firebase/firestore';

import { specConstraints } from './query-spec';
import { watchSnapshot } from './reads';

/**
 * The pipeline badge's limited listener (see pipeline-todo.ts). Its own module, imported
 * dynamically, so the Firestore query helpers stay out of the entry chunk (ADR-066).
 */
export function listenTodoApplications(
  db: Firestore,
  next: (count: number) => void,
  error: (code: string) => void,
): () => void {
  return watchSnapshot(
    query(
      collection(db, COLLECTIONS.applications),
      ...specConstraints(todoApplicationsSpec),
      limit(TODO_COUNT_LIMIT),
    ),
    (snapshot) => {
      next(snapshot.size);
    },
    (e) => {
      error(e.code);
    },
  );
}
