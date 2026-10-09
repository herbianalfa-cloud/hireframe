import {
  applyTrim,
  trimOrder,
  type CvContent,
  type CvHeader,
  type TrimmedCvContent,
} from '@hireframe/shared';

import type { DateOf } from './layout.js';
import { renderCvPdf } from './pdf.js';

export type FitResult =
  | { ok: true; content: TrimmedCvContent; trimmed: number; bytes: Uint8Array }
  | { ok: false; code: 'too_long' };

/**
 * Renders the CV and, while the PDF runs past one page, applies the next `trimOrder` step.
 * Returns the content as rendered, how many steps it took (`trimmed` on the `cvs` doc) and the
 * PDF. Bounded by the number of steps, so it always ends. A CV that still doesn't fit after
 * every step is `too_long`; the content limits make that impossible (pinned by a test with the
 * maximum content).
 */
export async function fitOnePage(
  header: CvHeader,
  content: CvContent,
  dateOf: DateOf,
): Promise<FitResult> {
  const steps = trimOrder(content).length;
  for (let trimmed = 0; trimmed <= steps; trimmed += 1) {
    const candidate = applyTrim(content, trimmed);
    const { bytes, pages } = await renderCvPdf(header, candidate, dateOf);
    if (pages === 1) return { ok: true, content: candidate, trimmed, bytes };
  }
  return { ok: false, code: 'too_long' };
}
