import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { saveBlob } from '@/lib/download';
import { downloadCvFile } from '@/services/applications';
import { TimeoutError } from '@/services/resilience';

import { ApplicationCard } from './ApplicationCard';
import { makeApplication } from './fixtures';

// Firebase and pdf.js are faked at their edges; the component, the preview service and the
// download read run for real.
vi.mock('@/services/applications', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  downloadCvFile: vi.fn(),
}));
vi.mock('@/lib/download', () => ({ saveBlob: vi.fn() }));
const pdf = vi.hoisted(() => ({
  loadViewer: vi.fn(),
  openPdf: vi.fn(),
  closePdf: vi.fn(),
  renderPage: vi.fn(),
  pageText: vi.fn(),
}));
vi.mock('@/lib/pdf-preview', () => pdf);

const file = { blob: new Blob(['%PDF-1.7']), fileName: 'Alex Example - CV - Acme Analytics.pdf' };
const readyView = (cvId = 'job5-v1') =>
  makeApplication('job5', { stage: 'ready', cvIds: [cvId], currentCvId: cvId });

function show(view = readyView(), stage: 'ready' | 'chosen' = 'ready') {
  return render(
    <MemoryRouter>
      <ul>
        <ApplicationCard view={view} stage={stage} headerName="Alex Example" />
      </ul>
    </MemoryRouter>,
  );
}

const document_ = (numPages: number) => ({ numPages, id: `doc-${String(numPages)}` });

beforeEach(() => {
  for (const fn of Object.values(pdf)) fn.mockReset();
  vi.mocked(downloadCvFile).mockReset().mockResolvedValue(file);
  vi.mocked(saveBlob).mockReset();
  pdf.loadViewer.mockResolvedValue({});
  pdf.openPdf.mockResolvedValue(document_(1));
  pdf.closePdf.mockResolvedValue(undefined);
  pdf.renderPage.mockReturnValue({ promise: Promise.resolve(), cancel: vi.fn() });
  pdf.pageText.mockResolvedValue(['Alex Example', 'Data Analyst']);
});

const previewButton = () => screen.getByRole('button', { name: 'Preview CV' });

describe('Preview CV button', () => {
  it('shows on a Ready card with a current version, outside the Downloads list', () => {
    show();
    expect(previewButton()).toBeDefined();
    const downloads = within(screen.getByRole('list', { name: 'Downloads' }));
    expect(downloads.queryByRole('button', { name: 'Preview CV' })).toBeNull();
  });

  it('is absent without a current version, and on other stages', () => {
    show(makeApplication('job6', { stage: 'ready', cvIds: [] }));
    expect(screen.queryByRole('button', { name: 'Preview CV' })).toBeNull();
    expect(screen.getByText(/no CV version recorded/)).toBeDefined();
    show(makeApplication('job7', { stage: 'chosen' }), 'chosen');
    expect(screen.queryByRole('button', { name: 'Preview CV' })).toBeNull();
  });

  it.each([['{Enter}'], [' ']])('opens the dialog with the key %j', async (key) => {
    const user = userEvent.setup();
    show();
    previewButton().focus();
    await user.keyboard(key);
    expect(await screen.findByRole('dialog', { name: 'CV preview' })).toBeDefined();
  });
});

