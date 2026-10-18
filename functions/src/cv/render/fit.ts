import {
  applyTrim,
  trimOrder,
  type CvContent,
  type CvHeader,
  type TrimmedCvContent,
} from '@hireframe/shared';

import {
  BODY_SIZES,
  USABLE_HEIGHT,
  baseSpec,
  cvBlocks,
  layoutBlocks,
  resolveStyles,
  spreadSpec,
  type Block,
  type DateOf,
  type LayoutResult,
  type LayoutSpec,
  type Measure,
} from './layout.js';
import { makePdfMeasure, renderCvPdf } from './pdf.js';

/** Points kept free at the bottom after the gaps are spread: covers Word's rounding (M6). */
export const FILL_RESERVE = 10;
/** Halving steps of the search for how far to spread. */
const SPREAD_STEPS = 8;

/** What the layout measured, for the quality score. */
export interface FitLines {
  /** Rendered lines per bullet, in document order (Experience, then Projects). */
  bullets: number[];
  /** Entry headings that need more than one line. */
  headingWraps: number;
}

export type FitResult =
  | {
      ok: true;
      content: TrimmedCvContent;
      /** `trimOrder` steps applied. */
      trimmed: number;
      spec: LayoutSpec;
      /** Used height ÷ usable height, after the spacing is spread. */
      fill: number;
      bytes: Uint8Array;
      lines: FitLines;
    }
  | { ok: false; code: 'too_long' };

/** Memoises the font measure: the same words are laid out at every trim step. */
function cached(measure: Measure): Measure {
  const widths = new Map<string, number>();
  return (text, bold, size) => {
    const key = `${bold ? 'b' : 'r'}|${String(size)}|${text}`;
    let width = widths.get(key);
    if (width === undefined) {
      width = measure(text, bold, size);
      widths.set(key, width);
    }
    return width;
  };
}

function linesOf(blocks: readonly Block[], layout: LayoutResult): FitLines {
  return {
    bullets: blocks.flatMap((item, i) =>
      item.kind === 'bullet' ? [layout.blockLines[i] ?? 1] : [],
    ),
    headingWraps: layout.headingWraps,
  };
}

/**
 * Fits the CV on one page and fills it (ADR-062). It measures with Helvetica's widths and
 * renders the PDF once, at the end.
 *   1. For 0, 1, 2… `trimOrder` steps, try each body size (`BODY_SIZES`, biggest first) and take
 *      the first that is one page: fewer cuts win over a bigger font.
 *   2. Spread the leftover height over the section, entry and bullet gaps (each at most ×1.6)
 *      and the leading (at most +6%), keeping `FILL_RESERVE` points free. A bisection of
 *      `SPREAD_STEPS` halvings finds how far.
 * Spacing is rounded to 1/20 pt before the layout, so the PDF and the DOCX use the same
 * numbers. A CV that is still over a page after every step is `too_long`, and that is a real
 * outcome: headings and education are never trimmed, so at the limits of the schema, in wide
 * letters, they alone run past one page (pinned by a test with `wideCv()`). Ordinary words at
 * the same limits do fit once trimmed (`maxCv()`). Bounded by (steps + 1) × 3 body sizes, then 9 spread layouts and one final render.
 */
export async function fitPage(
  header: CvHeader,
  content: CvContent,
  dateOf: DateOf,
): Promise<FitResult> {
  const measure = cached(await makePdfMeasure());
  const layoutAt = (blocks: readonly Block[], spec: LayoutSpec) =>
    layoutBlocks(blocks, measure, resolveStyles(spec));
  const roomy = (layout: LayoutResult) =>
    layout.pages === 1 && layout.usedHeight <= USABLE_HEIGHT - FILL_RESERVE;

  const steps = trimOrder(content).length;
  for (let trimmed = 0; trimmed <= steps; trimmed += 1) {
    const candidate = applyTrim(content, trimmed);
    const blocks = cvBlocks(header, candidate, dateOf);
    for (const size of BODY_SIZES) {
      const base = baseSpec(size);
      let best = { spec: base, layout: layoutAt(blocks, base) };
      if (best.layout.pages !== 1) continue;

      const widest = spreadSpec(base, 1);
      const widestLayout = layoutAt(blocks, widest);
      if (roomy(widestLayout)) {
        best = { spec: widest, layout: widestLayout };
      } else {
        let low = 0;
        let high = 1;
        for (let step = 0; step < SPREAD_STEPS; step += 1) {
          const middle = (low + high) / 2;
          const spec = spreadSpec(base, middle);
          const layout = layoutAt(blocks, spec);
          if (roomy(layout)) {
            best = { spec, layout };
            low = middle;
          } else {
            high = middle;
          }
        }
      }

      const pdf = await renderCvPdf(header, candidate, dateOf, best.spec);
      // The same layout, from the same widths: a second page here would be a bug, not a result.
      if (pdf.pages !== 1) continue;
      return {
        ok: true,
        content: candidate,
        trimmed,
        spec: best.spec,
        fill: best.layout.usedHeight / USABLE_HEIGHT,
        bytes: pdf.bytes,
        lines: linesOf(blocks, best.layout),
      };
    }
  }
  return { ok: false, code: 'too_long' };
}
