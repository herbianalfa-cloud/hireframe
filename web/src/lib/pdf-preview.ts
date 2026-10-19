import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type * as Pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';

import { TimeoutError, withTimeout } from '@/services/resilience';

/**
 * A thin adapter over pdf.js for the CV preview (ADR-065). The legacy build is the one that
 * runs on the documented floor (Chrome 125+, Safari 18+). It is imported on first use, so the
 * initial JS never contains it (`check:bundle` fails if it does). The worker and the standard
 * fonts are same-origin assets; no feature detection or user-agent sniffing: if the import, the
 * open or the render throws, the caller shows its fallback.
 */
export type { PDFDocumentProxy };

/** The bitmap is never wider than this: about 5.6 M pixels, under iOS's 16.7 M canvas limit. */
export const MAX_BITMAP_WIDTH = 2000;
/** Device pixel ratios above this only cost memory. */
const MAX_PIXEL_RATIO = 2;

type Viewer = typeof Pdfjs;
let viewer: Promise<Viewer> | undefined;

/** Where the standard fonts are served: a versioned folder, so a new pdf.js can't read old files. */
export function fontBaseUrl(version: string): string {
  return `${import.meta.env.BASE_URL}assets/pdfjs-${version}/standard_fonts/`;
}

/** Loads pdf.js once and points it at its same-origin worker. A failed import can be retried. */
export function loadViewer(): Promise<Viewer> {
  viewer ??= (async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    return pdfjs;
  })().catch((error: unknown) => {
    viewer = undefined;
    throw error;
  });
  return viewer;
}

/**
 * Opens a PDF held in memory. pdf.js 6 has no eval path left (CVE-2024-4367 was the font one;
 * `pdf-preview.test.ts` checks the pinned worker for it), the fonts come from our own
 * `standard_fonts` folder (fetched one file at a time, only when the PDF names that font) and
 * the page does no scripting or XFA. Rejects with a `TimeoutError` after `limitMs`.
 */
export async function openPdf(bytes: Uint8Array, limitMs: number): Promise<PDFDocumentProxy> {
  const pdfjs = await loadViewer();
  const task = pdfjs.getDocument({
    data: bytes,
    useSystemFonts: false,
    enableXfa: false,
    standardFontDataUrl: fontBaseUrl(pdfjs.version),
  });
  try {
    return await withTimeout(task.promise, limitMs, 'pdf open');
  } catch (error) {
    await task.destroy();
    throw error;
  }
}

export interface PageRender {
  promise: Promise<void>;
  cancel: () => void;
}

/**
 * Draws one page into `canvas` at `cssWidth` CSS pixels. The bitmap is capped at
 * `MAX_BITMAP_WIDTH`; the render is cancelled and rejects with a `TimeoutError` after `limitMs`.
 */
export function renderPage(
  doc: PDFDocumentProxy,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  cssWidth: number,
  limitMs: number,
): PageRender {
  let cancelled = false;
  let cancelTask: (() => void) | undefined;
  const run = async () => {
    const page = await doc.getPage(pageNumber);
    try {
      const natural = page.getViewport({ scale: 1 }).width;
      const ratio = Math.min(globalThis.devicePixelRatio || 1, MAX_PIXEL_RATIO);
      const scale = Math.min((cssWidth * ratio) / natural, MAX_BITMAP_WIDTH / natural);
      const viewport = page.getViewport({ scale });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${String(cssWidth)}px`;
      canvas.style.aspectRatio = `${String(viewport.width)} / ${String(viewport.height)}`;
      if (cancelled) return;
      const task = page.render({ canvas, viewport });
      cancelTask = () => {
        task.cancel();
      };
      await task.promise;
    } finally {
      page.cleanup();
    }
  };
  const promise = withTimeout(run(), limitMs, 'pdf render').catch((error: unknown) => {
    if (error instanceof TimeoutError) cancelTask?.();
    throw error;
  });
  return {
    promise,
    cancel: () => {
      cancelled = true;
      cancelTask?.();
    },
  };
}

/** The page's own text as lines (a new line wherever pdf.js reports an end of line). */
export async function pageText(doc: PDFDocumentProxy, pageNumber: number): Promise<string[]> {
  const page = await doc.getPage(pageNumber);
  try {
    const content = await page.getTextContent();
    const lines: string[] = [];
    let line = '';
    for (const item of content.items) {
      if (!('str' in item)) continue;
      line += item.str;
      if (item.hasEOL) {
        lines.push(line);
        line = '';
      }
    }
    if (line !== '') lines.push(line);
    return lines;
  } finally {
    page.cleanup();
  }
}

/** Frees the document and its worker. Safe to call twice. */
export async function closePdf(doc: PDFDocumentProxy): Promise<void> {
  await doc.loadingTask.destroy();
}
