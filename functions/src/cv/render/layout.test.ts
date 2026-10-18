import { applyTrim } from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

import {
  aliasOf,
  CV_ALIASES,
  fullCv,
  validCv,
} from '../../../../packages/shared/src/fixtures/cv.js';
import { FAKE_DATES, FAKE_HEADER, fakeDateOf } from './fixtures.js';
import {
  BASE_SPEC,
  BODY_SIZES,
  CONTENT_WIDTH,
  PDF_WRAP_SLACK,
  PDF_WRAP_WIDTH,
  SECTION_ORDER,
  SPREAD_CAPS,
  USABLE_HEIGHT,
  baseSpec,
  cvBlocks,
  layoutBlocks,
  lineText,
  makeDateOf,
  makeEndKeyOf,
  makeHasEndOf,
  resolveStyles,
  spreadSpec,
  toTwip,
  wrapRuns,
  type Block,
  type Measure,
  type Run,
} from './layout.js';

/** Every character is half the font size wide; bold is 10% wider. Deterministic and offline. */
const measure: Measure = (text, bold, size) => text.length * size * 0.5 * (bold ? 1.1 : 1);
const plainMeasure = (text: string, bold: boolean) => measure(text, bold, 10);

const texts = (lines: readonly (readonly Run[])[]) => lines.map(lineText);

describe('wrapRuns', () => {
  it('wraps words greedily and keeps the weight of each run', () => {
    const runs: Run[] = [
      { text: 'Senior Analyst', bold: true },
      { text: ', Example Cloud Limited', bold: false },
    ];
    // 10 pt: 5 pt per regular character, 5.5 pt per bold one.
    const lines = wrapRuns(runs, 130, plainMeasure);
    expect(texts(lines)).toEqual(['Senior Analyst, Example', 'Cloud Limited']);
    expect(lines[0]).toEqual([
      { text: 'Senior Analyst', bold: true },
      { text: ', Example', bold: false },
    ]);
  });

  it('never splits a word at a change of weight', () => {
    const runs: Run[] = [
      { text: 'Role', bold: true },
      { text: ', Org', bold: false },
    ];
    // "Role," is one word: it can't be wrapped between the bold and the regular part.
    const lines = wrapRuns(runs, 30, plainMeasure);
    expect(texts(lines)[0]).toBe('Role,');
  });

  it('measures each run in its own weight', () => {
    const bold = wrapRuns([{ text: 'aaaa bbbb', bold: true }], 45, plainMeasure);
    const regular = wrapRuns([{ text: 'aaaa bbbb', bold: false }], 45, plainMeasure);
    expect(texts(bold)).toEqual(['aaaa', 'bbbb']);
    expect(texts(regular)).toEqual(['aaaa bbbb']);
  });

  it('breaks a word wider than the line by character, and loses no text', () => {
    const lines = wrapRuns([{ text: 'W'.repeat(40), bold: false }], 50, plainMeasure);
    expect(lines.length).toBeGreaterThan(3);
    expect(texts(lines).join('')).toBe('W'.repeat(40));
    for (const line of lines) {
      expect(line.reduce((n, run) => n + plainMeasure(run.text, run.bold), 0)).toBeLessThanOrEqual(
        50,
      );
    }
  });

  it('collapses runs of whitespace and returns one empty line for no text', () => {
    expect(texts(wrapRuns([{ text: '  a \n  b  ', bold: false }], 500, plainMeasure))).toEqual([
      'a b',
    ]);
    expect(wrapRuns([], 100, plainMeasure)).toEqual([[]]);
    expect(wrapRuns([{ text: '   ', bold: false }], 100, plainMeasure)).toEqual([[]]);
  });
});

