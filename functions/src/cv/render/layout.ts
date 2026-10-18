import {
  factEndKey,
  formatEducationDates,
  formatFactDates,
  isPrintable,
  type CvHeader,
  type FactContent,
  type TrimmedCvContent,
} from '@hireframe/shared';

/**
 * What a CV and a cover note look like, as data (ADR-054, ADR-062). `cvBlocks` and `noteBlocks`
 * turn content into a flat list of blocks; `resolveStyles` turns a `LayoutSpec` into sizes and
 * spacing; the PDF renderer lays the blocks out with its own word-wrap and the DOCX renderer
 * maps each block to a paragraph with the same numbers, so both files say the same thing in the
 * same order. Nothing here does I/O.
 */

/** A4 with 15 mm margins, in points. */
export const PAGE = { width: 595.28, height: 841.89, margin: 42.52 } as const;
export const CONTENT_WIDTH = PAGE.width - 2 * PAGE.margin;
export const BULLET_INDENT = 12;
/** The gap kept between an entry's title and its right-aligned dates. */
export const DATES_GAP = 10;
/** The page height available for lines, points. */
export const USABLE_HEIGHT = PAGE.height - 2 * PAGE.margin;

/**
 * The PDF wraps this much narrower than the DOCX, which keeps the full width. Arial and
 * Helvetica have the same advance widths, so Word fits at least as many words on a line as the
 * PDF does, and one extra wrap in Word can't push the CV onto a second page.
 */
export const PDF_WRAP_SLACK = 0.015;
export const PDF_WRAP_WIDTH = CONTENT_WIDTH * (1 - PDF_WRAP_SLACK);

/** Recent-graduate order: what they studied comes before what they did. */
export const SECTION_ORDER = ['Summary', 'Education', 'Experience', 'Projects', 'Skills'] as const;
export type SectionName = (typeof SECTION_ORDER)[number];

export type BlockKind =
  'name' | 'contact' | 'section' | 'entry' | 'education' | 'bullet' | 'text' | 'note';

/** A stretch of text in one weight. An entry's role is bold and its organisation is regular. */
export interface Run {
  text: string;
  bold: boolean;
}

export interface Block {
  kind: BlockKind;
  /** All the runs' text, joined. */
  text: string;
  runs: Run[];
  /** Entry and education blocks: right-aligned, on the last line of the title. */
  dates?: string;
}

export interface BlockStyle {
  size: number;
  /** Line height, points. */
  leading: number;
  /** Space above and below, points (the space above is dropped at the top of a page). */
  before: number;
  after: number;
  align: 'left' | 'center';
}

// ---- The layout spec ----

/**
 * The knobs the fit turns (ADR-062). `bodySize` is the size of bullets and text; the other
 * sizes follow it. The scales stretch the gaps and the leading to fill the page.
 */
export interface LayoutSpec {
  bodySize: number;
  leadingScale: number;
  sectionGapScale: number;
  entryGapScale: number;
  bulletGapScale: number;
}

/** Body sizes the fit tries, biggest first. */
export const BODY_SIZES: readonly number[] = [11, 10.5, 10];
/** The most a gap may grow, and the most the leading may. */
export const SPREAD_CAPS = { gap: 1.6, leading: 1.06 } as const;

export function baseSpec(bodySize: number): LayoutSpec {
  return {
    bodySize,
    leadingScale: 1,
    sectionGapScale: 1,
    entryGapScale: 1,
    bulletGapScale: 1,
  };
}

export const BASE_SPEC: LayoutSpec = baseSpec(BODY_SIZES[BODY_SIZES.length - 1] ?? 10);

/** `base` with its gaps and leading stretched `amount` (0 to 1) of the way to the caps. */
export function spreadSpec(base: LayoutSpec, amount: number): LayoutSpec {
  const grow = (cap: number) => Number((1 + (cap - 1) * amount).toFixed(4));
  return {
    ...base,
    leadingScale: grow(SPREAD_CAPS.leading),
    sectionGapScale: grow(SPREAD_CAPS.gap),
    entryGapScale: grow(SPREAD_CAPS.gap),
    bulletGapScale: grow(SPREAD_CAPS.gap),
  };
}

/** Points rounded to 1/20 pt (a twip), so the PDF and the DOCX use the same numbers. */
export function toTwip(points: number): number {
  return Math.round(points * 20) / 20;
}

