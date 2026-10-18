import {
  applyTrim,
  citedFactIds,
  CvContentSchema,
  trimOrder,
  validateCv,
  wordCount,
  type CvContent,
  type TrimmedCvContent,
} from '@hireframe/shared';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { getDocumentProxy } from 'unpdf';
import { describe, expect, it } from 'vitest';

import {
  CV_ALIASES,
  CV_FACTS,
  fullCv,
  validCv,
} from '../../../../packages/shared/src/fixtures/cv.js';
import { extractText } from '../extract.js';
import {
  CvRenderError,
  fitPage,
  renderCvDocx,
  renderCvPdf,
  renderNoteDocx,
  renderNotePdf,
} from './index.js';
import { FAKE_HEADER, WIDE_HEADER, fakeDateOf, filler, maxCv, wideCv } from './fixtures.js';
import {
  BODY_SIZES,
  BULLET_INDENT,
  CONTENT_WIDTH,
  USABLE_HEIGHT,
  baseSpec,
  cvBlocks,
  layoutBlocks,
  resolveStyles,
  wrapRuns,
} from './layout.js';
import { makePdfMeasure } from './pdf.js';

const squash = (text: string) => text.replace(/\s+/g, ' ');

/** Every part appears in `text`, each after the one before. */
function expectInOrder(text: string, parts: readonly string[]): void {
  const flat = squash(text);
  let from = 0;
  for (const part of parts) {
    const needle = squash(part);
    const at = flat.indexOf(needle, from);
    expect(at, `"${part.slice(0, 40)}" in order`).toBeGreaterThanOrEqual(from);
    from = at + needle.length;
  }
}

/** The texts a reader should meet, top to bottom, for a CV rendered with `fakeDateOf`. */
function readingOrder(content: TrimmedCvContent): string[] {
  const parts: string[] = [FAKE_HEADER.name, FAKE_HEADER.email];
  if (content.summary !== null) parts.push('SUMMARY', content.summary.text);
  if (content.education.length > 0) {
    parts.push('EDUCATION', ...content.education.map((line) => line.line));
  }
  for (const [title, entries] of [
    ['EXPERIENCE', content.experience],
    ['PROJECTS', content.projects],
  ] as const) {
    if (entries.length === 0) continue;
    parts.push(title);
    for (const entry of entries) {
      parts.push(`${entry.heading.role}, ${entry.heading.org}`);
      for (const bullet of entry.bullets) parts.push(bullet.text);
    }
  }
  parts.push('SKILLS', ...content.skills.map((skill) => skill.label));
  return parts;
}

async function pageCount(bytes: Uint8Array): Promise<number> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
  return pdf.numPages;
}