describe('resolveStyles', () => {
  it('rounds every size and spacing to a twip, whatever the spread', () => {
    for (const bodySize of BODY_SIZES) {
      for (let amount = 0; amount <= 1.0001; amount += 0.0625) {
        const styles = resolveStyles(spreadSpec(baseSpec(bodySize), amount));
        for (const style of Object.values(styles)) {
          for (const value of [style.leading, style.before, style.after]) {
            expect(Math.abs(value * 20 - Math.round(value * 20))).toBeLessThan(1e-9);
          }
          expect(style.size * 2).toBe(Math.round(style.size * 2));
        }
      }
    }
    expect(toTwip(13.126)).toBe(13.15);
    expect(toTwip(13.12)).toBe(13.1);
  });

  it('stretches no gap beyond ×1.6 and the leading no more than 6%', () => {
    const spread = spreadSpec(BASE_SPEC, 1);
    expect(spread.sectionGapScale).toBe(SPREAD_CAPS.gap);
    expect(spread.leadingScale).toBe(SPREAD_CAPS.leading);
    expect(spreadSpec(BASE_SPEC, 0)).toEqual(BASE_SPEC);
    const base = resolveStyles(BASE_SPEC);
    const wide = resolveStyles(spread);
    expect(wide.section.before).toBeLessThanOrEqual(base.section.before * 1.6 + 0.05);
    expect(wide.bullet.leading).toBeLessThanOrEqual(base.bullet.leading * 1.06 + 0.05);
  });

  it('is monochrome-sized: name 18 pt, centred header, body at the spec size', () => {
    const styles = resolveStyles(baseSpec(10.5));
    expect(styles.name).toMatchObject({ size: 18, align: 'center' });
    expect(styles.contact.align).toBe('center');
    expect(styles.bullet.size).toBe(10.5);
    expect(styles.education.size).toBe(10.5);
    expect(styles.section.align).toBe('left');
  });
});

describe('cvBlocks', () => {
  const sections = (blocks: readonly Block[]) =>
    blocks.filter((block) => block.kind === 'section').map((block) => block.text);

  it('puts the sections in order: Summary, Education, Experience, Projects, Skills, in capitals', () => {
    expect(SECTION_ORDER).toEqual(['Summary', 'Education', 'Experience', 'Projects', 'Skills']);
    const blocks = cvBlocks(FAKE_HEADER, applyTrim(validCv(), 0), fakeDateOf);
    expect(sections(blocks)).toEqual(['SUMMARY', 'EDUCATION', 'EXPERIENCE', 'PROJECTS', 'SKILLS']);
  });

  it('leaves out an empty section and a trimmed summary', () => {
    const cv = { ...validCv(), projects: [], education: [] };
    expect(sections(cvBlocks(FAKE_HEADER, { ...cv, summary: null }, fakeDateOf))).toEqual([
      'EXPERIENCE',
      'SKILLS',
    ]);
  });

  it('writes an entry as a bold role and a regular organisation, with the dates beside it', () => {
    const blocks = cvBlocks(FAKE_HEADER, applyTrim(validCv(), 0), fakeDateOf);
    const entry = blocks.find((block) => block.kind === 'entry');
    expect(entry?.runs).toEqual([
      { text: 'Customer Onboarding Intern', bold: true },
      { text: ', Example Cloud Ltd', bold: false },
    ]);
    expect(entry?.text).toBe('Customer Onboarding Intern, Example Cloud Ltd');
    expect(entry?.dates).toBe('Oct 2023 – May 2024');
  });

  it('writes education lines regular, with the dates, and skills as one paragraph', () => {
    const blocks = cvBlocks(FAKE_HEADER, applyTrim(validCv(), 0), fakeDateOf);
    const education = blocks.find((block) => block.kind === 'education');
    expect(education?.runs).toEqual([{ text: 'Scrum Fundamentals Certificate', bold: false }]);
    expect(education?.dates).toBe('2024');
    const skills = blocks.filter((block) => block.kind === 'text').pop();
    expect(skills?.text).toBe('SQL, Python');
  });

  it('writes a project with no organisation as the bold role alone, with no trailing comma', () => {
    const cv = applyTrim(validCv(), 0);
    const project = cv.projects[0];
    if (project === undefined) throw new Error('no project');
    const blocks = cvBlocks(
      FAKE_HEADER,
      { ...cv, projects: [{ ...project, heading: { ...project.heading, org: '' } }] },
      fakeDateOf,
    );
    const entry = blocks.filter((block) => block.kind === 'entry')[1];
    expect(entry?.runs).toEqual([{ text: 'Analysis project', bold: true }]);
    expect(entry?.text).toBe('Analysis project');
  });

  it('dates an education line by its year only, and an entry by its range', () => {
    const facts = [
      { id: 'fact-scrum', dates: { start: '2021', end: '2024' } },
      { id: 'fact-intern', dates: { start: '2023-10' } },
    ];
    const dateOf = makeDateOf(CV_ALIASES, facts);
    const blocks = cvBlocks(FAKE_HEADER, applyTrim(validCv(), 0), dateOf);
    expect(blocks.find((block) => block.kind === 'education')?.dates).toBe('2024');
    expect(blocks.find((block) => block.kind === 'entry')?.dates).toBe('Oct 2023 – Present');
    const startOnly = makeDateOf(CV_ALIASES, [{ id: 'fact-scrum', dates: { start: '2023-05' } }]);
    expect(startOnly(aliasOf('fact-scrum'), 'education')).toBe('2023');
    expect(startOnly(aliasOf('fact-scrum'))).toBe('May 2023 – Present');
  });

  it('keeps the dates off a block that has none', () => {
    const blocks = cvBlocks(FAKE_HEADER, applyTrim(validCv(), 0), () => '');
    expect(blocks.some((block) => block.dates !== undefined)).toBe(false);
  });
});

