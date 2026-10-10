import { COLLECTIONS } from './firestore.js';
import type { QuerySpec } from './query-spec.js';

/**
 * The pipeline's to-do count (M7 7D.4). Kept apart from `applications.ts` on purpose: the app
 * shell reads it at start-up, and that module's schemas would come with it into the initial JS.
 * Nothing here may import a zod schema.
 */

/** The stages that wait for the owner: a question to answer, or a CV to send. */
export const TODO_STAGES = ['needs_input', 'ready'] as const;

/**
 * The badge's and the summary bar's "Things to do" count: equality only, no `orderBy`, so the
 * single-field index on `stage` serves it and no composite is needed. Read with a limit.
 */
export const todoApplicationsSpec: QuerySpec = {
  collection: COLLECTIONS.applications,
  filters: [{ field: 'stage', op: 'in', value: [...TODO_STAGES] }],
  orderBy: [],
};

/** The most applications a to-do count reads; a count at the limit is shown as "n+". */
export const TODO_COUNT_LIMIT = 50;
