import {
  formatFactDates,
  isPrintable,
  type CvHeader,
  type FactContent,
  type TrimmedCvContent,
} from '@hireframe/shared';

/**
 * What a CV and a cover note look like, as data (ADR-054). `cvBlocks` and `noteBlocks` turn
 * content into a flat list of blocks; the PDF renderer lays them out with its own word-wrap and
 * the DOCX renderer maps each block to a paragraph with the same sizes and spacing, so both
 * files say the same thing in the same order. Nothing here does I/O.
 */

/** A4 with 15 mm margins, in points. */
export const PAGE = { width: 595.28, height: 841.89, margin: 42.52 } as const;
export const CONTENT_WIDTH = PAGE.width - 2 * PAGE.margin;
export const BULLET_INDENT = 12;
/** The gap kept between an entry's title and its right-aligned dates. */
export const DATES_GAP = 10;

export type BlockKind = 'name' | 'contact' | 'section' | 'entry' | 'bullet' | 'text' | 'note';

export interface Block {
  kind: BlockKind;
  text: string;
  /** Entry blocks only: right-aligned on the first line. */
  dates?: string;
}

export interface BlockStyle {
  size: number;
  bold: boolean;
  /** Line height, points. */
  leading: number;
  /** Space above and below, points (the space above is dropped at the top of a page). */
  before: number;
  after: number;
}

/** Helvetica in the PDF and Arial in the DOCX (metric-compatible); sizes in points. */
export const STYLES: Readonly<Record<BlockKind, BlockStyle>> = {
  name: { size: 18, bold: true, leading: 22, before: 0, after: 1 },
  contact: { size: 9.5, bold: false, leading: 12, before: 0, after: 2 },
  section: { size: 11, bold: true, leading: 14, before: 9, after: 3 },
  entry: { size: 10.5, bold: true, leading: 13, before: 4, after: 1 },
  bullet: { size: 10, bold: false, leading: 12.5, before: 0, after: 1.5 },
  text: { size: 10, bold: false, leading: 12.5, before: 0, after: 2 },
  note: { size: 10.5, bold: false, leading: 14, before: 0, after: 9 },
};

export type RenderErrorCode = 'unsupported_char';

/** A render that can't proceed. The validator catches model text; this catches the header. */
export class CvRenderError extends Error {
  readonly code: RenderErrorCode;

  constructor(code: RenderErrorCode) {
    super(`cv render refused: ${code}`);
    this.name = 'CvRenderError';
    this.code = code;
  }
}

/** A fact the renderer reads dates from. */
export interface DatedFact {
  id: string;
  dates: FactContent['dates'];
}

/** Dates for a citation (`F3`), from the cited fact and never from model text. */
export type DateOf = (factRef: string) => string;

/** `aliases` is alias → fact ID, as stored on the `cvs` doc. */
export function makeDateOf(
  aliases: ReadonlyMap<string, string>,
  facts: readonly DatedFact[],
): DateOf {
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  return (factRef) => {
    const id = aliases.get(factRef);
    const fact = id === undefined ? undefined : byId.get(id);
    return fact === undefined ? '' : formatFactDates(fact.dates);
  };
}

const CONTACT_SEPARATOR = '  |  ';

function headerBlocks(header: CvHeader): Block[] {
  const contact = [header.email, header.phone, header.location, ...(header.links ?? [])].filter(
    (part): part is string => part !== undefined,
  );
  return [
    { kind: 'name', text: header.name },
    { kind: 'contact', text: contact.join(CONTACT_SEPARATOR) },
  ];
}

function entry(title: string, dates: string): Block {
  return dates === '' ? { kind: 'entry', text: title } : { kind: 'entry', text: title, dates };
}

/** The CV, top to bottom. A section with nothing in it, or a trimmed-away summary, is left out. */
export function cvBlocks(header: CvHeader, content: TrimmedCvContent, dateOf: DateOf): Block[] {
  const blocks = headerBlocks(header);
  const section = (text: string) => blocks.push({ kind: 'section', text });

  if (content.summary !== null) {
    section('Summary');
    blocks.push({ kind: 'text', text: content.summary.text });
  }
  const entries = (title: string, list: TrimmedCvContent['experience']) => {
    if (list.length === 0) return;
    section(title);
    for (const item of list) {
      blocks.push(entry(`${item.heading.role}, ${item.heading.org}`, dateOf(item.heading.factRef)));
      for (const bullet of item.bullets) blocks.push({ kind: 'bullet', text: bullet.text });
    }
  };
  entries('Experience', content.experience);
  entries('Projects', content.projects);
  if (content.education.length > 0) {
    section('Education');
    for (const line of content.education) blocks.push(entry(line.line, dateOf(line.factRef)));
  }
  if (content.skills.length > 0) {
    section('Skills');
    blocks.push({ kind: 'text', text: content.skills.map((skill) => skill.label).join(', ') });
  }
  assertPrintable(blocks);
  return blocks;
}

