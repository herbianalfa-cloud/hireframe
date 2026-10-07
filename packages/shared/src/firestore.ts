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
  sources: 'sources',
  /** Server-only: signed-request nonces for the Gmail bridge (ADR-046). TTL on `expireAt`. */
  nonces: 'nonces',
  /** Server-only: one doc per ingested alert email, counts only (ADR-047). TTL on `expireAt`. */
  alertMessages: 'alertMessages',
} as const;

/** Region of the callable functions (ADR-017). Lives here, a pure module, so the app shell can import it without pulling in the schemas. */
export const FUNCTIONS_REGION = 'europe-west2';

/** Well-known document paths. */
export const DOCS = {
  appConfig: `${COLLECTIONS.config}/app`,
  criteriaCurrent: `${COLLECTIONS.criteria}/current`,
  profileMain: `${COLLECTIONS.profile}/main`,
  scanLock: `${COLLECTIONS.locks}/scan`,
} as const;

/** Subcollections under `profile/main`, `profile/main/facts/{factId}` and `jobs/{jobId}`. */
export const SUBCOLLECTIONS = {
  facts: 'facts',
  versions: 'versions',
  documents: 'documents',
  description: 'description',
} as const;

export const PATHS = {
  facts: `${DOCS.profileMain}/${SUBCOLLECTIONS.facts}`,
  fact: (factId: string) => `${DOCS.profileMain}/${SUBCOLLECTIONS.facts}/${factId}`,
  factVersion: (factId: string, version: number) =>
    `${DOCS.profileMain}/${SUBCOLLECTIONS.facts}/${factId}/${SUBCOLLECTIONS.versions}/${String(version)}`,
  factVersions: (factId: string) =>
    `${DOCS.profileMain}/${SUBCOLLECTIONS.facts}/${factId}/${SUBCOLLECTIONS.versions}`,
  documents: `${DOCS.profileMain}/${SUBCOLLECTIONS.documents}`,
  document: (docId: string) => `${DOCS.profileMain}/${SUBCOLLECTIONS.documents}/${docId}`,
  criteriaVersion: (versionId: string) => `${COLLECTIONS.criteria}/${versionId}`,
  usage: (month: string) => `${COLLECTIONS.usage}/${month}`,
  job: (jobId: string) => `${COLLECTIONS.jobs}/${jobId}`,
  /** Full text, kept apart so job list reads stay cheap. */
  jobDescription: (jobId: string) =>
    `${COLLECTIONS.jobs}/${jobId}/${SUBCOLLECTIONS.description}/raw`,
  run: (runId: string) => `${COLLECTIONS.runs}/${runId}`,
  source: (sourceId: string) => `${COLLECTIONS.sources}/${sourceId}`,
  company: (companyId: string) => `${COLLECTIONS.companies}/${companyId}`,
  nonce: (nonce: string) => `${COLLECTIONS.nonces}/${nonce}`,
  alertMessage: (hash: string) => `${COLLECTIONS.alertMessages}/${hash}`,
} as const;

/** Cloud Storage object paths (storage.rules). */
export const STORAGE_PATHS = {
  /** Every uploaded CV (Reset profile deletes everything under it). */
  profileDocumentsPrefix: 'profile/documents/',
  /** Uploaded CV: `profile/documents/{docId}/cv.pdf` or `cv.docx`. */
  profileDocument: (docId: string, kind: 'pdf' | 'docx') => `profile/documents/${docId}/cv.${kind}`,
} as const;