/** Helvetica in the PDF and Arial in the DOCX (metric-compatible); sizes in points. */
export function resolveStyles(spec: LayoutSpec): Readonly<Record<BlockKind, BlockStyle>> {
  const body = spec.bodySize;
  const lead = (size: number, ratio: number) => toTwip(size * ratio * spec.leadingScale);
  const sectionGap = (points: number) => toTwip(points * spec.sectionGapScale);
  const entryGap = (points: number) => toTwip(points * spec.entryGapScale);
  const bulletGap = (points: number) => toTwip(points * spec.bulletGapScale);
  return {
    name: { size: 18, leading: 22, before: 0, after: 3, align: 'center' },
    contact: {
      size: body - 0.5,
      leading: lead(body - 0.5, 1.25),
      before: 0,
      after: 2,
      align: 'center',
    },
    section: {
      size: body + 1,
      leading: lead(body + 1, 1.25),
      before: sectionGap(9),
      after: sectionGap(3),
      align: 'left',
    },
    entry: {
      size: body + 0.5,
      leading: lead(body + 0.5, 1.25),
      before: entryGap(4),
      after: 1,
      align: 'left',
    },
    education: {
      size: body,
      leading: lead(body, 1.25),
      before: entryGap(2),
      after: 1,
      align: 'left',
    },
    bullet: {
      size: body,
      leading: lead(body, 1.25),
      before: 0,
      after: bulletGap(1.5),
      align: 'left',
    },
    text: {
      size: body,
      leading: lead(body, 1.25),
      before: 0,
      after: bulletGap(2),
      align: 'left',
    },
    note: { size: 10.5, leading: 14, before: 0, after: 9, align: 'left' },
  };
}

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

// ---- Dates ----

/** A fact the renderer reads dates from. */
export interface DatedFact {
  id: string;
  dates: FactContent['dates'];
}

/**
 * Dates for a citation (`F3`), from the cited fact and never from model text. An education line
 * asks with `'education'` and gets the year only.
 */
export type DateOf = (factRef: string, section?: 'education') => string;

/** `aliases` is alias → fact ID, as stored on the `cvs` doc. */
export function makeDateOf(
  aliases: ReadonlyMap<string, string>,
  facts: readonly DatedFact[],
): DateOf {
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  return (factRef, section) => {
    const id = aliases.get(factRef);
    const fact = id === undefined ? undefined : byId.get(id);
    if (fact === undefined) return '';
    return section === 'education' ? formatEducationDates(fact.dates) : formatFactDates(fact.dates);
  };
}

/** Whether a citation's fact has an end date (`orderEntries` puts those education lines first). */
export function makeHasEndOf(
  aliases: ReadonlyMap<string, string>,
  facts: readonly DatedFact[],
): (factRef: string) => boolean {
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  return (factRef) => {
    const id = aliases.get(factRef);
    return id !== undefined && byId.get(id)?.dates.end !== undefined;
  };
}

/** The sort key for `orderEntries` (`factEndKey`) of a citation's fact. */
export function makeEndKeyOf(
  aliases: ReadonlyMap<string, string>,
  facts: readonly DatedFact[],
): (factRef: string) => string {
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  return (factRef) => {
    const id = aliases.get(factRef);
    return factEndKey(id === undefined ? undefined : byId.get(id)?.dates);
  };
}

// ---- Blocks ----

const CONTACT_SEPARATOR = '  |  ';

function block(kind: BlockKind, text: string, bold = false, dates = ''): Block {
  const made: Block = { kind, text, runs: [{ text, bold }] };
  if (dates !== '') made.dates = dates;
  return made;
}

function headerBlocks(header: CvHeader): Block[] {
  const contact = [header.email, header.phone, header.location, ...(header.links ?? [])].filter(
    (part): part is string => part !== undefined,
  );
  return [block('name', header.name, true), block('contact', contact.join(CONTACT_SEPARATOR))];
}

/** "**Role**, Org" on one line, with the dates to the right. A project may have no org. */
function entryBlock(role: string, org: string, dates: string): Block {
  const made: Block = {
    kind: 'entry',
    text: org === '' ? role : `${role}, ${org}`,
    runs: [{ text: role, bold: true }, ...(org === '' ? [] : [{ text: `, ${org}`, bold: false }])],
  };
  if (dates !== '') made.dates = dates;
  return made;
}