describe('the preview dialog', () => {
  it('announces loading, then labels the page and offers the text', async () => {
    const user = userEvent.setup();
    let release: (value: typeof file) => void = () => undefined;
    vi.mocked(downloadCvFile).mockReturnValue(new Promise((resolve) => (release = resolve)));
    show();
    await user.click(previewButton());
    expect(screen.getByRole('status', { name: 'Loading the preview' })).toBeDefined();
    release(file);
    const page = await screen.findByRole('img', { name: 'CV page 1 of 1' });
    expect(page.tagName).toBe('CANVAS');
    expect(screen.queryByText(/pages\. A CV should fit on one/)).toBeNull();
    expect(screen.getByText('Data Analyst')).toBeDefined();
    expect(screen.getByLabelText('CV preview pages').tabIndex).toBe(0);
    expect(downloadCvFile).toHaveBeenCalledExactlyOnceWith({
      cvId: 'job5-v1',
      kind: 'cv',
      format: 'pdf',
      headerName: 'Alex Example',
      company: 'Acme Analytics',
    });
  });

  it('flags a CV over one page and draws no more than the page cap', async () => {
    const user = userEvent.setup();
    pdf.openPdf.mockResolvedValue(document_(50));
    show();
    await user.click(previewButton());
    expect(await screen.findByText(/This PDF has 50 pages\. A CV should fit on one/)).toBeDefined();
    expect(screen.getAllByRole('img')).toHaveLength(3);
    expect(screen.getByRole('img', { name: 'CV page 3 of 50' })).toBeDefined();
  });

  it('says so when the PDF has no pages', async () => {
    const user = userEvent.setup();
    pdf.openPdf.mockResolvedValue(document_(0));
    show();
    await user.click(previewButton());
    expect(await screen.findByText('This PDF has no pages. Regenerate the CV.')).toBeDefined();
  });

  it('draws at the zoom chosen and holds the limits', async () => {
    const user = userEvent.setup();
    show();
    await user.click(previewButton());
    await screen.findByRole('img');
    const out = screen.getByRole('button', { name: 'Zoom out' });
    const zoomIn = screen.getByRole('button', { name: 'Zoom in' });
    await user.click(out);
    expect(screen.getByText('75%')).toBeDefined();
    expect(out.hasAttribute('disabled')).toBe(true);
    for (let i = 0; i < 4; i += 1) await user.click(zoomIn);
    expect(screen.getByText('175%')).toBeDefined();
    await user.click(zoomIn);
    expect(screen.getByText('200%')).toBeDefined();
    expect(zoomIn.hasAttribute('disabled')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Fit' }));
    expect(screen.getByText('100%')).toBeDefined();
    const widths = pdf.renderPage.mock.calls.map((call: unknown[]) => call[3] as number);
    expect(new Set(widths).size).toBeGreaterThan(3);
  });

  it('saves the fetched blob with the download button, with no second read', async () => {
    const user = userEvent.setup();
    show();
    await user.click(previewButton());
    await screen.findByRole('img');
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Download PDF' }),
    );
    expect(saveBlob).toHaveBeenCalledExactlyOnceWith(file.blob, file.fileName);
    expect(downloadCvFile).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape and returns focus to the button; reopening does not read again', async () => {
    const user = userEvent.setup();
    show();
    await user.click(previewButton());
    await screen.findByRole('img');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(document.activeElement).toBe(previewButton());
    expect(pdf.closePdf).toHaveBeenCalledTimes(1);
    await user.click(previewButton());
    await screen.findByRole('img');
    expect(downloadCvFile).toHaveBeenCalledTimes(1);
    expect(pdf.openPdf).toHaveBeenCalledTimes(2);
  });

  it('reads again for a new version', async () => {
    const user = userEvent.setup();
    const { rerender } = show(readyView('job5-v1'));
    await user.click(previewButton());
    await screen.findByRole('img');
    await user.keyboard('{Escape}');
    rerender(
      <MemoryRouter>
        <ul>
          <ApplicationCard view={readyView('job5-v2')} stage="ready" headerName="Alex Example" />
        </ul>
      </MemoryRouter>,
    );
    await user.click(previewButton());
    await screen.findByRole('img');
    expect(vi.mocked(downloadCvFile).mock.calls.map(([request]) => request.cvId)).toEqual([
      'job5-v1',
      'job5-v2',
    ]);
  });
});

describe('failures', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('shows the read errors with Try again, which reads again, and no Download PDF in the body', async () => {
    const user = userEvent.setup();
    vi.mocked(downloadCvFile).mockRejectedValueOnce(new TimeoutError('cv download timed out'));
    show();
    await user.click(previewButton());
    expect((await screen.findByRole('alert')).textContent).toBe(
      "Couldn't load the preview. Try again later.",
    );
    const body = within(screen.getByLabelText('CV preview pages'));
    expect(body.queryByRole('button', { name: 'Download PDF' })).toBeNull();
    await user.click(body.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('img');
    expect(downloadCvFile).toHaveBeenCalledTimes(2);
  });

  it('shows the not-found wording of the download error', async () => {
    const user = userEvent.setup();
    vi.mocked(downloadCvFile).mockRejectedValue(
      Object.assign(new Error('gone'), { code: 'storage/object-not-found' }),
    );
    show();
    await user.click(previewButton());
    expect((await screen.findByRole('alert')).textContent).toBe(
      "That file isn't there any more. Regenerate the CV to make a new one.",
    );
  });

  // The fallback for anything the viewer does: the import, the open or the draw throws, and the
  // owner can still save the file. No browser sniffing is involved.
  it.each([
    [
      'the viewer chunk fails to load',
      () => pdf.loadViewer.mockRejectedValue(new TypeError('import failed')),
      /load the viewer/,
    ],
    [
      'the PDF will not open',
      () => pdf.openPdf.mockRejectedValue(new Error('Invalid PDF')),
      /couldn't be shown here/,
    ],
    [
      'a page will not draw',
      () =>
        pdf.renderPage.mockImplementation(() => ({
          promise: Promise.reject(new Error('canvas')),
          cancel: vi.fn(),
        })),
      /couldn't be shown here/,
    ],
  ] as const)('falls back to Download PDF when %s', async (_name, arrange, message) => {
    const user = userEvent.setup();
    arrange();
    show();
    await user.click(previewButton());
    expect((await screen.findByRole('alert')).textContent).toMatch(message);
    const body = within(screen.getByLabelText('CV preview pages'));
    await user.click(body.getByRole('button', { name: 'Download PDF' }));
    expect(saveBlob).toHaveBeenCalledExactlyOnceWith(file.blob, file.fileName);
  });
});

describe('boundaries', () => {
  it('never reaches Firebase from the component', async () => {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync('web/src/features/pipeline/CvPreview.tsx', 'utf8');
    expect(text).not.toMatch(/from 'firebase|getFirebase|firebase\//);
  });
});
