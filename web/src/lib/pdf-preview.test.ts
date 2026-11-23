import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TimeoutError } from '@/services/resilience';

import {
  closePdf,
  fontBaseUrl,
  loadViewer,
  MAX_BITMAP_WIDTH,
  openPdf,
  pageText,
  renderPage,
  type PDFDocumentProxy,
} from './pdf-preview';

// pdf.js is faked: these tests are about how the adapter calls it, not about drawing.
const mock = vi.hoisted(() => ({
  options: { workerSrc: '' },
  getDocument: vi.fn(),
  destroy: vi.fn(() => Promise.resolve()),
  imports: 0,
}));

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => {
  mock.imports += 1;
  return {
    version: '9.9.9',
    GlobalWorkerOptions: mock.options,
    getDocument: mock.getDocument,
  };
});
vi.mock('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url', () => ({
  default: '/assets/pdf.worker.min-abc.mjs',
}));

beforeEach(() => {
  mock.getDocument.mockReset();
  mock.destroy.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('loadViewer / openPdf', () => {
  it('imports pdf.js once and sets the same-origin worker once', async () => {
    await loadViewer();
    await loadViewer();
    expect(mock.imports).toBe(1);
    expect(mock.options.workerSrc).toBe('/assets/pdf.worker.min-abc.mjs');
  });

  it('opens with our own fonts, no system fonts, no XFA and no WASM', async () => {
    mock.getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: 1 }),
      destroy: mock.destroy,
    });
    const bytes = new Uint8Array([1, 2, 3]);
    await openPdf(bytes, 1000);
    expect(mock.getDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        data: bytes,
        useSystemFonts: false,
        enableXfa: false,
        useWasm: false,
        standardFontDataUrl: fontBaseUrl('9.9.9'),
      }),
    );
    expect(fontBaseUrl('9.9.9')).toMatch(/\/assets\/pdfjs-9\.9\.9\/standard_fonts\/$/);
  });

  it('destroys the task and rejects when the open passes the deadline', async () => {
    vi.useFakeTimers();
    mock.getDocument.mockReturnValue({
      promise: new Promise(() => undefined),
      destroy: mock.destroy,
    });
    const opening = openPdf(new Uint8Array(), 15_000);
    const failed = expect(opening).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(15_000);
    await failed;
    expect(mock.destroy).toHaveBeenCalledOnce();
  });

  it('destroys the task and rethrows when the PDF is bad', async () => {
    mock.getDocument.mockReturnValue({
      promise: Promise.reject(new Error('Invalid PDF structure')),
      destroy: mock.destroy,
    });
    await expect(openPdf(new Uint8Array(), 1000)).rejects.toThrow('Invalid PDF structure');
    expect(mock.destroy).toHaveBeenCalledOnce();
  });
});

