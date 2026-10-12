import { STORAGE_PATHS, type CvFileFormat, type CvFileKind } from '@hireframe/shared';
import type { Storage } from 'firebase-admin/storage';

/**
 * The four files of one generated CV (M7 7D.2), at `cvs/{cvId}/{cv|cover-note}.{pdf|docx}`. The
 * path is built here from the `cvId` the worker derived from the job's own ID, never from
 * client input. A failed write is retried at most `ATTEMPTS` times with backoff.
 */
export interface CvFileBytes {
  cvPdf: Uint8Array;
  cvDocx: Uint8Array;
  notePdf: Uint8Array;
  noteDocx: Uint8Array;
}

export interface CvFileStore {
  /** Uploads the four files, overwriting what an earlier attempt left. */
  put(cvId: string, files: CvFileBytes): Promise<void>;
  /** Best-effort delete of the four files of a CV that was never recorded. */
  remove(cvId: string): Promise<void>;
}

const CONTENT_TYPES: Readonly<Record<CvFileFormat, string>> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const ATTEMPTS = 3;
const BACKOFF_MS = 500;

export const cvFilePaths = (cvId: string) => ({
  cvPdf: STORAGE_PATHS.cvFile(cvId, 'cv', 'pdf'),
  cvDocx: STORAGE_PATHS.cvFile(cvId, 'cv', 'docx'),
  notePdf: STORAGE_PATHS.cvFile(cvId, 'cover-note', 'pdf'),
  noteDocx: STORAGE_PATHS.cvFile(cvId, 'cover-note', 'docx'),
});

export type CvFilePaths = ReturnType<typeof cvFilePaths>;

const FORMATS: Record<keyof CvFileBytes, { kind: CvFileKind; format: CvFileFormat }> = {
  cvPdf: { kind: 'cv', format: 'pdf' },
  cvDocx: { kind: 'cv', format: 'docx' },
  notePdf: { kind: 'cover-note', format: 'pdf' },
  noteDocx: { kind: 'cover-note', format: 'docx' },
};

export function bucketCvFiles(
  bucket: ReturnType<Storage['bucket']>,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
): CvFileStore {
  async function save(path: string, bytes: Uint8Array, contentType: string): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await bucket.file(path).save(Buffer.from(bytes), { contentType, resumable: false });
        return;
      } catch (error) {
        if (attempt >= ATTEMPTS) throw error;
        await sleep(BACKOFF_MS * 2 ** (attempt - 1));
      }
    }
  }

  return {
    async put(cvId, files) {
      const paths = cvFilePaths(cvId);
      for (const key of Object.keys(FORMATS) as (keyof CvFileBytes)[]) {
        await save(paths[key], files[key], CONTENT_TYPES[FORMATS[key].format]);
      }
    },
    async remove(cvId) {
      for (const path of Object.values(cvFilePaths(cvId))) {
        await bucket.file(path).delete({ ignoreNotFound: true });
      }
    },
  };
}
