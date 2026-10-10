import {
  ApplicationInputSchema,
  ApplicationResultSchema,
  ApplicationSchema,
  clientTimeoutMs,
  COLLECTIONS,
  CvDocSchema,
  PATHS,
  type Application,
  type ApplicationInput,
  type ApplicationResult,
  type ApplicationStage,
  type CvDoc,
  type CvFileFormat,
  type CvFileKind,
  type QuerySpec,
} from '@hireframe/shared';
import {
  collection,
  doc,
  getCountFromServer,
  getDoc,
  limit,
  onSnapshot,
  query,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';

import { summarySpecs } from './dashboard';
import { getFirebase, getFunctionsClient, getStorageClient } from './firebase';
import { errorCode, logError } from './log';
import { listen, type LiveState, type Unsubscribe } from './profile';
import { specConstraints } from './query-spec';
import { isTransient, withRetry, withTimeout } from './resilience';
import { timestampsToDates } from './timestamps';

/**
 * Application pipeline services (M7 7D.3, PRD R10). Components use these, never Firebase.
 * - Reads are zod-parsed; an invalid document is skipped and counted.
 * - Every stage move goes through the `application` callable (zod in and out, never retried:
 *   a repeated `answer` could cost a second model call). The client writes nothing here.
 * - Files are read from Storage on demand, by the paths the `cvs/{cvId}` document records.
 */

/** The stages Pipeline shows, in order. Withdrawn is hidden. */
export const PIPELINE_STAGES = [
  'chosen',
  'needs_input',
  'generating',
  'ready',
  'applied',
] as const satisfies readonly ApplicationStage[];
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** Applications read per stage; a section shows "20+" when it is full. */
export const STAGE_PAGE_SIZE = 20;
const READ_TIMEOUT_MS = 15_000;

// ---- Queries (each is checked against firestore.indexes.json in indexes.test.ts) ----

/** One stage, newest move first. Served by the composite `(stage, stageAt desc)`. */
export function stageSpec(stage: PipelineStage): QuerySpec {
  return {
    collection: COLLECTIONS.applications,
    filters: [{ field: 'stage', op: '==', value: stage }],
    orderBy: [{ field: 'stageAt', direction: 'desc' }],
  };
}

export interface ApplicationView {
  id: string;
  application: Application;
}

/** One stage's applications, live. */
export function watchStage(
  stage: PipelineStage,
  callback: (state: LiveState<ApplicationView[]>) => void,
): Unsubscribe {
  callback({ status: 'loading' });
  return listen(
    async () => {
      const { db } = await getFirebase();
      return onSnapshot(
        query(
          collection(db, COLLECTIONS.applications),
          ...specConstraints(stageSpec(stage)),
          limit(STAGE_PAGE_SIZE),
        ),
        (snapshot) => {
          const views: ApplicationView[] = [];
          let invalid = 0;
          for (const item of snapshot.docs) {
            const parsed = ApplicationSchema.safeParse(timestampsToDates(item.data()));
            if (parsed.success) views.push({ id: item.id, application: parsed.data });
            else invalid++;
          }
          if (invalid > 0) logError('applications.invalid', { count: invalid, stage });
          callback({ status: 'ready', data: views, invalid });
        },
        (error) => {
          logError('applications.stage_failed', { code: error.code, stage });
          callback({ status: 'error', message: "Couldn't load these applications." });
        },
      );
    },
    (message) => {
      callback({ status: 'error', message });
    },
  );
}

/** One job's application, live: null when there is none. A document read, so no index. */
export function watchApplication(
  jobId: string,
  callback: (state: LiveState<Application | null>) => void,
): Unsubscribe {
  callback({ status: 'loading' });
  return listen(
    async () => {
      const { db } = await getFirebase();
      return onSnapshot(
        doc(db, PATHS.application(jobId)),
        (snapshot) => {
          if (!snapshot.exists()) {
            callback({ status: 'ready', data: null, invalid: 0 });
            return;
          }
          const parsed = ApplicationSchema.safeParse(timestampsToDates(snapshot.data()));
          if (parsed.success) {
            callback({ status: 'ready', data: parsed.data, invalid: 0 });
          } else {
            logError('applications.invalid', { count: 1 });
            callback({ status: 'error', message: "This application's data couldn't be read." });
          }
        },
        (error) => {
          logError('applications.job_failed', { code: error.code });
          callback({ status: 'error', message: "Couldn't load this application." });
        },
      );
    },
    (message) => {
      callback({ status: 'error', message });
    },
  );
}

/**
 * Applied this week, from the jobs the owner marked applied (the same count Today's bar uses).
 * The application's own `stageAt` is not the applied time: the mirror leaves it alone.
 */
export async function loadAppliedThisWeek(now: Date): Promise<number> {
  const { db } = await getFirebase();
  const spec = summarySpecs(now).appliedThisWeek;
  const snapshot = await withRetry(
    () =>
      withTimeout(
        getCountFromServer(query(collection(db, spec.collection), ...specConstraints(spec))),
        READ_TIMEOUT_MS,
        'applied this week',
      ),
    { label: 'applications.applied_week', isRetryable: isTransient },
  );
  return snapshot.data().count;
}

// ---- The callable ----

/**
 * One call to `application`. The input is checked here first and the result parsed on the way
 * back. Never retried: the owner sees the failure and decides.
 */
async function callApplication(input: ApplicationInput): Promise<ApplicationResult> {
  const parsed = ApplicationInputSchema.parse(input);
  const functions = await getFunctionsClient();
  const call = httpsCallable(functions, 'application', {
    timeout: clientTimeoutMs('application'),
    limitedUseAppCheckTokens: true,
  });
  const result = await call(parsed);
  return ApplicationResultSchema.parse(result.data);
}

export function startApplication(jobId: string): Promise<ApplicationResult> {
  return callApplication({ action: 'start', jobId });
}

export function answerQuestion(
  jobId: string,
  questionId: string,
  text: string,
): Promise<ApplicationResult> {
  return callApplication({ action: 'answer', jobId, questionId, text });
}

export function skipQuestion(jobId: string, questionId: string): Promise<ApplicationResult> {
  return callApplication({ action: 'skip', jobId, questionId });
}

export function skipAllQuestions(jobId: string): Promise<ApplicationResult> {
  return callApplication({ action: 'skipAll', jobId });
}

export function retryApplication(jobId: string): Promise<ApplicationResult> {
  return callApplication({ action: 'retry', jobId });
}

/** Notes are optional; blank notes are left out so an earlier note is cleared, not kept as ''. */
export function regenerateApplication(jobId: string, notes: string): Promise<ApplicationResult> {
  const trimmed = notes.trim();
  return callApplication({
    action: 'regenerate',
    jobId,
    ...(trimmed ? { notes: trimmed } : {}),
  });
}

export function withdrawApplication(
  jobId: string,
  deleteFiles: boolean,
): Promise<ApplicationResult> {
  return callApplication({ action: 'withdraw', jobId, deleteFiles });
}

/** A user-facing message for a failed `application` call. */
export function applicationErrorMessage(error: unknown): string {
  const code = errorCode(error);
  switch (code) {
    case 'functions/not-found':
      return 'That application no longer exists. Reload the page.';
    case 'functions/aborted':
      return 'This application changed while you were working. Reload and try again.';
    case 'functions/resource-exhausted':
      return "Today's application budget or this month's cap is used up. Try again later.";
    case 'functions/unavailable':
      return "The model's answer couldn't be used. Try again.";
    case 'functions/deadline-exceeded':
      return 'This is taking longer than usual. The card updates when it finishes.';
    case 'functions/failed-precondition':
    case 'functions/invalid-argument':
      // The server words these for the owner ("Couldn't turn that into a fact: rephrase it or skip").
      return error instanceof Error && error.message
        ? error.message
        : "That can't be done from where this application is.";
    default:
      return 'Something went wrong. Check your connection and try again.';
  }
}

// ---- Files ----

const FILE_KIND_NAMES: Readonly<Record<CvFileKind, string>> = {
  cv: 'CV',
  'cover-note': 'Cover note',
};

/** Characters a file name can't hold on common systems, plus control characters. */
// eslint-disable-next-line no-control-regex
const UNSAFE_FILE_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

function cleanPart(text: string): string {
  return text.replace(UNSAFE_FILE_CHARS, '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

/** `<header.name> - CV - <company>.pdf`; a missing part is left out rather than guessed. */
export function cvFileName(
  headerName: string | undefined,
  kind: CvFileKind,
  company: string,
  format: CvFileFormat,
): string {
  const parts = [cleanPart(headerName ?? ''), FILE_KIND_NAMES[kind], cleanPart(company)].filter(
    (part) => part !== '',
  );
  return `${parts.join(' - ')}.${format}`;
}

function storagePathFor(cv: CvDoc, kind: CvFileKind, format: CvFileFormat): string {
  const { storagePaths } = cv;
  if (kind === 'cv') return format === 'pdf' ? storagePaths.cvPdf : storagePaths.cvDocx;
  return format === 'pdf' ? storagePaths.notePdf : storagePaths.noteDocx;
}

/** The `cvs/{cvId}` document, zod-parsed; null when it doesn't exist. */
export async function loadCvDoc(cvId: string): Promise<CvDoc | null> {
  const { db } = await getFirebase();
  const snapshot = await withRetry(
    () => withTimeout(getDoc(doc(db, PATHS.cv(cvId))), READ_TIMEOUT_MS, 'cv doc'),
    { label: 'applications.cv_doc', isRetryable: isTransient },
  );
  if (!snapshot.exists()) return null;
  return CvDocSchema.parse(timestampsToDates(snapshot.data()));
}

export interface CvFile {
  blob: Blob;
  fileName: string;
}

/**
 * One of a version's four files. The Storage path comes from the `cvs` document, not from the
 * file name pattern, so a rename of the layout can't point at someone else's folder.
 */
export async function downloadCvFile(request: {
  cvId: string;
  kind: CvFileKind;
  format: CvFileFormat;
  headerName: string | undefined;
  company: string;
}): Promise<CvFile> {
  const cv = await loadCvDoc(request.cvId);
  if (!cv) throw Object.assign(new Error('CV version not found'), { code: 'not-found' });
  const [storage, sdk] = await Promise.all([getStorageClient(), import('firebase/storage')]);
  const blob = await withRetry(
    () =>
      withTimeout(
        sdk.getBlob(sdk.ref(storage, storagePathFor(cv, request.kind, request.format))),
        60_000,
        'cv download',
      ),
    { label: 'applications.download', isRetryable: isTransient },
  );
  return {
    blob,
    fileName: cvFileName(request.headerName, request.kind, request.company, request.format),
  };
}

/** A user-facing message for a failed download. */
export function downloadErrorMessage(error: unknown): string {
  return errorCode(error) === 'not-found' || errorCode(error) === 'storage/object-not-found'
    ? "That file isn't there any more. Regenerate the CV to make a new one."
    : "Couldn't download the file. Check your connection and try again.";
}
