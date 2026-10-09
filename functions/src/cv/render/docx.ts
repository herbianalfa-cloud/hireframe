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
  TabStopType,
  TextRun,
} from 'docx';

import {
  BULLET_INDENT,
  CONTENT_WIDTH,
  PAGE,
  STYLES,
  cvBlocks,
  noteBlocks,
  type Block,
  type DateOf,
} from './layout.js';

/**
 * DOCX output (ADR-054): the same blocks and spacing as the PDF, in Arial (metric-compatible
 * with Helvetica). ATS-safe: real headings, real bullets (a numbering definition), and no
 * tables, text boxes, images, headers or footers. An entry's dates sit on a right tab stop.
 */

const FONT = 'Arial';
const TWIP = 20;
const BULLETS = 'hireframe-bullets';

const HEADINGS: Partial<Record<Block['kind'], (typeof HeadingLevel)[keyof typeof HeadingLevel]>> = {
  name: HeadingLevel.TITLE,
  section: HeadingLevel.HEADING_1,
  entry: HeadingLevel.HEADING_2,
};

function run(text: string, kind: Block['kind'], bold = STYLES[kind].bold): TextRun {
  return new TextRun({ text, font: FONT, size: STYLES[kind].size * 2, bold, color: '000000' });
}

function paragraph(block: Block): Paragraph {
  const style = STYLES[block.kind];
  const heading = HEADINGS[block.kind];
  const base = {
    ...(heading === undefined ? {} : { heading }),
    spacing: {
      before: Math.round(style.before * TWIP),
      after: Math.round(style.after * TWIP),
      line: Math.round(style.leading * TWIP),
      lineRule: LineRuleType.EXACT,
    },
  };
  if (block.kind === 'bullet') {
    return new Paragraph({
      ...base,
      numbering: { reference: BULLETS, level: 0 },
      children: [run(block.text, 'bullet')],
    });
  }
  if (block.kind === 'entry') {
    return new Paragraph({
      ...base,
      tabStops: [{ type: TabStopType.RIGHT, position: Math.round(CONTENT_WIDTH * TWIP) }],
      children:
        block.dates === undefined
          ? [run(block.text, 'entry')]
          : [run(block.text, 'entry'), run('\t', 'entry'), run(block.dates, 'entry', false)],
    });
  }
  return new Paragraph({
    ...base,
    ...(block.kind === 'section'
      ? {
          border: {
            bottom: { style: BorderStyle.SINGLE, size: 4, space: 1, color: '000000' },
          },
        }
      : {}),
    children: [run(block.text, block.kind)],
  });
}

async function renderBlocksDocx(blocks: readonly Block[], title: string): Promise<Uint8Array> {
  const margin = Math.round(PAGE.margin * TWIP);
  const doc = new Document({
    creator: 'Hireframe',
    title,
    styles: { default: { document: { run: { font: FONT, size: STYLES.text.size * 2 } } } },
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
                  indent: {
                    left: Math.round(BULLET_INDENT * TWIP),
                    hanging: Math.round(BULLET_INDENT * TWIP),
                  },
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
            size: { width: Math.round(PAGE.width * TWIP), height: Math.round(PAGE.height * TWIP) },
            margin: { top: margin, bottom: margin, left: margin, right: margin },
          },
        },
        children: blocks.map(paragraph),
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}

export async function renderCvDocx(
  header: CvHeader,
  content: TrimmedCvContent,
  dateOf: DateOf,
): Promise<Uint8Array> {
  return await renderBlocksDocx(cvBlocks(header, content, dateOf), `${header.name} CV`);
}

export async function renderNoteDocx(
  header: CvHeader,
  note: TrimmedCvContent['coverNote'],
): Promise<Uint8Array> {
  return await renderBlocksDocx(noteBlocks(header, note), `${header.name} cover note`);
}