// What ships is `pdf.worker.min.mjs` (the `?url` import), so that is the file scanned.
describe('the pinned pdf.js worker', () => {
  const dir = 'node_modules/pdfjs-dist';
  const worker = readFileSync(`${dir}/legacy/build/pdf.worker.min.mjs`, 'utf8');

  it('is exactly the reviewed version (a bump is deliberate: ADR-065)', () => {
    const { version } = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8')) as {
      version: string;
    };
    expect(version).toBe('6.4.299');
    const wanted = JSON.parse(readFileSync('web/package.json', 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(wanted.dependencies['pdfjs-dist']).toBe('6.4.299');
  });

  it('has no way to run text from a PDF as code (eval is off by version)', () => {
    // `Function(`, with or without `new`, `eval(` in any spelling, `(0, eval)` and `["eval"]`.
    const dynamicCode =
      /(?<![\w$.])Function\s*\(|\.Function\s*\(|\beval\s*\(|\(\s*0\s*,\s*eval\s*\)|\[\s*["'`]eval["'`]\s*\]|\[\s*["'`]Function["'`]\s*\]/g;
    // The one allowed use is webpack's constant global lookup, which no PDF input reaches.
    const shim = 'Function("return this")()';
    const hits = [...worker.matchAll(dynamicCode)].filter(
      (hit) => !worker.slice(hit.index, hit.index + shim.length).startsWith(shim),
    );
    expect(hits.map((hit) => worker.slice(hit.index - 30, hit.index + 50))).toEqual([]);
    expect(worker).toContain(shim);
  });

  it('keeps WebAssembly to the two known compile sites, which the options leave unreachable', () => {
    // The ICC/image decoders' glue needs a `wasmUrl` we never set; the PostScript function
    // compiler is the one a PDF drives, and `useWasm: false` (tested above) turns it off.
    // Streaming compile is never used.
    expect(worker.match(/new WebAssembly\.Module\(/g)).toHaveLength(2);
    expect(worker).not.toMatch(
      /WebAssembly\s*\.\s*(compile|compileStreaming|instantiateStreaming)\b/,
    );
    expect(worker.match(/WebAssembly\s*\.\s*instantiate\b/g)).toHaveLength(1);
  });
});

function fakePage(width: number, height: number, render: () => Promise<void>) {
  const cancel = vi.fn();
  return {
    getViewport: ({ scale }: { scale: number }) => ({
      width: width * scale,
      height: height * scale,
    }),
    render: vi.fn(() => ({ promise: render(), cancel })),
    cleanup: vi.fn(),
    cancel,
    getTextContent: () =>
      Promise.resolve({
        items: [
          { str: 'Jane', hasEOL: false },
          { str: ' Doe', hasEOL: true },
          { str: 'Analyst', hasEOL: true },
          { type: 'beginMarkedContent' },
          { str: 'tail', hasEOL: false },
        ],
      }),
  };
}

const docWith = (page: ReturnType<typeof fakePage>) =>
  ({
    getPage: () => Promise.resolve(page),
    loadingTask: { destroy: mock.destroy },
  }) as unknown as PDFDocumentProxy;

describe('renderPage', () => {
  it('caps the bitmap at 2,000 px wide whatever the width or pixel ratio', async () => {
    vi.stubGlobal('devicePixelRatio', 3);
    const page = fakePage(595, 842, () => Promise.resolve());
    const canvas = document.createElement('canvas');
    await renderPage(docWith(page), 1, canvas, 4000, 1000).promise;
    expect(canvas.width).toBe(MAX_BITMAP_WIDTH);
    expect(canvas.style.width).toBe('4000px');
    expect(page.cleanup).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('cancels the task and rejects when the render passes the deadline', async () => {
    vi.useFakeTimers();
    const page = fakePage(595, 842, () => new Promise(() => undefined));
    const render = renderPage(docWith(page), 1, document.createElement('canvas'), 600, 15_000);
    const failed = expect(render.promise).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(15_000);
    await failed;
    expect(page.cancel).toHaveBeenCalledOnce();
  });

  it('a render cancelled before its page arrives never touches the canvas', async () => {
    let arrive: (page: ReturnType<typeof fakePage>) => void = () => undefined;
    const page = fakePage(595, 842, () => Promise.resolve());
    const doc = {
      getPage: () => new Promise((resolve) => (arrive = resolve)),
    } as unknown as PDFDocumentProxy;
    const canvas = document.createElement('canvas');
    canvas.width = 11;
    const render = renderPage(doc, 1, canvas, 600, 15_000);
    render.cancel();
    arrive(page);
    await render.promise;
    expect(canvas.width).toBe(11);
    expect(page.render).not.toHaveBeenCalled();
    expect(page.cleanup).toHaveBeenCalled();
  });

  it('a timeout while waiting for the page stops the run before it draws', async () => {
    vi.useFakeTimers();
    let arrive: (page: ReturnType<typeof fakePage>) => void = () => undefined;
    const page = fakePage(595, 842, () => Promise.resolve());
    const doc = {
      getPage: () => new Promise((resolve) => (arrive = resolve)),
    } as unknown as PDFDocumentProxy;
    const canvas = document.createElement('canvas');
    const render = renderPage(doc, 1, canvas, 600, 15_000);
    const failed = expect(render.promise).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(15_000);
    await failed;
    arrive(page);
    await vi.advanceTimersByTimeAsync(0);
    expect(page.render).not.toHaveBeenCalled();
    expect(canvas.width).toBe(300);
  });

  it('cancel() stops a render in progress', async () => {
    const page = fakePage(595, 842, () => new Promise(() => undefined));
    const render = renderPage(docWith(page), 1, document.createElement('canvas'), 600, 15_000);
    await vi.waitFor(() => {
      expect(page.render).toHaveBeenCalled();
    });
    render.cancel();
    expect(page.cancel).toHaveBeenCalledOnce();
  });
});

describe('pageText / closePdf', () => {
  it('builds lines from hasEOL and skips items without text', async () => {
    const page = fakePage(595, 842, () => Promise.resolve());
    expect(await pageText(docWith(page), 1)).toEqual(['Jane Doe', 'Analyst', 'tail']);
  });

  it('destroys the document through its loading task', async () => {
    await closePdf(docWith(fakePage(1, 1, () => Promise.resolve())));
    expect(mock.destroy).toHaveBeenCalledOnce();
  });
});