/**
 * The CV, top to bottom, in `SECTION_ORDER`. A section with nothing in it, or a trimmed-away
 * summary, is left out. Section titles are written in capitals.
 */
export function cvBlocks(header: CvHeader, content: TrimmedCvContent, dateOf: DateOf): Block[] {
  const blocks = headerBlocks(header);
  const section = (title: SectionName) => blocks.push(block('section', title.toUpperCase(), true));
  const entries = (title: 'Experience' | 'Projects', list: TrimmedCvContent['experience']) => {
    if (list.length === 0) return;
    section(title);
    for (const item of list) {
      const { role, org, factRef } = item.heading;
      blocks.push(entryBlock(role, org, dateOf(factRef)));
      for (const bullet of item.bullets) blocks.push(block('bullet', bullet.text));
    }
  };

  for (const title of SECTION_ORDER) {
    switch (title) {
      case 'Summary':
        if (content.summary !== null) {
          section(title);
          blocks.push(block('text', content.summary.text));
        }
        break;
      case 'Education':
        if (content.education.length > 0) {
          section(title);
          for (const line of content.education) {
            blocks.push(block('education', line.line, false, dateOf(line.factRef, 'education')));
          }
        }
        break;
      case 'Experience':
        entries(title, content.experience);
        break;
      case 'Projects':
        entries(title, content.projects);
        break;
      case 'Skills':
        if (content.skills.length > 0) {
          section(title);
          blocks.push(block('text', content.skills.map((skill) => skill.label).join(', ')));
        }
        break;
    }
  }
  assertPrintable(blocks);
  return blocks;
}

/** The cover note: sender block, greeting, the model's paragraphs, sign-off. */
export function noteBlocks(header: CvHeader, note: TrimmedCvContent['coverNote']): Block[] {
  const blocks: Block[] = [
    ...headerBlocks(header),
    block('note', 'Dear Hiring Team,'),
    ...note.paragraphs.map((paragraph) => block('note', paragraph.text)),
    block('note', 'Yours sincerely,'),
    block('note', header.name),
  ];
  assertPrintable(blocks);
  return blocks;
}

/** Text the PDF fonts can't print is refused, in both formats, never dropped or swapped. */
function assertPrintable(blocks: readonly Block[]): void {
  for (const item of blocks) {
    if (!isPrintable(item.text) || !isPrintable(item.dates ?? '')) {
      throw new CvRenderError('unsupported_char');
    }
  }
}

// ---- Layout ----

/** Width of `text` in points, in one weight. */
export type Measure = (text: string, bold: boolean, size: number) => number;

export interface PlacedLine {
  page: number;
  /** Top of the line box, points below the top margin. */
  top: number;
  /** Line box height, points. */
  leading: number;
  x: number;
  runs: Run[];
  size: number;
  align: 'left' | 'center';
  /** An entry's dates, right-aligned on this line: the last line of its title. */
  dates?: { text: string; size: number };
  /** A bullet glyph is drawn at the left of the line. */
  bullet?: boolean;
  /** A rule is drawn under the line (section headings). */
  rule?: boolean;
}

export const lineText = (runs: readonly Run[]): string => runs.map((run) => run.text).join('');

interface Piece {
  char: string;
  bold: boolean;
}

/** Appends `text` to `runs`, joining it to the last run when the weight is the same. */
function append(runs: Run[], text: string, bold: boolean): void {
  const last = runs[runs.length - 1];
  if (last?.bold === bold) last.text += text;
  else runs.push({ text, bold });
}

/**
 * Greedy word-wrap of mixed runs: words never split across a weight change, and a word wider
 * than the line is broken by character so nothing overflows. `measure(text, bold)` is the
 * width in points. An empty input is one empty line.
 */
