import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { downloadCvFile } from './applications';
import {
  loadCvPreview,
  logPreviewError,
  openCvPreview,
  PREVIEW_MAX_BYTES,
  PreviewError,
  previewErrorMessage,
} from './cv-preview';
import { TimeoutError } from './resilience';

vi.mock('./applications', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  downloadCvFile: vi.fn(),
}));
const viewer = vi.hoisted(() => ({
  loadViewer: vi.fn(),
  openPdf: vi.fn(),
  closePdf: vi.fn(),
}));
vi.mock('@/lib/pdf-preview', () => viewer);

const request = { cvId: 'job1-v2', headerName: 'Alex Example', company: 'Acme Ltd' };
const read = vi.mocked(downloadCvFile);

beforeEach(() => {
  read.mockReset();
  viewer.loadViewer.mockReset().mockResolvedValue({});
  viewer.openPdf.mockReset();
  viewer.closePdf.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadCvPreview', () => {
  it('asks for the CV PDF of this version, through the download read', async () => {
    const file = { blob: new Blob(['%PDF']), fileName: 'Alex Example CV - Acme Ltd.pdf' };
    read.mockResolvedValue(file);
    expect(await loadCvPreview(request)).toBe(file);
    expect(read).toHaveBeenCalledExactlyOnceWith({ ...request, kind: 'cv', format: 'pdf' });
  });

  it('refuses a file over the size cap before anything parses it', async () => {
    read.mockResolvedValue({
      blob: { size: PREVIEW_MAX_BYTES + 1 } as Blob,
      fileName: 'x.pdf',
    });
    const failure = await loadCvPreview(request).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PreviewError);
    expect(previewErrorMessage(failure)).toMatch(/too large.*Download it instead/);
    expect(viewer.openPdf).not.toHaveBeenCalled();
  });

  it('wraps a failed read with its step', async () => {
    read.mockRejectedValue(new TimeoutError('cv download timed out after 30000 ms'));
    const failure = await loadCvPreview(request).catch((error: unknown) => error);
    expect(failure).toMatchObject({ step: 'fetch' });
  });
});

describe('openCvPreview', () => {
  it('reports a viewer chunk that will not load', async () => {
    viewer.loadViewer.mockRejectedValue(
      new TypeError('Failed to fetch dynamically imported module'),
    );
    const failure = await openCvPreview(new Blob(['%PDF'])).catch((error: unknown) => error);
    expect(failure).toMatchObject({ step: 'viewer' });
    expect(previewErrorMessage(failure)).toMatch(/load the viewer/);
  });

  it('reports a PDF that will not open', async () => {
    viewer.openPdf.mockRejectedValue(new Error('Invalid PDF structure'));
    const failure = await openCvPreview(new Blob(['nope'])).catch((error: unknown) => error);
    expect(failure).toMatchObject({ step: 'open' });
    expect(previewErrorMessage(failure)).toBe(
      "This PDF couldn't be shown here. Download it instead.",
    );
  });
});

describe('previewErrorMessage', () => {
  const at = (cause: unknown) => previewErrorMessage(new PreviewError('fetch', cause));

  it('uses the download wording when the file is gone', () => {
    const expected = "That file isn't there any more. Regenerate the CV to make a new one.";
    expect(at(Object.assign(new Error('x'), { code: 'not-found' }))).toBe(expected);
    expect(at(Object.assign(new Error('x'), { code: 'storage/object-not-found' }))).toBe(expected);
  });

  it('maps the timeouts and anything else', () => {
    expect(at(new TimeoutError('t'))).toBe("Couldn't load the preview. Try again later.");
    expect(at(Object.assign(new Error('x'), { code: 'storage/retry-limit-exceeded' }))).toBe(
      "Couldn't load the preview. Try again later.",
    );
    expect(at(new Error('offline'))).toBe(
      "Couldn't load the preview. Check your connection and try again.",
    );
  });
});

describe('logPreviewError', () => {
  it('logs scalars only: the step and a code, never the message', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    logPreviewError(new PreviewError('open', new Error('Jane Doe, 12 Fake Street')));
    const line = String(spy.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toEqual({
      level: 'error',
      event: 'cv_preview.failed',
      step: 'open',
      code: 'Error',
    });
    expect(line).not.toContain('Jane');
  });
});