describe('layoutBlocks', () => {
  const styles = resolveStyles(BASE_SPEC);
  const entry = (title: string, dates: string): Block => ({
    kind: 'entry',
    text: title,
    runs: [{ text: title, bold: true }],
    dates,
  });

  it('wraps the PDF 1.5% narrower than the DOCX', () => {
    expect(PDF_WRAP_SLACK).toBe(0.015);
    expect(PDF_WRAP_WIDTH).toBeCloseTo(CONTENT_WIDTH * 0.985, 9);
    const block: Block = {
      kind: 'text',
      text: '',
      runs: [{ text: 'word '.repeat(300).trim(), bold: false }],
    };
    const narrow = layoutBlocks([block], measure, styles).blockLines[0] ?? 0;
    const wide = layoutBlocks([block], measure, styles, CONTENT_WIDTH).blockLines[0] ?? 0;
    expect(wide).toBeLessThanOrEqual(narrow);
  });

  it("puts an entry's dates on the title's last line, not its first", () => {
    const title = 'alpha '.repeat(25).trim();
    const { lines, blockLines } = layoutBlocks(
      [entry(title, 'Oct 2023 – May 2024')],
      measure,
      styles,
    );
    expect(blockLines[0]).toBeGreaterThan(1);
    expect(lines.slice(0, -1).every((line) => line.dates === undefined)).toBe(true);
    expect(lines[lines.length - 1]?.dates?.text).toBe('Oct 2023 – May 2024');
    expect(lines[lines.length - 1]?.runs.length).toBeGreaterThan(0);
  });

  it('keeps title and dates on one line when they fit', () => {
    const { lines, headingWraps } = layoutBlocks(
      [entry('Analyst, Example Ltd', 'Oct 2023 – May 2024')],
      measure,
      styles,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.dates?.text).toBe('Oct 2023 – May 2024');
    expect(headingWraps).toBe(0);
  });

  it('puts the dates on a line of their own when the last title line has no room, and counts a wrap', () => {
    // The title fills the line to within a few points: the dates can't join it.
    const size = styles.entry.size;
    const words: string[] = [];
    while (measure(`${words.join(' ')} xxxxxxxx`, true, size) < PDF_WRAP_WIDTH - 20)
      words.push('xxxxxxxx');
    const title = words.join(' ');
    const result = layoutBlocks([entry(title, 'Oct 2023 – May 2024')], measure, styles);
    expect(result.blockLines[0]).toBe(2);
    const [first, second] = result.lines;
    expect(texts([first?.runs ?? []])).toEqual([title]);
    expect(second?.runs).toEqual([]);
    expect(second?.dates?.text).toBe('Oct 2023 – May 2024');
    expect(result.headingWraps).toBe(1);
  });

  it('counts a title that wraps as a heading wrap, and an education line as none', () => {
    const long = 'alpha '.repeat(40).trim();
    expect(layoutBlocks([entry(long, '2024')], measure, styles).headingWraps).toBe(1);
    const education: Block = { ...entry(long, '2024'), kind: 'education' };
    expect(layoutBlocks([education], measure, styles).headingWraps).toBe(0);
  });

  it('measures the used height as the lines plus the gaps between blocks', () => {
    const a: Block = { kind: 'bullet', text: 'a', runs: [{ text: 'a', bold: false }] };
    const { usedHeight, pages, lines } = layoutBlocks([a, a], measure, styles);
    const { leading, after, before } = styles.bullet;
    expect(pages).toBe(1);
    expect(lines).toHaveLength(2);
    expect(usedHeight).toBeCloseTo(2 * leading + Math.max(after, before), 9);
  });

  it('starts a second page when the lines pass the usable height', () => {
    const line: Block = { kind: 'text', text: 'a', runs: [{ text: 'a', bold: false }] };
    const count = Math.ceil(USABLE_HEIGHT / styles.text.leading) + 2;
    const result = layoutBlocks(
      Array.from({ length: count }, () => line),
      measure,
      styles,
    );
    expect(result.pages).toBe(2);
    expect(result.lines.at(-1)?.page).toBe(1);
  });

  it('centres the name and the contact line, and rules under section titles', () => {
    const blocks = cvBlocks(FAKE_HEADER, applyTrim(validCv(), 0), fakeDateOf);
    const { lines } = layoutBlocks(blocks, measure, styles);
    expect(lines[0]?.align).toBe('center');
    expect(lines[1]?.align).toBe('center');
    const rules = lines.filter((line) => line.rule === true).map((line) => lineText(line.runs));
    expect(rules).toEqual(['SUMMARY', 'EDUCATION', 'EXPERIENCE', 'PROJECTS', 'SKILLS']);
  });

  it('reports the rendered lines of each block in order', () => {
    const blocks = cvBlocks(FAKE_HEADER, applyTrim(fullCv(), 0), fakeDateOf);
    const { blockLines } = layoutBlocks(blocks, measure, styles);
    expect(blockLines).toHaveLength(blocks.length);
    expect(blockLines.every((n) => n >= 1)).toBe(true);
  });
});

describe('makeHasEndOf', () => {
  it('is true only for a fact with an end date', () => {
    const hasEnd = makeHasEndOf(CV_ALIASES, [
      ...FAKE_DATES,
      { id: 'fact-clients', dates: { start: '2024' } },
    ]);
    expect(hasEnd(aliasOf('fact-intern'))).toBe(true);
    expect(hasEnd(aliasOf('fact-scrum'))).toBe(true);
    expect(hasEnd(aliasOf('fact-clients'))).toBe(false);
    expect(hasEnd(aliasOf('fact-sql'))).toBe(false);
    expect(hasEnd('F999')).toBe(false);
  });
});

describe('makeEndKeyOf', () => {
  it('reads the end of the cited fact, and present when there is none', () => {
    const endKeyOf = makeEndKeyOf(CV_ALIASES, FAKE_DATES);
    expect(endKeyOf(aliasOf('fact-intern'))).toBe('2024-05');
    expect(endKeyOf(aliasOf('fact-scrum'))).toBe('2024-12');
    expect(endKeyOf(aliasOf('fact-clients'))).toBe('9999-12');
    expect(endKeyOf('F999')).toBe('9999-12');
  });
});