export function wrapRuns(
  runs: readonly Run[],
  width: number,
  measure: (text: string, bold: boolean) => number,
): Run[][] {
  const words: Piece[][] = [[]];
  for (const run of runs) {
    for (const char of run.text) {
      if (/\s/.test(char)) {
        if ((words[words.length - 1]?.length ?? 0) > 0) words.push([]);
      } else {
        words[words.length - 1]?.push({ char, bold: run.bold });
      }
    }
  }
  const toRuns = (pieces: readonly Piece[]): Run[] => {
    const out: Run[] = [];
    for (const piece of pieces) append(out, piece.char, piece.bold);
    return out;
  };
  const widthOf = (parts: readonly Run[]) =>
    parts.reduce((total, part) => total + measure(part.text, part.bold), 0);
  const spaceWidth = measure(' ', false);

  const lines: Run[][] = [];
  let line: Run[] = [];
  let lineWidth = 0;
  const flush = () => {
    if (line.length > 0) lines.push(line);
    line = [];
    lineWidth = 0;
  };

  for (const word of words) {
    if (word.length === 0) continue;
    const parts = toRuns(word);
    const wordWidth = widthOf(parts);
    if (line.length > 0 && lineWidth + spaceWidth + wordWidth <= width) {
      // A space between two bold words is bold, so the pair stays one run.
      append(line, ' ', (line[line.length - 1]?.bold ?? false) && (parts[0]?.bold ?? false));
      for (const part of parts) append(line, part.text, part.bold);
      lineWidth += spaceWidth + wordWidth;
      continue;
    }
    flush();
    if (wordWidth <= width) {
      line = parts;
      lineWidth = wordWidth;
      continue;
    }
    let piece: Piece[] = [];
    for (const char of word) {
      if (piece.length > 0 && widthOf(toRuns([...piece, char])) > width) {
        lines.push(toRuns(piece));
        piece = [];
      }
      piece.push(char);
    }
    line = toRuns(piece);
    lineWidth = widthOf(line);
  }
  flush();
  return lines.length === 0 ? [[]] : lines;
}

export interface LayoutResult {
  lines: PlacedLine[];
  pages: number;
  /** Where the last line ends, points below the top margin (on the last page). */
  usedHeight: number;
  /** Rendered lines per block, in the order of `blocks`. */
  blockLines: number[];
  /** Entry headings whose role, organisation and dates need more than one line. */
  headingWraps: number;
}

/**
 * Places every block on A4 pages. The page count is exact because the wrapping is ours. Text
 * wraps at `wrapWidth`: the PDF's (`PDF_WRAP_WIDTH`) by default, and `CONTENT_WIDTH` for what
 * Word will do. An entry's dates go on the last line of its title, as a right tab places them
 * in Word; if they don't fit there they get a line of their own, right-aligned.
 */
export function layoutBlocks(
  blocks: readonly Block[],
  measure: Measure,
  styles: Readonly<Record<BlockKind, BlockStyle>> = resolveStyles(BASE_SPEC),
  wrapWidth: number = PDF_WRAP_WIDTH,
): LayoutResult {
  const lines: PlacedLine[] = [];
  const blockLines: number[] = [];
  let headingWraps = 0;
  let page = 0;
  let y = 0;
  let pending = 0;

  for (const item of blocks) {
    const style = styles[item.kind];
    const isBullet = item.kind === 'bullet';
    const indent = isBullet ? BULLET_INDENT : 0;
    const width = wrapWidth - indent;
    const widthOf = (parts: readonly Run[]) =>
      parts.reduce((total, part) => total + measure(part.text, part.bold, style.size), 0);

    const wrapped = wrapRuns(item.runs, width, (text, bold) => measure(text, bold, style.size));
    let dates: PlacedLine['dates'];
    if (item.dates !== undefined) {
      const datesWidth = measure(item.dates, false, style.size);
      const last = wrapped[wrapped.length - 1] ?? [];
      if (widthOf(last) + DATES_GAP + datesWidth > width) wrapped.push([]);
      dates = { text: item.dates, size: style.size };
    }
    if (item.kind === 'entry' && wrapped.length > 1) headingWraps += 1;

    y += Math.max(pending, style.before);
    wrapped.forEach((runs, i) => {
      if (y + style.leading > USABLE_HEIGHT) {
        page += 1;
        y = 0;
      }
      const placed: PlacedLine = {
        page,
        top: y,
        leading: style.leading,
        x: indent,
        runs,
        size: style.size,
        align: style.align,
      };
      if (i === 0 && isBullet) placed.bullet = true;
      if (item.kind === 'section') placed.rule = true;
      if (i === wrapped.length - 1 && dates !== undefined) placed.dates = dates;
      lines.push(placed);
      y += style.leading;
    });
    blockLines.push(wrapped.length);
    pending = style.after;
  }
  return { lines, pages: page + 1, usedHeight: y, blockLines, headingWraps };
}
