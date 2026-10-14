import { COLLECTIONS, type WipeStep } from '@hireframe/shared';

/**
 * The collections each wipe step empties (ADR-057), in the order a call runs them. Kept out of
 * the store so a test can pin the plan: `events` and `alertMessages` are in it, and `config`,
 * `criteria`, `usage`, `locks` and `nonces` never are.
 */
export type WipeDocStep = Exclude<WipeStep, 'cvFiles'>;

export const WIPE_COLLECTIONS: Record<WipeDocStep, string> = {
  applications: COLLECTIONS.applications,
  cvs: COLLECTIONS.cvs,
  jobs: COLLECTIONS.jobs,
  runs: COLLECTIONS.runs,
  events: COLLECTIONS.events,
  alertMessages: COLLECTIONS.alertMessages,
  companies: COLLECTIONS.companies,
  sources: COLLECTIONS.sources,
};

/** The Storage prefix of generated CV files; uploaded CVs sit under the profile step. */
export const WIPE_CV_FILES_PREFIX = 'cvs/';

/** What a source doc keeps: its call counters and host pauses (ADR-025). */
const KEPT_SOURCE_FIELDS = ['quota', 'pausedHosts'] as const;
const KEPT_ONLY_KEYS: ReadonlySet<string> = new Set([
  ...KEPT_SOURCE_FIELDS,
  'updatedAt',
  'schemaVersion',
]);

export type SourceWipe =
  /** Already only the kept fields: nothing to do. */
  | { action: 'keep' }
  /** Rewrite to just the kept fields. */
  | { action: 'rewrite'; kept: Record<string, unknown> }
  | { action: 'delete' };

/** What a pass does to one `sources/{id}` document (pure). */
export function planSourceDoc(data: Record<string, unknown> | undefined): SourceWipe {
  const kept: Record<string, unknown> = {};
  for (const field of KEPT_SOURCE_FIELDS) {
    if (data?.[field] !== undefined) kept[field] = data[field];
  }
  if (Object.keys(kept).length === 0) return { action: 'delete' };
  const onlyKept = Object.keys(data ?? {}).every((key) => KEPT_ONLY_KEYS.has(key));
  return onlyKept ? { action: 'keep' } : { action: 'rewrite', kept };
}
