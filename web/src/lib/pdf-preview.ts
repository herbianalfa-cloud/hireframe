import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type * as Pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';

import { TimeoutError, withTimeout } from './timeout';

/**
 * A thin adapter over pdf.js for the CV preview (ADR-065). The legacy build is used because
 * the default one needs newer JS than the app targets; it is tested on Chrome 125+ and Safari 18+. It is imported on first use, so the
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
 * Opens a PDF held in memory. No PDF-driven code generation: eval is off by the pinned version
 * (6.4.299 has no `isEvalSupported`; CVE-2024-4367 was the font eval, and `pdf-preview.test.ts`
 * scans the shipped worker for the patterns) and WASM is off by option (`useWasm: false`). The
 * fonts come from our own `standard_fonts` folder (one file at a time, only when the PDF names
 * that font) and there is no scripting or XFA. Rejects with a `TimeoutError` after `limitMs`.
 */
export async function openPdf(bytes: Uint8Array, limitMs: number): Promise<PDFDocumentProxy> {
  const pdfjs = await loadViewer();
  const task = pdfjs.getDocument({
    data: bytes,
    useSystemFonts: false,
    enableXfa: false,
    standardFontDataUrl: fontBaseUrl(pdfjs.version),
    // No WASM: a PDF's Type 4 functions would otherwise be compiled to WebAssembly at run time.
    useWasm: false,
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
      // A cancelled run must not touch the canvas: resizing clears it, and a newer run may own it.
      if (cancelled) return;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${String(cssWidth)}px`;
      canvas.style.aspectRatio = `${String(viewport.width)} / ${String(viewport.height)}`;
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
    if (error instanceof TimeoutError) {
      // Also stops a run still waiting for its page, which has no task to cancel yet.
      cancelled = true;
      cancelTask?.();
    }
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
