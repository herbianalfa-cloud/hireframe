import type { CvHeader, TrimmedCvContent } from '@hireframe/shared';
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  LevelFormat,
  LineRuleType,
  Packer,
  Paragraph,
  Tab,
  TabStopType,
  TextRun,
} from 'docx';

import {
  BASE_SPEC,
  BULLET_INDENT,
  CONTENT_WIDTH,
  PAGE,
  RULE_SIZE,
  RULE_SPACE,
  cvBlocks,
  noteBlocks,
  resolveStyles,
  type Block,
  type BlockKind,
  type BlockStyle,
  type DateOf,
  type LayoutSpec,
} from './layout.js';

/**
 * DOCX output (ADR-054, ADR-062): the same blocks and spacing as the PDF, in Arial (metric-
 * compatible with Helvetica), with the numbers of the same `LayoutSpec` in twips. ATS-safe: real
 * headings, real bullets (a numbering definition), and no tables, text boxes, images, headers or
 * footers. An entry's dates sit on a right tab stop, after the last word of its title. The
 * library's built-in Title and Heading styles are blue, so they are overridden: black, Arial,
 * our sizes, kept with the next paragraph.
 */

const FONT = 'Arial';
const TWIP = 20;
const BULLETS = 'hireframe-bullets';
const BLACK = '000000';

type Styles = Readonly<Record<BlockKind, BlockStyle>>;

const HEADINGS: Partial<Record<Block['kind'], (typeof HeadingLevel)[keyof typeof HeadingLevel]>> = {
  name: HeadingLevel.TITLE,
  section: HeadingLevel.HEADING_1,
  entry: HeadingLevel.HEADING_2,
};

const twips = (points: number) => Math.round(points * TWIP);

function spacing(style: BlockStyle) {
  return {
    before: twips(style.before),
    after: twips(style.after),
    line: twips(style.leading),
    lineRule: LineRuleType.EXACT,
  };
}

function run(text: string, style: BlockStyle, bold: boolean): TextRun {
  return new TextRun({ text, font: FONT, size: Math.round(style.size * 2), bold, color: BLACK });
}

/** A real `<w:tab/>` element; a tab character in a run's text is not one (ADR-054). */
function tab(style: BlockStyle): TextRun {
  return new TextRun({
    children: [new Tab()],
    font: FONT,
    size: Math.round(style.size * 2),
    color: BLACK,
  });
}

function paragraph(item: Block, styles: Styles): Paragraph {
  const style = styles[item.kind];
  const heading = HEADINGS[item.kind];
  const base = {
    ...(heading === undefined ? {} : { heading }),
    ...(style.align === 'center' ? { alignment: AlignmentType.CENTER } : {}),
    spacing: spacing(style),
  };
  const runs = item.runs.map((part) => run(part.text, style, part.bold));
  if (item.kind === 'bullet') {
    return new Paragraph({ ...base, numbering: { reference: BULLETS, level: 0 }, children: runs });
  }
  if (item.dates !== undefined) {
    return new Paragraph({
      ...base,
      tabStops: [{ type: TabStopType.RIGHT, position: twips(CONTENT_WIDTH) }],
      children: [...runs, tab(style), run(item.dates, style, false)],
    });
  }
  return new Paragraph({
    ...base,
    ...(item.kind === 'section'
      ? { border: {
            bottom: {
              style: BorderStyle.SINGLE,
              size: RULE_SIZE * 8,
              space: RULE_SPACE,
              color: BLACK,
            },
          } }
      : {}),
    children: runs,
  });
}

/** The built-in styles the headings use, overridden to black Arial at our sizes. */
function headingStyle(style: BlockStyle, center: boolean) {
  return {
    run: { font: FONT, size: Math.round(style.size * 2), bold: true, color: BLACK },
    paragraph: {
      keepNext: true,
      keepLines: true,
      ...(center ? { alignment: AlignmentType.CENTER } : {}),
      spacing: spacing(style),
    },
  };
}

async function renderBlocksDocx(
  blocks: readonly Block[],
  title: string,
  spec: LayoutSpec,
): Promise<Uint8Array> {
  const styles = resolveStyles(spec);
  const margin = twips(PAGE.margin);
  const doc = new Document({
    creator: 'Hireframe',
    title,
    styles: {
      default: {
        document: { run: { font: FONT, size: Math.round(styles.text.size * 2), color: BLACK } },
        title: headingStyle(styles.name, true),
        heading1: headingStyle(styles.section, false),
        heading2: headingStyle(styles.entry, false),
        // Unused, but the library's blue would show in Word's style pane and on any edit.
        heading3: headingStyle(styles.entry, false),
        heading4: headingStyle(styles.entry, false),
        heading5: headingStyle(styles.entry, false),
        heading6: headingStyle(styles.entry, false),
        hyperlink: { run: { color: BLACK } },
      },
    },
    numbering: {
      config: [
        {
          reference: BULLETS,
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: '•',
              alignment: AlignmentType.LEFT,
              style: {
                paragraph: {
                  indent: { left: twips(BULLET_INDENT), hanging: twips(BULLET_INDENT) },
                },
              },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: twips(PAGE.width), height: twips(PAGE.height) },
            margin: { top: margin, bottom: margin, left: margin, right: margin },
          },
        },
        children: blocks.map((item) => paragraph(item, styles)),
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}

export async function renderCvDocx(
  header: CvHeader,
  content: TrimmedCvContent,
  dateOf: DateOf,
  spec: LayoutSpec = BASE_SPEC,
): Promise<Uint8Array> {
  return await renderBlocksDocx(cvBlocks(header, content, dateOf), `${header.name} CV`, spec);
}

export async function renderNoteDocx(
  header: CvHeader,
  note: TrimmedCvContent['coverNote'],
): Promise<Uint8Array> {
  return await renderBlocksDocx(noteBlocks(header, note), `${header.name} cover note`, BASE_SPEC);
}