describe('renderCvPdf', () => {
  it('renders the fake CV on exactly one page, with every heading and bullet in order', async () => {
    const { bytes, pages } = await renderCvPdf(FAKE_HEADER, applyTrim(validCv(), 0), fakeDateOf);
    expect(pages).toBe(1);
    expect(await pageCount(bytes)).toBe(1);
    const text = await extractText(bytes, 'pdf');
    expectInOrder(text, readingOrder(applyTrim(validCv(), 0)));
  });

  it('takes the contact block from the header only', async () => {
    const text = await extractText(
      (await renderCvPdf(FAKE_HEADER, applyTrim(validCv(), 0), fakeDateOf)).bytes,
      'pdf',
    );
    expectInOrder(text, [
      FAKE_HEADER.name,
      `${FAKE_HEADER.email} | ${FAKE_HEADER.phone ?? ''} | ${FAKE_HEADER.location ?? ''} | ${FAKE_HEADER.links?.[0] ?? ''}`,
    ]);

    const other = { ...FAKE_HEADER, name: 'Sam Sample', email: 'sam@example.com' };
    const changed = await extractText(
      (await renderCvPdf(other, applyTrim(validCv(), 0), fakeDateOf)).bytes,
      'pdf',
    );
    expect(changed).toContain('Sam Sample');
    expect(changed).toContain('sam@example.com');
    expect(changed).not.toContain('Alex Example');
    expect(changed).not.toContain('alex@example.com');
  });

  it('puts dates from the cited fact next to a heading, and none when the fact has none', async () => {
    const text = squash(
      await extractText(
        (await renderCvPdf(FAKE_HEADER, applyTrim(validCv(), 0), fakeDateOf)).bytes,
        'pdf',
      ),
    );
    expect(text).toContain('Oct 2023 – May 2024');
    expect(text).toContain('Scrum Fundamentals Certificate 2024');
    const bare = await renderCvPdf(FAKE_HEADER, applyTrim(validCv(), 0), () => '');
    expect(squash(await extractText(bare.bytes, 'pdf'))).not.toContain('2023');
  });

  it('leaves out the summary once it is trimmed away', async () => {
    const last = trimOrder(validCv()).length;
    const trimmed = applyTrim(validCv(), last);
    expect(trimmed.summary).toBeNull();
    const text = await extractText(
      (await renderCvPdf(FAKE_HEADER, trimmed, fakeDateOf)).bytes,
      'pdf',
    );
    expect(text).not.toContain('SUMMARY');
    expect(text).toContain('EXPERIENCE');
  });

  it('is deterministic and holds no font file, image or date', async () => {
    const one = await renderCvPdf(FAKE_HEADER, applyTrim(validCv(), 0), fakeDateOf);
    const two = await renderCvPdf(FAKE_HEADER, applyTrim(validCv(), 0), fakeDateOf);
    expect(Buffer.from(one.bytes).equals(Buffer.from(two.bytes))).toBe(true);
    const raw = Buffer.from(one.bytes).toString('latin1');
    expect(raw).not.toMatch(/FontFile|\/Subtype\s*\/Image|CreationDate|ModDate/);
    expect(raw).toContain('/BaseFont /Helvetica');
  });

  it('breaks a word wider than the line instead of running off the page', async () => {
    const cv = structuredClone(validCv());
    const bullet = cv.experience[0]?.bullets[0];
    if (bullet === undefined) throw new Error('fixture');
    bullet.text = 'W'.repeat(200);
    const { bytes, pages } = await renderCvPdf(FAKE_HEADER, applyTrim(cv, 0), fakeDateOf);
    expect(pages).toBe(1);
    expect(squash(await extractText(bytes, 'pdf')).replaceAll(' ', '')).toContain('W'.repeat(200));
  });

  it('refuses a character Helvetica cannot print, in the header or the text, and never drops it', async () => {
    const withText = structuredClone(validCv());
    withText.summary.text = 'Analyst with α skills';
    await expect(renderCvPdf(FAKE_HEADER, applyTrim(withText, 0), fakeDateOf)).rejects.toThrow(
      CvRenderError,
    );
    await expect(
      renderCvPdf({ ...FAKE_HEADER, name: '日本 Example' }, applyTrim(validCv(), 0), fakeDateOf),
    ).rejects.toMatchObject({ code: 'unsupported_char' });
    await expect(
      renderCvDocx({ ...FAKE_HEADER, name: '日本 Example' }, applyTrim(validCv(), 0), fakeDateOf),
    ).rejects.toMatchObject({ code: 'unsupported_char' });
  });

  it('prints WinAnsi characters outside ASCII', async () => {
    const cv = structuredClone(validCv());
    cv.summary.text = 'Café analyst — “clear” writing, 5 € budget, Ångström.';
    const text = await extractText(
      (await renderCvPdf({ ...FAKE_HEADER, name: 'Zoë Example' }, applyTrim(cv, 0), fakeDateOf))
        .bytes,
      'pdf',
    );
    expect(text).toContain('Café analyst — “clear” writing, 5 € budget, Ångström.');
    expect(text).toContain('Zoë Example');
  });
});

describe('a project with no organisation, in both files', () => {
  const cv = applyTrim(validCv(), 0);
  const project = cv.projects[0];
  if (project === undefined) throw new Error('no project');
  const content = {
    ...cv,
    projects: [{ ...project, heading: { ...project.heading, org: '' } }],
  };

  it('prints the role alone: no trailing comma in the PDF or the DOCX', async () => {
    const pdf = await extractText(
      (await renderCvPdf(FAKE_HEADER, content, fakeDateOf)).bytes,
      'pdf',
    );
    const docx = await extractText(await renderCvDocx(FAKE_HEADER, content, fakeDateOf), 'docx');
    for (const text of [pdf, docx]) {
      expect(squash(text)).toContain('Analysis project');
      expect(text).not.toMatch(/Analysis project,/);
    }
  });
});

