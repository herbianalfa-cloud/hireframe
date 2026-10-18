import type { CvHeader, TrimmedCvContent } from '@hireframe/shared';
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';

import {
  BASE_SPEC,
  CONTENT_WIDTH,
  PAGE,
  cvBlocks,
  layoutBlocks,
  noteBlocks,
  resolveStyles,
  type Block,
  type DateOf,
  type LayoutSpec,
  type Measure,
} from './layout.js';

/**
 * PDF output (ADR-054, ADR-062): pdf-lib, A4, one column, the standard Helvetica (no font files),
 * real text only: no images, no tables. Wrapping is ours (`layoutBlocks` with Helvetica's own
 * widths), so the page count is exact. Same bytes in, same bytes out: no dates are written.
 */

export interface RenderedPdf {
  bytes: Uint8Array;
  pages: number;
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

async function embedFonts(doc: PDFDocument): Promise<Fonts> {
  return {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
}

/** Helvetica's own widths, for the fit to lay out without rendering a PDF each time. */
export async function makePdfMeasure(): Promise<Measure> {
  const { regular, bold } = await embedFonts(await PDFDocument.create({ updateMetadata: false }));
  return (text, isBold, size) => (isBold ? bold : regular).widthOfTextAtSize(text, size);
}

async function renderBlocksPdf(
  blocks: readonly Block[],
  title: string,
  spec: LayoutSpec,
): Promise<RenderedPdf> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const fonts = await embedFonts(doc);
  const fontOf = (isBold: boolean) => (isBold ? fonts.bold : fonts.regular);

  const { lines, pages } = layoutBlocks(
    blocks,
    (text, isBold, size) => fontOf(isBold).widthOfTextAtSize(text, size),
    resolveStyles(spec),
  );

  doc.setTitle(title);
  doc.setProducer('Hireframe');
  doc.setCreator('Hireframe');
  const sheets = Array.from({ length: pages }, () => doc.addPage([PAGE.width, PAGE.height]));

  for (const line of lines) {
    const sheet = sheets[line.page];
    if (sheet === undefined) continue;
    const baseline = PAGE.height - PAGE.margin - line.top - (line.leading + line.size * 0.7) / 2;
    if (line.bullet === true) {
      sheet.drawText('•', {
        x: PAGE.margin + 2,
        y: baseline,
        size: line.size,
        font: fonts.regular,
      });
    }
    const widths = line.runs.map((run) => fontOf(run.bold).widthOfTextAtSize(run.text, line.size));
    const total = widths.reduce((sum, width) => sum + width, 0);
    let x = PAGE.margin + line.x;
    if (line.align === 'center') x = PAGE.margin + (CONTENT_WIDTH - total) / 2;
    line.runs.forEach((run, i) => {
      sheet.drawText(run.text, { x, y: baseline, size: line.size, font: fontOf(run.bold) });
      x += widths[i] ?? 0;
    });
    if (line.dates !== undefined) {
      const { text, size } = line.dates;
      sheet.drawText(text, {
        x: PAGE.margin + CONTENT_WIDTH - fonts.regular.widthOfTextAtSize(text, size),
        y: baseline,
        size,
        font: fonts.regular,
      });
    }
    if (line.rule === true) {
      const y = baseline - 3;
      sheet.drawLine({
        start: { x: PAGE.margin, y },
        end: { x: PAGE.margin + CONTENT_WIDTH, y },
        thickness: 0.5,
        color: rgb(0, 0, 0),
      });
    }
  }
  return { bytes: await doc.save({ useObjectStreams: false }), pages };
}

export async function renderCvPdf(
  header: CvHeader,
  content: TrimmedCvContent,
  dateOf: DateOf,
  spec: LayoutSpec = BASE_SPEC,
): Promise<RenderedPdf> {
  return await renderBlocksPdf(cvBlocks(header, content, dateOf), `${header.name} CV`, spec);
}

export async function renderNotePdf(
  header: CvHeader,
  note: TrimmedCvContent['coverNote'],
): Promise<RenderedPdf> {
  return await renderBlocksPdf(noteBlocks(header, note), `${header.name} cover note`, BASE_SPEC);
}