/** The cover note: sender block, greeting, the model's paragraphs, sign-off. */
export function noteBlocks(header: CvHeader, note: TrimmedCvContent['coverNote']): Block[] {
  const blocks: Block[] = [
    ...headerBlocks(header),
    { kind: 'note', text: 'Dear hiring team,' },
    ...note.paragraphs.map((paragraph): Block => ({ kind: 'note', text: paragraph.text })),
    { kind: 'note', text: 'Yours sincerely,' },
    { kind: 'note', text: header.name },
  ];
  assertPrintable(blocks);
  return blocks;
}

/** Text the PDF fonts can't print is refused, in both formats, never dropped or swapped. */
function assertPrintable(blocks: readonly Block[]): void {
  for (const block of blocks) {
    if (!isPrintable(block.text) || !isPrintable(block.dates ?? '')) {
      throw new CvRenderError('unsupported_char');
    }
  }
}

// ---- Layout ----

export type Measure = (text: string, bold: boolean, size: number) => number;

export interface PlacedLine {
  page: number;
  /** Baseline's distance below the top margin, points. */
  top: number;
  /** Line box height, points. */
  leading: number;
  x: number;
  text: string;
  bold: boolean;
  size: number;
  /**
   * An entry's dates, right-aligned on the entry's first line. They hang off its last line so
   * the PDF draws them after the whole title, which keeps the reading order title-then-dates
   * when the title wraps.
   */
  dates?: { text: string; page: number; top: number; leading: number; size: number };
  /** A bullet glyph is drawn at the left of the line. */
  bullet?: boolean;
  /** A rule is drawn under the line (section headings). */
  rule?: boolean;
}

/** Greedy word-wrap; a word wider than the line is broken by character so nothing overflows. */
export function wrapText(
  text: string,
  width: number,
  fits: (candidate: string) => number,
): string[] {
  const lines: string[] = [];
  let line = '';
  const push = (word: string) => {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (fits(candidate) <= width) {
      line = candidate;
      return;
    }
    if (line !== '') lines.push(line);
    line = '';
    if (fits(word) <= width) {
      line = word;
      return;
    }
    let piece = '';
    for (const char of word) {
      if (piece !== '' && fits(piece + char) > width) {
        lines.push(piece);
        piece = '';
      }
      piece += char;
    }
    line = piece;
  };
  for (const word of text.split(/\s+/)) if (word !== '') push(word);
  if (line !== '' || lines.length === 0) lines.push(line);
  return lines;
}

/** The page height available for lines, points. */
export const USABLE_HEIGHT = PAGE.height - 2 * PAGE.margin;

/** Places every block on A4 pages. The page count is exact because the wrapping is ours. */
export function layoutBlocks(
  blocks: readonly Block[],
  measure: Measure,
): { lines: PlacedLine[]; pages: number } {
  const lines: PlacedLine[] = [];
  let page = 0;
  let y = 0;
  let pending = 0;

  for (const block of blocks) {
    const style = STYLES[block.kind];
    const isBullet = block.kind === 'bullet';
    const indent = isBullet ? BULLET_INDENT : 0;
    const datesWidth =
      block.dates === undefined ? 0 : measure(block.dates, style.bold, style.size) + DATES_GAP;
    const wrapped = wrapText(block.text, CONTENT_WIDTH - indent - datesWidth, (candidate) =>
      measure(candidate, style.bold, style.size),
    );

    y += Math.max(pending, style.before);
    wrapped.forEach((text, i) => {
      if (y + style.leading > USABLE_HEIGHT) {
        page += 1;
        y = 0;
      }
      const placed: PlacedLine = {
        page,
        top: y,
        leading: style.leading,
        x: indent,
        text,
        bold: style.bold,
        size: style.size,
      };
      if (i === 0 && isBullet) placed.bullet = true;
      if (block.kind === 'section') placed.rule = true;
      lines.push(placed);
      y += style.leading;
    });
    const first = lines[lines.length - wrapped.length];
    const last = lines[lines.length - 1];
    if (block.dates !== undefined && first !== undefined && last !== undefined) {
      last.dates = {
        text: block.dates,
        page: first.page,
        top: first.top,
        leading: first.leading,
        size: first.size,
      };
    }
    pending = style.after;
  }
  return { lines, pages: page + 1 };
}