describe('renderCvDocx', () => {
  const content = applyTrim(validCv(), 0);

  it('has every heading and bullet in order', async () => {
    const bytes = await renderCvDocx(FAKE_HEADER, content, fakeDateOf);
    expectInOrder(await extractText(bytes, 'docx'), readingOrder(content));
  });

  it('uses real headings and real bullets', async () => {
    const bytes = await renderCvDocx(FAKE_HEADER, content, fakeDateOf);
    const { value: html } = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
    expect(html).toContain('<h1><strong>EXPERIENCE</strong></h1>');
    expect(html).toContain('<h2><strong>Customer Onboarding Intern</strong>, Example Cloud Ltd');
    expect(html).toContain('<ul><li>Led onboarding for 12 clients.</li>');
    expect(html).not.toContain('<table');
  });

  it("puts an entry's dates after a real tab element, not a tab character", async () => {
    const bytes = await renderCvDocx(FAKE_HEADER, content, fakeDateOf);
    const zip = await JSZip.loadAsync(bytes);
    const body = (await zip.file('word/document.xml')?.async('string')) ?? '';
    const paragraphs = body.match(/<w:p>.*?<\/w:p>/gs) ?? [];
    const entry = paragraphs.find((p) => p.includes('Example Cloud Ltd</w:t>'));
    expect(entry).toBeDefined();
    // Title, then a tab element, then the dates; and a right tab stop for it to jump to.
    const title = entry?.indexOf('Example Cloud Ltd</w:t>') ?? -1;
    const tab = entry?.indexOf('<w:tab/>') ?? -1;
    const dates = entry?.indexOf('Oct 2023 – May 2024</w:t>') ?? -1;
    expect(title).toBeGreaterThan(0);
    expect(tab).toBeGreaterThan(title);
    expect(dates).toBeGreaterThan(tab);
    expect(entry).toContain('<w:tab w:val="right"');
    // No literal tab character hides in any run's text.
    expect(body).not.toMatch(/<w:t[^>]*>[^<]*\t[^<]*<\/w:t>/);
    // Read back: the dates come after the title in the extracted text.
    const text = squash(await extractText(bytes, 'docx'));
    expect(text).toContain('Oct 2023 – May 2024');
    expect(text).toContain('Scrum Fundamentals Certificate 2024');
  });

  it('round-trips characters XML cares about through mammoth', async () => {
    const tricky = 'R&D <team> "x"';
    const cv = structuredClone(content);
    cv.summary = { text: tricky, factRefs: ['F1'] };
    const bytes = await renderCvDocx(FAKE_HEADER, cv, fakeDateOf);
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    expect(value).toContain(tricky);
    const body =
      (await (await JSZip.loadAsync(bytes)).file('word/document.xml')?.async('string')) ?? '';
    expect(body).toContain('R&amp;D &lt;team&gt; &quot;x&quot;');
    expect(body).not.toContain('<team>');
  });

  it('holds no table, text box, image, header or footer', async () => {
    const zip = await JSZip.loadAsync(await renderCvDocx(FAKE_HEADER, content, fakeDateOf));
    const names = Object.keys(zip.files);
    expect(names.filter((name) => /media\/|header|footer|embeddings|fonts\//.test(name))).toEqual(
      [],
    );
    const body = await zip.file('word/document.xml')?.async('string');
    expect(body).toBeDefined();
    expect(body).not.toMatch(/<w:tbl>|txbxContent|<w:drawing|<w:pict|<w:object/);
    expect(body).toContain('w:pgSz w:w="11906" w:h="16838"');
  });

  it('writes the same text as the PDF', async () => {
    const pdf = squash(
      await extractText((await renderCvPdf(FAKE_HEADER, content, fakeDateOf)).bytes, 'pdf'),
    );
    const docx = squash(
      await extractText(await renderCvDocx(FAKE_HEADER, content, fakeDateOf), 'docx'),
    );
    for (const part of readingOrder(content)) {
      expect(pdf).toContain(squash(part));
      expect(docx).toContain(squash(part));
    }
  });
});

describe('fitPage', () => {
  it('leaves a CV that fits untouched', async () => {
    const fit = await fitPage(FAKE_HEADER, validCv(), fakeDateOf);
    expect(fit.ok && fit.trimmed).toBe(0);
    expect(fit.ok && fit.content).toEqual(applyTrim(validCv(), 0));
  });

  it('trims a CV that is too long, one step at a time, until it fits', async () => {
    const content = maxCv();
    const full = await renderCvPdf(FAKE_HEADER, applyTrim(content, 0), fakeDateOf);
    expect(full.pages).toBeGreaterThan(1);
    const fit = await fitPage(FAKE_HEADER, content, fakeDateOf);
    if (!fit.ok) throw new Error('did not fit');
    expect(fit.trimmed).toBeGreaterThan(0);
    expect(await pageCount(fit.bytes)).toBe(1);
    // One step fewer would have been too long: the fit is the least trimming that works.
    const before = await renderCvPdf(FAKE_HEADER, applyTrim(content, fit.trimmed - 1), fakeDateOf);
    expect(before.pages).toBeGreaterThan(1);
  });

  it('fits the maximum-size content after trimming, whose text still passes the schema', async () => {
    const content = maxCv();
    expect(CvContentSchema.safeParse(content).success).toBe(true);
    const fit = await fitPage(FAKE_HEADER, content, fakeDateOf);
    if (!fit.ok) throw new Error('maximum content did not fit');
    expect(fit.trimmed).toBeGreaterThan(0);
    expect(await pageCount(fit.bytes)).toBe(1);
    // Headings and education are never trimmed.
    expect(fit.content.experience.map((entry) => entry.heading)).toEqual(
      content.experience.map((entry) => entry.heading),
    );
    expect(fit.content.education).toEqual(content.education);
    expectInOrder(await extractText(fit.bytes, 'pdf'), readingOrder(fit.content));
  });

  it('also fits the maximum content in the DOCX at the same trim', async () => {
    const fit = await fitPage(FAKE_HEADER, maxCv(), fakeDateOf);
    if (!fit.ok) throw new Error('did not fit');
    const docx = await renderCvDocx(FAKE_HEADER, fit.content, fakeDateOf);
    expectInOrder(await extractText(docx, 'docx'), readingOrder(fit.content));
  });

  it('reports too_long for the widest content the limits allow: a real outcome, not an impossible one', async () => {
    const content = wideCv();
    expect(CvContentSchema.safeParse(content).success).toBe(true);
    // Fully trimmed, the headings and education alone are over a page in capital W and M.
    const last = trimOrder(content).length;
    const trimmed = await renderCvPdf(FAKE_HEADER, applyTrim(content, last), fakeDateOf);
    expect(trimmed.pages).toBeGreaterThan(1);
    expect(await fitPage(FAKE_HEADER, content, fakeDateOf)).toEqual({
      ok: false,
      code: 'too_long',
    });
  });

  it('wraps a header at every ceiling (three 200-character links) and still fits a short CV', async () => {
    expect(WIDE_HEADER.links?.map((link) => link.length)).toEqual([200, 200, 200]);
    const fit = await fitPage(WIDE_HEADER, validCv(), fakeDateOf);
    if (!fit.ok) throw new Error('did not fit');
    expect(await pageCount(fit.bytes)).toBe(1);
    const text = squash(await extractText(fit.bytes, 'pdf')).replaceAll(' ', '');
    for (const link of WIDE_HEADER.links ?? []) expect(text).toContain(link);
    expect(text).toContain(WIDE_HEADER.name);
    // The DOCX takes the same header.
    const docx = await renderCvDocx(WIDE_HEADER, fit.content, fakeDateOf);
    expect(squash(await extractText(docx, 'docx')).replaceAll(' ', '')).toContain(
      WIDE_HEADER.links?.[0] ?? 'missing',
    );
  });

  it('reports too_long when even the fully trimmed CV is over a page', async () => {
    const huge = maxCv();
    // Beyond the schema's limits on purpose: thirty experience headings cannot fit one page,
    // and headings are never trimmed.
    huge.experience = Array.from({ length: 30 }, (_, i) => ({
      heading: { role: filler(80, i), org: filler(80, i + 1), factRef: 'F1' },
      bullets: [],
    }));
    expect(await fitPage(FAKE_HEADER, huge, fakeDateOf)).toEqual({
      ok: false,
      code: 'too_long',
    });
  });

  it('renders content the validator accepted, with the cited facts the document stores', async () => {
    const content: CvContent = validCv();
    expect(validateCv(content, CV_ALIASES, CV_FACTS)).toEqual({ ok: true });
    const fit = await fitPage(FAKE_HEADER, content, fakeDateOf);
    expect(fit.ok).toBe(true);
    expect(citedFactIds(content, CV_ALIASES).length).toBeGreaterThan(0);
  });
});

describe('cover note', () => {
  const note = validCv().coverNote;

  it('is one page in both formats and says the same thing', async () => {
    const pdf = await renderNotePdf(FAKE_HEADER, note);
    expect(pdf.pages).toBe(1);
    const text = await extractText(pdf.bytes, 'pdf');
    const docx = await extractText(await renderNoteDocx(FAKE_HEADER, note), 'docx');
    const order = [
      FAKE_HEADER.name,
      FAKE_HEADER.email,
      'Dear Hiring Team,',
      ...note.paragraphs.map((paragraph) => paragraph.text),
      'Yours sincerely,',
      FAKE_HEADER.name,
    ];
    expectInOrder(text, order);
    expectInOrder(docx, order);
  });

  it('stays on one page at the longest the validator allows (250 words)', async () => {
    const words = (n: number) => Array.from({ length: n }, () => 'ab').join(' ');
    const longest = {
      paragraphs: [
        { text: words(63), factRefs: ['F1'] },
        { text: words(62), factRefs: ['F1'] },
        { text: words(63), factRefs: ['F1'] },
        { text: words(62), factRefs: ['F1'] },
      ],
    };
    expect(longest.paragraphs.reduce((n, p) => n + wordCount(p.text), 0)).toBe(250);
    expect((await renderNotePdf(FAKE_HEADER, longest)).pages).toBe(1);

    // The longest the schema alone allows is four 600-character paragraphs: still one page.
    const widest = maxCv().coverNote;
    expect((await renderNotePdf(FAKE_HEADER, widest)).pages).toBe(1);
  });

  it('refuses a character Helvetica cannot print', async () => {
    const bad = { paragraphs: [{ text: 'Hello ✓', factRefs: ['F1'] }, ...note.paragraphs] };
    await expect(renderNotePdf(FAKE_HEADER, bad)).rejects.toMatchObject({
      code: 'unsupported_char',
    });
    await expect(renderNoteDocx(FAKE_HEADER, bad)).rejects.toMatchObject({
      code: 'unsupported_char',
    });
  });
});

describe('fitPage fills the page', () => {
  it('spreads a full CV over the page and keeps it to one', async () => {
    const fit = await fitPage(FAKE_HEADER, fullCv(), fakeDateOf);
    if (!fit.ok) throw new Error('did not fit');
    expect(fit.trimmed).toBe(0);
    expect(fit.fill).toBeGreaterThanOrEqual(0.93);
    expect(fit.fill).toBeLessThan(1);
    // The 6 pt reserve is kept.
    expect(fit.fill * USABLE_HEIGHT).toBeLessThanOrEqual(USABLE_HEIGHT - 6);
    expect(await pageCount(fit.bytes)).toBe(1);
  });

  it('takes the bigger body size when it fits, with fewer cuts before a bigger font', async () => {
    expect(BODY_SIZES).toEqual([11, 10.5, 10]);
    const fit = await fitPage(FAKE_HEADER, fullCv(), fakeDateOf);
    expect(fit.ok && fit.spec.bodySize).toBe(11);
    const dense = await fitPage(FAKE_HEADER, maxCv(), fakeDateOf);
    if (!dense.ok) throw new Error('did not fit');
    // Cuts come first: at the size ladder's bottom rung only when 10.5 needs more cuts.
    expect(dense.spec.bodySize).toBe(10);
    const bigger = await fitPage(FAKE_HEADER, { ...maxCv() }, fakeDateOf);
    expect(bigger.ok && bigger.trimmed).toBe(dense.trimmed);
  });

  it('spreads a small CV as far as the caps allow, and no further', async () => {
    const fit = await fitPage(FAKE_HEADER, validCv(), fakeDateOf);
    if (!fit.ok) throw new Error('did not fit');
    expect(fit.spec).toMatchObject({
      leadingScale: 1.06,
      sectionGapScale: 1.6,
      entryGapScale: 1.6,
      bulletGapScale: 1.6,
    });
    expect(fit.fill).toBeLessThan(0.93);
  });

  it('fills a maximum-size CV after trimming too', async () => {
    const fit = await fitPage(FAKE_HEADER, maxCv(), fakeDateOf);
    if (!fit.ok) throw new Error('did not fit');
    expect(fit.fill).toBeGreaterThanOrEqual(0.93);
    expect(await pageCount(fit.bytes)).toBe(1);
  });

  it('never makes a second page, at any body size, for any fixture', async () => {
    const measure = await makePdfMeasure();
    for (const content of [validCv(), fullCv(), maxCv(), wideCv()]) {
      for (const size of BODY_SIZES) {
        const blocks = cvBlocks(FAKE_HEADER, applyTrim(content, 0), fakeDateOf);
        const { pages } = layoutBlocks(blocks, measure, resolveStyles(baseSpec(size)));
        const fit = await fitPage(FAKE_HEADER, content, fakeDateOf);
        if (fit.ok) expect(await pageCount(fit.bytes)).toBe(1);
        expect(pages).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('reports the lines of each bullet and the heading wraps', async () => {
    const fit = await fitPage(FAKE_HEADER, fullCv(), fakeDateOf);
    if (!fit.ok) throw new Error('did not fit');
    const bullets = fit.content.experience
      .concat(fit.content.projects)
      .reduce((n, entry) => n + entry.bullets.length, 0);
    expect(fit.lines.bullets).toHaveLength(bullets);
    expect(fit.lines.bullets.every((n) => n >= 1)).toBe(true);
    expect(fit.lines.headingWraps).toBe(0);
    // A heading too long for one line is counted.
    const wrapped = await fitPage(FAKE_HEADER, maxCv(), fakeDateOf);
    expect(wrapped.ok && wrapped.lines.headingWraps).toBeGreaterThan(0);
  });

  it('is deterministic: same input, same bytes and same spec', async () => {
    const one = await fitPage(FAKE_HEADER, maxCv(), fakeDateOf);
    const two = await fitPage(FAKE_HEADER, maxCv(), fakeDateOf);
    if (!one.ok || !two.ok) throw new Error('did not fit');
    expect(Buffer.from(one.bytes).equals(Buffer.from(two.bytes))).toBe(true);
    expect(one.spec).toEqual(two.spec);
    expect(one.fill).toBe(two.fill);
  });

  it('takes under 300 ms at the schema limits', async () => {
    await fitPage(FAKE_HEADER, maxCv(), fakeDateOf); // warm
    const start = performance.now();
    await fitPage(FAKE_HEADER, maxCv(), fakeDateOf);
    await fitPage(FAKE_HEADER, wideCv(), fakeDateOf);
    expect(performance.now() - start).toBeLessThan(300);
  });
});

describe('PDF and DOCX agree', () => {
  it('never wraps later in the PDF than Word will: more lines at the PDF width than at the DOCX width', async () => {
    const measure = await makePdfMeasure();
    const fixtures = [
      [FAKE_HEADER, validCv()],
      [FAKE_HEADER, fullCv()],
      [FAKE_HEADER, maxCv()],
      [FAKE_HEADER, wideCv()],
      [WIDE_HEADER, maxCv()],
    ] as const;
    for (const [header, content] of fixtures) {
      for (const size of BODY_SIZES) {
        const styles = resolveStyles(baseSpec(size));
        const blocks = cvBlocks(header, applyTrim(content, 0), fakeDateOf);
        const pdf = layoutBlocks(blocks, measure, styles);
        const word = layoutBlocks(blocks, measure, styles, CONTENT_WIDTH);
        word.blockLines.forEach((lines, i) => {
          expect(lines).toBeLessThanOrEqual(pdf.blockLines[i] ?? 0);
        });
        expect(word.usedHeight).toBeLessThanOrEqual(pdf.usedHeight);
      }
    }
  });

  /**
   * The height Word gives the DOCX body, from document.xml alone: per paragraph the larger of the
   * previous space after and this space before (Word's rule with no "don't use HTML paragraph
   * auto spacing"), plus lines × the exact line height, plus the border's space and width. Lines
   * wrap at the full `CONTENT_WIDTH` with the spaces kept, and a right tab puts the dates at
   * the margin with no gap.
   */
  async function docxHeight(
    header: typeof FAKE_HEADER,
    content: Parameters<typeof renderCvDocx>[1],
    spec: ReturnType<typeof baseSpec>,
  ): Promise<number> {
    const measure = await makePdfMeasure();
    const zip = await JSZip.loadAsync(await renderCvDocx(header, content, fakeDateOf, spec));
    const body = (await zip.file('word/document.xml')?.async('string')) ?? '';
    const twip = (value: string | undefined) => Number(value ?? '0') / 20;
    let height = 0;
    let pendingAfter = 0;
    for (const paragraph of body.match(/<w:p>.*?<\/w:p>/gs) ?? []) {
      const attr = (tag: string, name: string) =>
        new RegExp(`<w:${tag}\\b[^>]*\\bw:${name}="([^"]*)"`).exec(paragraph)?.[1];
      const before = twip(attr('spacing', 'before'));
      const after = twip(attr('spacing', 'after'));
      const line = twip(attr('spacing', 'line'));
      const indent = paragraph.includes('<w:numPr>') ? BULLET_INDENT : 0;
      const runs: { text: string; bold: boolean }[] = [];
      let dates: { text: string; size: number } | undefined;
      let tabbed = false;
      for (const run of paragraph.match(/<w:r>.*?<\/w:r>/gs) ?? []) {
        if (run.includes('<w:tab/>')) {
          tabbed = true;
          continue;
        }
        const text = /<w:t\b[^>]*>(.*?)<\/w:t>/s.exec(run)?.[1] ?? '';
        const size = Number(/<w:sz w:val="(\d+)"/.exec(run)?.[1] ?? '20') / 2;
        const bold = run.includes('<w:b/>');
        if (tabbed) dates = { text, size };
        else runs.push({ text, bold });
      }
      const size = Number(/<w:sz w:val="(\d+)"/.exec(paragraph)?.[1] ?? '20') / 2;
      const width = CONTENT_WIDTH - indent;
      const wrapped = wrapRuns(runs, width, (text, bold) => measure(text, bold, size));
      if (dates !== undefined) {
        const last = wrapped[wrapped.length - 1] ?? [];
        const used = last.reduce((sum, part) => sum + measure(part.text, part.bold, size), 0);
        if (used + measure(dates.text, false, dates.size) > width) wrapped.push([]);
      }
      const border = /<w:bottom\b[^>]*\bw:sz="(\d+)"[^>]*\bw:space="(\d+)"/.exec(paragraph);
      const rule = border === null ? 0 : Number(border[1]) / 8 + Number(border[2]);
      height += Math.max(pendingAfter, before) + wrapped.length * line + rule;
      pendingAfter = after;
    }
    return height;
  }

  it('fits one page in Word: the DOCX height from document.xml is within USABLE_HEIGHT', async () => {
    for (const make of [fullCv, maxCv]) {
      const fit = await fitPage(FAKE_HEADER, make(), fakeDateOf);
      if (!fit.ok) throw new Error('did not fit');
      const height = await docxHeight(FAKE_HEADER, fit.content, fit.spec);
      expect(height).toBeGreaterThan(300);
      expect(height).toBeLessThanOrEqual(USABLE_HEIGHT);
      // The layout counts everything Word adds (the rule included), and Word wraps no later than
      // the PDF does: the DOCX is no taller than the layout says.
      expect(height).toBeLessThanOrEqual(fit.fill * USABLE_HEIGHT + 0.5);
    }
  });

  it('writes the contact line to the DOCX as the PDF reads it, spaces kept', async () => {
    const { body } = await docxParts();
    const contact = [
      FAKE_HEADER.email,
      FAKE_HEADER.phone,
      FAKE_HEADER.location,
      ...(FAKE_HEADER.links ?? []),
    ].join(' | ');
    expect(body).toContain(`>${contact}</w:t>`);
    expect(contact).not.toMatch(/ {2}/);
    const pdf = await extractText(
      (await renderCvPdf(FAKE_HEADER, applyTrim(validCv(), 0), fakeDateOf)).bytes,
      'pdf',
    );
    expect(pdf).toContain(contact);
  });

  async function docxParts(spec = baseSpec(10.5)) {
    const zip = await JSZip.loadAsync(
      await renderCvDocx(FAKE_HEADER, applyTrim(validCv(), 0), fakeDateOf, spec),
    );
    return {
      styles: (await zip.file('word/styles.xml')?.async('string')) ?? '',
      body: (await zip.file('word/document.xml')?.async('string')) ?? '',
    };
  }

  it('overrides the built-in Title and Heading styles: black, Arial, our sizes, kept with the next paragraph', async () => {
    const { styles } = await docxParts();
    expect(styles).not.toMatch(/2E74B5|1F4D78|365F91|4F81BD/i);
    for (const id of ['Title', 'Heading1', 'Heading2']) {
      const style = new RegExp(`<w:style [^>]*w:styleId="${id}".*?</w:style>`, 's').exec(
        styles,
      )?.[0];
      expect(style, id).toBeDefined();
      expect(style).toContain('<w:color w:val="000000"/>');
      expect(style).toContain('w:ascii="Arial"');
      expect(style).toContain('<w:keepNext/>');
      expect(style).toContain('<w:b/>');
    }
    const sizeOf = (id: string) =>
      /<w:sz w:val="(\d+)"/.exec(
        new RegExp(`w:styleId="${id}".*?</w:style>`, 's').exec(styles)?.[0] ?? '',
      )?.[1];
    expect(sizeOf('Title')).toBe('36');
    expect(sizeOf('Heading1')).toBe('23');
    expect(sizeOf('Heading2')).toBe('22');
    expect(styles).not.toMatch(/<w:color w:val="(?!000000")/);
  });

  it('writes the spec spacing in twips, the same numbers the PDF used', async () => {
    const spec = {
      ...baseSpec(10.5),
      sectionGapScale: 1.3,
      bulletGapScale: 1.45,
      leadingScale: 1.04,
    };
    const { body } = await docxParts(spec);
    const styles = resolveStyles(spec);
    const twips = (points: number) => String(Math.round(points * 20));
    const paragraphs = body.match(/<w:p>.*?<\/w:p>/gs) ?? [];
    const spacingOf = (needle: string) =>
      paragraphs.find((p) => p.includes(needle))?.match(/<w:spacing ([^/]*)\/>/)?.[1] ?? '';
    const section = spacingOf('>EXPERIENCE<');
    expect(section).toContain(`w:before="${twips(styles.section.before)}"`);
    expect(section).toContain(`w:after="${twips(styles.section.after)}"`);
    expect(section).toContain(`w:line="${twips(styles.section.leading)}"`);
    const bullet = spacingOf('Led onboarding for 12 clients.');
    expect(bullet).toContain(`w:after="${twips(styles.bullet.after)}"`);
    expect(bullet).toContain(`w:line="${twips(styles.bullet.leading)}"`);
    expect(bullet).toContain('w:lineRule="exact"');
  });

  it('writes a bold role and a regular organisation, and centres the header', async () => {
    const { body } = await docxParts();
    const paragraphs = body.match(/<w:p>.*?<\/w:p>/gs) ?? [];
    const entry = paragraphs.find((p) => p.includes('Example Cloud Ltd</w:t>')) ?? '';
    const runs = entry.match(/<w:r>.*?<\/w:r>/gs) ?? [];
    expect(runs[0]).toContain('<w:b/>');
    expect(runs[0]).toContain('Customer Onboarding Intern</w:t>');
    expect(runs[1]).not.toContain('<w:b/>');
    expect(runs[1]).toContain(', Example Cloud Ltd</w:t>');
    // The dates are regular too.
    expect(runs[runs.length - 1]).not.toContain('<w:b/>');
    const name = paragraphs.find((p) => p.includes('Alex Example</w:t>')) ?? '';
    expect(name).toContain('<w:jc w:val="center"/>');
    const contact = paragraphs.find((p) => p.includes('alex@example.com')) ?? '';
    expect(contact).toContain('<w:jc w:val="center"/>');
  });

  it('writes the same text as the PDF for the spread layout too', async () => {
    const fit = await fitPage(FAKE_HEADER, fullCv(), fakeDateOf);
    if (!fit.ok) throw new Error('did not fit');
    const docx = await renderCvDocx(FAKE_HEADER, fit.content, fakeDateOf, fit.spec);
    const pdf = await extractText(fit.bytes, 'pdf');
    const order = readingOrder(fit.content);
    expectInOrder(await extractText(docx, 'docx'), order);
    expectInOrder(pdf, order);
    const zip = await JSZip.loadAsync(docx);
    expect(Object.keys(zip.files).filter((name) => /media\/|header|footer/.test(name))).toEqual([]);
  });

  it('draws the dates on the title’s last line in the PDF', async () => {
    const cv = structuredClone(validCv());
    const entry = cv.experience[0];
    if (entry === undefined) throw new Error('fixture');
    entry.heading.role = filler(80, 1);
    entry.heading.org = 'Example Cloud Ltd';
    const fit = await fitPage(FAKE_HEADER, cv, fakeDateOf);
    if (!fit.ok) throw new Error('did not fit');
    const text = await extractText(fit.bytes, 'pdf');
    const lines = text.split('\n');
    const at = lines.findIndex((line) => line.includes('Oct 2023 – May 2024'));
    expect(at).toBeGreaterThan(0);
    // The line before the dates is part of the title, and the title's end shares the dates' line.
    expect(lines[at]).toContain('Ltd');
    expect(lines[at - 1] ?? '').not.toContain('Ltd');
  });
});
