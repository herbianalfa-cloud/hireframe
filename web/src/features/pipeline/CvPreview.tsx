import { Download, Eye, Minus, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { saveBlob } from '@/lib/download';
import { closePdf, pageText, renderPage, type PDFDocumentProxy } from '@/lib/pdf-preview';
import type { CvFile } from '@/services/applications';
import {
  atStep,
  loadCvPreview,
  logPreviewError,
  openCvPreview,
  PREVIEW_MAX_PAGES,
  PREVIEW_RENDER_LIMIT_MS,
  previewErrorMessage,
} from '@/services/cv-preview';

const ZOOM_STEPS = [75, 100, 125, 150, 175, 200] as const;
/** Used when the scroll area has no width yet (first paint). */
const FALLBACK_WIDTH = 600;

type Loaded =
  | { status: 'loading' }
  | { status: 'ready'; doc: PDFDocumentProxy; pages: number; lines: string[] }
  | { status: 'error'; message: string; canSave: boolean };

/**
 * Preview of the stored CV PDF before it is downloaded (ADR-065). The PDF is the same file the
 * Download PDF button saves, drawn by pdf.js on canvases. If anything in the viewer throws, the
 * owner gets a message and a Download PDF button; nothing else in the app is affected.
 */
export function CvPreview({
  cvId,
  headerName,
  company,
}: {
  cvId: string;
  headerName: string | undefined;
  company: string;
}) {
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [zoom, setZoom] = useState<(typeof ZOOM_STEPS)[number]>(100);
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvases = useRef<(HTMLCanvasElement | null)[]>([]);
  // The fetched file is kept per version while the card is mounted: reopening doesn't read
  // again, and a new version (a new cvId) does.
  const [fetched, setFetched] = useState<{ cvId: string; file: CvFile }>();

  const stored = fetched?.cvId === cvId ? fetched.file : undefined;

  // Read the file once per version. Closing and reopening, or Try again after a viewer error,
  // reuse it.
  useEffect(() => {
    if (!open || stored) return;
    const live = { current: true };
    loadCvPreview({ cvId, headerName, company }).then(
      (file) => {
        if (live.current) setFetched({ cvId, file });
      },
      (error: unknown) => {
        if (!live.current) return;
        logPreviewError(error);
        setLoaded({ status: 'error', message: previewErrorMessage(error), canSave: false });
      },
    );
    return () => {
      live.current = false;
    };
  }, [open, stored, cvId, headerName, company, attempt]);

  // Open the document and read its text. Closing destroys it.
  useEffect(() => {
    if (!open || !stored) return;
    const live = { current: true };
    const isLive = () => live.current;
    const held: { doc?: PDFDocumentProxy } = {};
    void (async () => {
      try {
        const opened = await openCvPreview(stored.blob);
        if (!isLive()) {
          // The dialog closed during the open: the cleanup ran before there was a document.
          void closePdf(opened);
          return;
        }
        held.doc = opened;
        const pages = Math.min(opened.numPages, PREVIEW_MAX_PAGES);
        const lines: string[] = [];
        for (let page = 1; page <= pages; page += 1) {
          try {
            lines.push(...(await pageText(opened, page)));
          } catch (error) {
            throw atStep('render', error);
          }
        }
        if (!isLive()) return;
        setLoaded({ status: 'ready', doc: opened, pages: opened.numPages, lines });
      } catch (error) {
        if (!isLive()) return;
        logPreviewError(error);
        setLoaded({ status: 'error', message: previewErrorMessage(error), canSave: true });
      }
    })();
    return () => {
      live.current = false;
      if (held.doc) void closePdf(held.doc);
    };
  }, [open, stored, attempt]);

  // Draw each page, one at a time, at the chosen zoom. A new zoom or a close cancels the draw.
  const doc = loaded.status === 'ready' ? loaded.doc : undefined;
  const pageCount = loaded.status === 'ready' ? Math.min(loaded.pages, PREVIEW_MAX_PAGES) : 0;
  useEffect(() => {
    if (!doc) return;
    const live = { current: true };
    const task: { cancel?: () => void } = {};
    const measured = scrollRef.current?.clientWidth ?? 0;
    const width = measured > 0 ? measured : FALLBACK_WIDTH;
    void (async () => {
      try {
        for (let page = 1; page <= pageCount; page += 1) {
          const canvas = canvases.current[page - 1];
          if (!canvas || !live.current) return;
          const render = renderPage(
            doc,
            page,
            canvas,
            Math.round(((width - 32) * zoom) / 100),
            PREVIEW_RENDER_LIMIT_MS,
          );
          task.cancel = render.cancel;
          await render.promise;
        }
      } catch (error) {
        if (!live.current) return;
        const failure = atStep('render', error);
        logPreviewError(failure);
        setLoaded({ status: 'error', message: previewErrorMessage(failure), canSave: true });
      }
    })();
    return () => {
      live.current = false;
      task.cancel?.();
    };
  }, [doc, pageCount, zoom]);

  const save = () => {
    if (stored) saveBlob(stored.blob, stored.fileName);
  };
  const step = ZOOM_STEPS.indexOf(zoom);
  const zoomable = loaded.status === 'ready' && pageCount > 0;

  return (
    <>
      <Button
        ref={buttonRef}
        variant="secondary"
        className="mt-3"
        onClick={() => {
          setOpen(true);
        }}
      >
        <Eye aria-hidden="true" />
        Preview CV
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setLoaded({ status: 'loading' });
        }}
      >
        <DialogContent
          className="inset-0 flex h-dvh max-h-none w-full max-w-none translate-x-0 translate-y-0 flex-col rounded-none md:inset-auto md:top-1/2 md:left-1/2 md:h-[90dvh] md:max-w-3xl md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-lg"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            buttonRef.current?.focus();
          }}
        >
          <DialogTitle>CV preview</DialogTitle>
          <DialogDescription>
            The stored PDF, as it will be sent. Download it to see it exactly as sent: fonts can
            differ slightly here.
          </DialogDescription>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="icon"
              aria-label="Zoom out"
              disabled={!zoomable || step <= 0}
              onClick={() => {
                setZoom(ZOOM_STEPS[Math.max(0, step - 1)] ?? 100);
              }}
            >
              <Minus aria-hidden="true" />
            </Button>
            <Button
              variant="secondary"
              disabled={!zoomable || zoom === 100}
              onClick={() => {
                setZoom(100);
              }}
            >
              Fit
            </Button>
            <Button
              variant="secondary"
              size="icon"
              aria-label="Zoom in"
              disabled={!zoomable || step >= ZOOM_STEPS.length - 1}
              onClick={() => {
                setZoom(ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, step + 1)] ?? 100);
              }}
            >
              <Plus aria-hidden="true" />
            </Button>
            <span aria-live="polite" className="text-sm text-muted-foreground tabular-nums">
              {String(zoom)}%
            </span>
            <Button className="ml-auto" variant="secondary" disabled={!stored} onClick={save}>
              <Download aria-hidden="true" />
              Download PDF
            </Button>
          </div>
          <div
            ref={scrollRef}
            role="region"
            tabIndex={0}
            aria-label="CV preview pages"
            className="mt-3 min-h-0 flex-1 overflow-auto rounded-md border bg-background p-4"
          >
            {loaded.status === 'loading' ? (
              <div role="status" aria-busy="true" aria-label="Loading the preview">
                <Skeleton className="mx-auto aspect-[1/1.414] w-full max-w-xl" />
                <span className="sr-only">Loading the preview…</span>
              </div>
            ) : null}
            {loaded.status === 'error' ? (
              <div>
                <p role="alert" className="text-sm text-danger">
                  {loaded.message}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setLoaded({ status: 'loading' });
                      setAttempt((count) => count + 1);
                    }}
                  >
                    Try again
                  </Button>
                  {loaded.canSave ? (
                    <Button onClick={save}>
                      <Download aria-hidden="true" />
                      Download PDF
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}
            {loaded.status === 'ready' && loaded.pages === 0 ? (
              <p role="alert" className="text-sm text-danger">
                This PDF has no pages. Regenerate the CV.
              </p>
            ) : null}
            {loaded.status === 'ready' && loaded.pages > 0 ? (
              <div>
                {loaded.pages > 1 ? (
                  <p role="status" className="mb-3 text-sm text-verdict-near-miss">
                    This PDF has {String(loaded.pages)} pages. A CV should fit on one.
                  </p>
                ) : null}
                <div className="flex flex-col items-center gap-4">
                  {Array.from({ length: pageCount }, (_unused, index) => (
                    <canvas
                      key={`${cvId}-${String(index)}`}
                      ref={(element) => {
                        canvases.current[index] = element;
                      }}
                      role="img"
                      aria-label={`CV page ${String(index + 1)} of ${String(loaded.pages)}`}
                      className="max-w-none border bg-white shadow-sm"
                    />
                  ))}
                </div>
                <details className="mt-4 text-sm">
                  <summary className="min-h-11 cursor-pointer py-2">Text of the CV</summary>
                  <div className="mt-1 space-y-1 text-muted-foreground">
                    {loaded.lines.map((line, index) => (
                      <p key={index}>{line}</p>
                    ))}
                  </div>
                </details>
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
