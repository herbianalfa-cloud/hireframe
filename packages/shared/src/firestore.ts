/**
 * Firestore collection and document paths (docs/ARCHITECTURE.md "Data model").
 * The single source for path strings used by services, functions and rules tests.
 */
export const COLLECTIONS = {
  config: 'config',
  criteria: 'criteria',
  profile: 'profile',
  companies: 'companies',
  jobs: 'jobs',
  cvs: 'cvs',
  runs: 'runs',
  usage: 'usage',
  events: 'events',
  locks: 'locks',
} as const;

/** Well-known document paths. */
export const DOCS = {
  appConfig: `${COLLECTIONS.config}/app`,
  criteriaCurrent: `${COLLECTIONS.criteria}/current`,
  profileMain: `${COLLECTIONS.profile}/main`,
  scanLock: `${COLLECTIONS.locks}/scan`,
} as const;

/** Subcollections under `profile/main` and `jobs/{jobId}`. */
export const SUBCOLLECTIONS = {
  facts: 'facts',
  documents: 'documents',
  description: 'description',
} as const;
