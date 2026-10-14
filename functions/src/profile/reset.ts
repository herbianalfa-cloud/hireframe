import {
  isParseStalled,
  ProfileDocumentSchema,
  ResetProfileInputSchema,
  STORAGE_PATHS,
  type ResetProfileResult,
} from '@hireframe/shared';
import { HttpsError } from 'firebase-functions/https';

import { log } from '../log.js';

/**
 * resetProfile (ADR-023, SECURITY "Delete all my data" for the profile): hard-deletes every
 * fact with its versions, every upload document and every uploaded file. Criteria, usage and
 * config are never touched. Refuses while a CV is being read, so a parse can't write facts
 * back into the emptied profile.
 */
export interface ResetStore {
  /** Upload documents (raw data, timestamps as Dates) with status `parsing`. */
  parsingDocuments(): Promise<unknown[]>;
  /** Deletes every fact (with versions) and upload document; returns how many there were. */
  deleteProfile(): Promise<{ facts: number; documents: number }>;
}

export interface ResetDeps {
  store: ResetStore;
  /** Deletes every object under `prefix`; returns how many there were. */
  deleteFiles: (prefix: string) => Promise<number>;
  now: () => Date;
}

/** Refuses while a CV is being read, so a parse can't write facts back into an emptied profile. */
export async function assertNoCvBeingRead(store: ResetStore, now: Date): Promise<void> {
  const reading = (await store.parsingDocuments()).some((raw) => {
    const parsed = ProfileDocumentSchema.safeParse(raw);
    // An unreadable document can't be a parse in progress that we know of.
    return parsed.success && !isParseStalled(parsed.data, now);
  });
  if (reading) {
    log.warn('profile.reset', { refused: 'parse_running' });
    throw new HttpsError(
      'failed-precondition',
      'A CV is being read. Try again when it has finished.',
    );
  }
}

/**
 * The delete itself, shared by Reset profile and Delete all my data (ADR-057): the parse check,
 * then every fact, upload document, the profile settings and the uploaded files.
 */
export async function resetProfileCore(deps: ResetDeps): Promise<ResetProfileResult> {
  await assertNoCvBeingRead(deps.store, deps.now());
  const { facts, documents } = await deps.store.deleteProfile();
  const files = await deps.deleteFiles(STORAGE_PATHS.profileDocumentsPrefix);
  return { facts, documents, files };
}

export async function resetProfileHandler(
  data: unknown,
  deps: ResetDeps,
): Promise<ResetProfileResult> {
  if (!ResetProfileInputSchema.safeParse(data).success) {
    throw new HttpsError('invalid-argument', 'Type RESET to confirm.');
  }
  const result = await resetProfileCore(deps);
  log.info('profile.reset', { ...result });
  return result;
}
