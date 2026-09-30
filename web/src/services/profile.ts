import {
  AddFactResultSchema,
  CV_MIME_TYPES,
  FactSchema,
  FactVersionSchema,
  MAX_CV_BYTES,
  ParseCvResultSchema,
  PATHS,
  ProfileDocumentSchema,
  STORAGE_PATHS,
  type AddFactResult,
  type CvKind,
  type Fact,
  type FactVersion,
  type ParseCvResult,
  type ProfileDocument,
} from '@hireframe/shared';
import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  writeBatch,
  type DocumentData,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { ref, uploadBytes } from 'firebase/storage';

import {
  buildAcceptReview,
  buildFactWrite,
  buildKeepReview,
  type FactPatch,
  type FactWrite,
} from './fact-writes';
import { getFirebase } from './firebase';
import { errorCode, logError } from './log';
import { withRetry, withTimeout } from './resilience';
import { timestampsToDates } from './timestamps';

/**
 * Profile brain services (PRD R2). Components use these, never Firebase directly.
 * - Reads are live listeners, zod-parsed; invalid documents are skipped and counted.
 * - Edits are versioned batches built by fact-writes.ts and enforced by firestore.rules.
 * - parseCv/addFact spend money, so they are never retried automatically; llm.call retries
 *   transient API errors on the server.
 */

export interface FactView {
  id: string;
  fact: Fact;
  /** The document as stored, needed to build an exact version snapshot. */
  raw: DocumentData;
}

export type LiveState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T; invalid: number }
  | { status: 'error'; message: string };

export type Unsubscribe = () => void;

const WRITE_TIMEOUT_MS = 15_000;
const PARSE_TIMEOUT_MS = 560_000; // parseCv may run for up to 540 s
const ADD_FACT_TIMEOUT_MS = 130_000;

/** Starts a Firestore listener once Firebase is ready; the returned function stops it. */
export function listen(
  build: () => Promise<Unsubscribe>,
  onError: (message: string) => void,
): Unsubscribe {
  let cancelled = false;
  let unsubscribe: Unsubscribe | undefined;
  build().then(
    (next) => {
      if (cancelled) next();
      else unsubscribe = next;
    },
    (error: unknown) => {
      logError('profile.listen_failed', { code: errorCode(error) ?? 'unknown' });
      if (!cancelled) onError("Couldn't load your profile. Reload to try again.");
    },
  );
  return () => {
    cancelled = true;
    unsubscribe?.();
  };
}

/** Every fact, newest first. */
export function watchFacts(callback: (state: LiveState<FactView[]>) => void): Unsubscribe {
  callback({ status: 'loading' });
  return listen(
    async () => {
      const { db } = await getFirebase();
      return onSnapshot(
        query(collection(db, PATHS.facts), orderBy('createdAt', 'desc')),
        (snapshot) => {
          const facts: FactView[] = [];
          let invalid = 0;
          for (const item of snapshot.docs) {
            const raw = item.data();
            const parsed = FactSchema.safeParse(timestampsToDates(raw));
            if (parsed.success) facts.push({ id: item.id, fact: parsed.data, raw });
            else invalid++;
          }
          if (invalid > 0) logError('profile.fact_invalid', { count: invalid });
          callback({ status: 'ready', data: facts, invalid });
        },
        (error) => {
          logError('profile.facts_failed', { code: error.code });
          callback({ status: 'error', message: "Couldn't load your facts. Reload to try again." });
        },
      );
    },
    (message) => {
      callback({ status: 'error', message });
    },
  );
}

export interface DocumentView {
  id: string;
  document: ProfileDocument;
}

/** The most recent CV uploads and their parse status. */
export function watchDocuments(callback: (state: LiveState<DocumentView[]>) => void): Unsubscribe {
  callback({ status: 'loading' });
  return listen(
    async () => {
      const { db } = await getFirebase();
      return onSnapshot(
        query(collection(db, PATHS.documents), orderBy('createdAt', 'desc'), limit(10)),
        (snapshot) => {
          const documents: DocumentView[] = [];
          let invalid = 0;
          for (const item of snapshot.docs) {
            const parsed = ProfileDocumentSchema.safeParse(timestampsToDates(item.data()));
            if (parsed.success) documents.push({ id: item.id, document: parsed.data });
            else invalid++;
          }
          callback({ status: 'ready', data: documents, invalid });
        },
        (error) => {
          logError('profile.documents_failed', { code: error.code });
          callback({
            status: 'error',
            message: "Couldn't load your uploads. Reload to try again.",
          });
        },
      );
    },
    (message) => {
      callback({ status: 'error', message });
    },
  );
}

export interface VersionView {
  version: number;
  entry: FactVersion;
}

