import type { CvHeader, TrimmedCvContent } from '@hireframe/shared';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

import {
  CONTENT_WIDTH,
  PAGE,
  cvBlocks,
  layoutBlocks,
  noteBlocks,
  type Block,
  type DateOf,
} from './layout.js';

/**
 * PDF output (ADR-054): pdf-lib, A4, one column, the standard Helvetica (no font files), real
 * text only: no images, no tables. Wrapping is ours (`layoutBlocks` with Helvetica's own
 * widths), so the page count is exact. Same bytes in, same bytes out: no dates are written.
 */

export interface RenderedPdf {
  bytes: Uint8Array;
  pages: number;
}

async function renderBlocksPdf(blocks: readonly Block[], title: string): Promise<RenderedPdf> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontOf = (isBold: boolean) => (isBold ? bold : regular);

  const { lines, pages } = layoutBlocks(blocks, (text, isBold, size) =>
    fontOf(isBold).widthOfTextAtSize(text, size),
  );

  doc.setTitle(title);
  doc.setProducer('Hireframe');
  doc.setCreator('Hireframe');
  const sheets = Array.from({ length: pages }, () => doc.addPage([PAGE.width, PAGE.height]));

  for (const line of lines) {
    const sheet = sheets[line.page];
    if (sheet === undefined) continue;
    const font = fontOf(line.bold);
    const baseline = PAGE.height - PAGE.margin - line.top - (line.leading + line.size * 0.7) / 2;
    if (line.bullet === true) {
      sheet.drawText('•', {
        x: PAGE.margin + 2,
        y: baseline,
        size: line.size,
        font: regular,
      });
    }
    sheet.drawText(line.text, { x: PAGE.margin + line.x, y: baseline, size: line.size, font });
    if (line.dates !== undefined) {
      const { text, page, top, leading, size } = line.dates;
      const width = regular.widthOfTextAtSize(text, size);
      sheets[page]?.drawText(text, {
        x: PAGE.margin + CONTENT_WIDTH - width,
        y: PAGE.height - PAGE.margin - top - (leading + size * 0.7) / 2,
        size,
        font: regular,
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
): Promise<RenderedPdf> {
  return await renderBlocksPdf(cvBlocks(header, content, dateOf), `${header.name} CV`);
}

export async function renderNotePdf(
  header: CvHeader,
  note: TrimmedCvContent['coverNote'],
): Promise<RenderedPdf> {
  return await renderBlocksPdf(noteBlocks(header, note), `${header.name} cover note`);
}
