import { MAX_CV_BYTES } from '@hireframe/shared';

import { openPdf, loadViewer, type PDFDocumentProxy } from '@/lib/pdf-preview';

import { downloadCvFile, downloadErrorMessage, type CvFile } from './applications';
import { errorCode, logError } from './log';
import { TimeoutError } from './resilience';

/** The biggest PDF the preview parses (mirrors the CV upload cap); ours are a few tens of kB. */
export const PREVIEW_MAX_BYTES = MAX_CV_BYTES;
/** Pages drawn. The CV rule is one page, so a second page is shown only to flag it. */
export const PREVIEW_MAX_PAGES = 3;
/** The deadline for opening the PDF and for drawing each page. */
export const PREVIEW_RENDER_LIMIT_MS = 15_000;

export type PreviewStep = 'fetch' | 'size' | 'viewer' | 'open' | 'render';

/** A preview failure that knows which step failed, so the message and the log can say so. */
export class PreviewError extends Error {
  override name = 'PreviewError';
  constructor(
    readonly step: PreviewStep,
    override readonly cause: unknown,
  ) {
    super(`cv preview failed at ${step}`);
  }
}

/** A step's failure, or the same error if it already is one. */
export function atStep(step: PreviewStep, error: unknown): PreviewError {
  return error instanceof PreviewError ? error : new PreviewError(step, error);
}

/**
 * The stored CV PDF of a version: the same read as the Download PDF button, one `cvs` document
 * and one Storage GET within the 30 s download limit, no model call and no re-render.
 */
export async function loadCvPreview(request: {
  cvId: string;
  headerName: string | undefined;
  company: string;
}): Promise<CvFile> {
  let file: CvFile;
  try {
    file = await downloadCvFile({ ...request, kind: 'cv', format: 'pdf' });
  } catch (error) {
    throw new PreviewError('fetch', error);
  }
  return file;
}

/**
 * Loads pdf.js (once) and opens the blob. A blob over `PREVIEW_MAX_BYTES` is refused before
 * anything parses it; the caller still holds the file, so it can be saved. Pages beyond
 * `PREVIEW_MAX_PAGES` are never drawn.
 */
export async function openCvPreview(blob: Blob): Promise<PDFDocumentProxy> {
  if (blob.size > PREVIEW_MAX_BYTES) throw new PreviewError('size', undefined);
  try {
    await loadViewer();
  } catch (error) {
    throw new PreviewError('viewer', error);
  }
  try {
    return await openPdf(new Uint8Array(await blob.arrayBuffer()), PREVIEW_RENDER_LIMIT_MS);
  } catch (error) {
    throw new PreviewError('open', error);
  }
}

/** A user-facing message for a failed preview. */
export function previewErrorMessage(error: unknown): string {
  const failure = atStep('fetch', error);
  switch (failure.step) {
    case 'fetch': {
      const code = errorCode(failure.cause);
      if (code === 'not-found' || code === 'storage/object-not-found') {
        return downloadErrorMessage(failure.cause);
      }
      if (failure.cause instanceof TimeoutError || code === 'storage/retry-limit-exceeded') {
        return "Couldn't load the preview. Try again later.";
      }
      return "Couldn't load the preview. Check your connection and try again.";
    }
    case 'size':
      return 'This PDF is too large to show here. Download it instead.';
    case 'viewer':
      return "Couldn't load the viewer. Check your connection and try again, or download the PDF instead.";
    case 'open':
    case 'render':
      return "This PDF couldn't be shown here. Download it instead.";
  }
}

/** One structured line: scalars only, never any CV text. */
export function logPreviewError(error: unknown): void {
  const failure = atStep('fetch', error);
  const cause = failure.cause;
  logError('cv_preview.failed', {
    step: failure.step,
    code: errorCode(cause) ?? (cause instanceof Error ? cause.name : 'unknown'),
  });
}