/** A fact's history, newest version first. */
export function watchFactVersions(
  factId: string,
  callback: (state: LiveState<VersionView[]>) => void,
): Unsubscribe {
  callback({ status: 'loading' });
  return listen(
    async () => {
      const { db } = await getFirebase();
      return onSnapshot(
        collection(db, PATHS.factVersions(factId)),
        (snapshot) => {
          const versions: VersionView[] = [];
          let invalid = 0;
          for (const item of snapshot.docs) {
            const parsed = FactVersionSchema.safeParse(timestampsToDates(item.data()));
            if (parsed.success) versions.push({ version: Number(item.id), entry: parsed.data });
            else invalid++;
          }
          versions.sort((a, b) => b.version - a.version);
          callback({ status: 'ready', data: versions, invalid });
        },
        (error) => {
          logError('profile.versions_failed', { code: error.code });
          callback({ status: 'error', message: "Couldn't load this fact's history." });
        },
      );
    },
    (message) => {
      callback({ status: 'error', message });
    },
  );
}

export class CvFileError extends Error {
  override name = 'CvFileError';
}

/** The CV kind for a picked file, or an error message the UI can show. */
export function cvKindOf(file: Pick<File, 'name' | 'size' | 'type'>): CvKind {
  const extension = file.name.toLowerCase().split('.').pop();
  const kind: CvKind | undefined =
    extension === 'pdf' ? 'pdf' : extension === 'docx' ? 'docx' : undefined;
  if (!kind) throw new CvFileError('Choose a PDF or Word (.docx) file.');
  if (file.size === 0) throw new CvFileError('That file is empty.');
  if (file.size > MAX_CV_BYTES) throw new CvFileError('The file is larger than 5 MB.');
  return kind;
}

/** Uploads a CV to a new document ID and returns the ID. Nothing is written to Firestore. */
export async function uploadCv(file: File): Promise<string> {
  const kind = cvKindOf(file);
  const { db, storage } = await getFirebase();
  const docId = doc(collection(db, PATHS.documents)).id;
  await withRetry(
    () =>
      withTimeout(
        uploadBytes(ref(storage, STORAGE_PATHS.profileDocument(docId, kind)), file, {
          contentType: CV_MIME_TYPES[kind],
        }),
        60_000,
        'CV upload',
      ),
    {
      label: 'profile.upload_cv',
      isRetryable: (error) => errorCode(error) === 'storage/retry-limit-exceeded',
    },
  );
  return docId;
}

export async function parseCv(docId: string): Promise<ParseCvResult> {
  const { functions } = await getFirebase();
  const call = httpsCallable(functions, 'parseCv', {
    timeout: PARSE_TIMEOUT_MS,
    limitedUseAppCheckTokens: true,
  });
  const result = await call({ docId });
  return ParseCvResultSchema.parse(result.data);
}

export async function addFact(text: string): Promise<AddFactResult> {
  const { functions } = await getFirebase();
  const call = httpsCallable(functions, 'addFact', {
    timeout: ADD_FACT_TIMEOUT_MS,
    limitedUseAppCheckTokens: true,
  });
  const result = await call({ text });
  return AddFactResultSchema.parse(result.data);
}

/** A user-facing message for a failed callable (HttpsError messages are written for users). */
export function callableErrorMessage(error: unknown): string {
  const code = errorCode(error);
  if (code === 'functions/deadline-exceeded') {
    return 'This is taking longer than usual. The result will appear here when it finishes.';
  }
  if (code?.startsWith('functions/') && code !== 'functions/internal' && error instanceof Error) {
    return error.message;
  }
  return 'Something went wrong. Try again.';
}

async function commitFactWrite(factId: string, write: FactWrite): Promise<void> {
  const { db } = await getFirebase();
  const batch = writeBatch(db);
  batch.update(doc(db, PATHS.fact(factId)), write.update);
  batch.set(doc(db, PATHS.factVersion(factId, write.version)), {
    snapshot: write.snapshot,
    change: write.change,
    at: serverTimestamp(),
  });
  await withRetry(() => withTimeout(batch.commit(), WRITE_TIMEOUT_MS, 'fact write'), {
    label: 'profile.fact_write',
    // A committed-but-timed-out batch must not be sent twice: only retry clear rejections.
    isRetryable: (error) => errorCode(error) === 'unavailable',
  });
}

export function updateFact(view: FactView, patch: FactPatch): Promise<void> {
  return commitFactWrite(view.id, buildFactWrite(view.raw, patch, 'edit', serverTimestamp()));
}

export function archiveFact(view: FactView): Promise<void> {
  return commitFactWrite(
    view.id,
    buildFactWrite(view.raw, { status: 'archived' }, 'archive', serverTimestamp()),
  );
}

export function unarchiveFact(view: FactView): Promise<void> {
  return commitFactWrite(
    view.id,
    buildFactWrite(view.raw, { status: 'active' }, 'unarchive', serverTimestamp()),
  );
}

export function acceptReview(view: FactView): Promise<void> {
  return commitFactWrite(view.id, buildAcceptReview(view.raw, serverTimestamp()));
}

export function keepReview(view: FactView): Promise<void> {
  return commitFactWrite(view.id, buildKeepReview(view.raw, serverTimestamp()));
}

/** Messages for failed edits. `permission-denied` usually means the fact changed elsewhere. */
export function writeErrorMessage(error: unknown): string {
  if (errorCode(error) === 'permission-denied') {
    return 'This fact changed since you opened it. Reload and try again.';
  }
  return "Couldn't save. Check your connection and try again.";
}
