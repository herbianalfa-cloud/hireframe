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

import { CV_ALIASES, CV_FACTS, validCv } from '../../../../packages/shared/src/fixtures/cv.js';
import { extractText } from '../extract.js';
import {
  CvRenderError,
  fitOnePage,
  renderCvDocx,
  renderCvPdf,
  renderNoteDocx,
  renderNotePdf,
} from './index.js';
import { FAKE_HEADER, fakeDateOf, filler, maxCv } from './fixtures.js';

const squash = (text: string) => text.replace(/\s+/g, ' ');

/** Every part appears in `text`, each after the one before. */
function expectInOrder(text: string, parts: readonly string[]): void {
  const flat = squash(text);
  let from = 0;
  for (const part of parts) {
    const at = flat.indexOf(squash(part), from);
    expect(at, `"${part.slice(0, 40)}" in order`).toBeGreaterThanOrEqual(from);
    from = at + part.length;
  }
}

/** The texts a reader should meet, top to bottom, for a CV rendered with `fakeDateOf`. */
function readingOrder(content: TrimmedCvContent): string[] {
  const parts: string[] = [FAKE_HEADER.name, FAKE_HEADER.email];
  if (content.summary !== null) parts.push('Summary', content.summary.text);
  for (const [title, entries] of [
    ['Experience', content.experience],
    ['Projects', content.projects],
  ] as const) {
    if (entries.length === 0) continue;
    parts.push(title);
    for (const entry of entries) {
      parts.push(`${entry.heading.role}, ${entry.heading.org}`);
      for (const bullet of entry.bullets) parts.push(bullet.text);
    }
  }
  parts.push('Education', ...content.education.map((line) => line.line));
  parts.push('Skills', ...content.skills.map((skill) => skill.label));
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
      `${FAKE_HEADER.email}  |  ${FAKE_HEADER.phone ?? ''}  |  ${FAKE_HEADER.location ?? ''}  |  ${FAKE_HEADER.links?.[0] ?? ''}`,
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
    expect(text).not.toContain('Summary');
    expect(text).toContain('Experience');
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

describe('renderCvDocx', () => {
  const content = applyTrim(validCv(), 0);

  it('has every heading and bullet in order', async () => {
    const bytes = await renderCvDocx(FAKE_HEADER, content, fakeDateOf);
    expectInOrder(await extractText(bytes, 'docx'), readingOrder(content));
  });

  it('uses real headings and real bullets', async () => {
    const bytes = await renderCvDocx(FAKE_HEADER, content, fakeDateOf);
    const { value: html } = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
    expect(html).toContain('<h1><strong>Experience</strong></h1>');
    expect(html).toContain('<h2><strong>Customer Onboarding Intern, Example Cloud Ltd');
    expect(html).toContain('<ul><li>Led onboarding for 12 clients.</li>');
    expect(html).not.toContain('<table');
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

describe('fitOnePage', () => {
  it('leaves a CV that fits untouched', async () => {
    const fit = await fitOnePage(FAKE_HEADER, validCv(), fakeDateOf);
    expect(fit.ok && fit.trimmed).toBe(0);
    expect(fit.ok && fit.content).toEqual(applyTrim(validCv(), 0));
  });

  it('trims a CV that is too long, one step at a time, until it fits', async () => {
    const content = maxCv();
    const full = await renderCvPdf(FAKE_HEADER, applyTrim(content, 0), fakeDateOf);
    expect(full.pages).toBeGreaterThan(1);
    const fit = await fitOnePage(FAKE_HEADER, content, fakeDateOf);
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
    const fit = await fitOnePage(FAKE_HEADER, content, fakeDateOf);
    if (!fit.ok) throw new Error('maximum content did not fit');
    expect(fit.trimmed).toBeGreaterThan(0);
    expect(await pageCount(fit.bytes)).toBe(1);
    // Headings and education are never trimmed.
    expect(fit.content.experience.map((entry) => entry.heading)).toEqual(
      content.experience.map((entry) => entry.heading),
    );
    expect(fit.content.education).toEqual(content.education);
    expectInOrder(await extractText(fit.bytes, 'pdf'), readingOrder(fit.content).slice(0, -1));
  });

  it('also fits the maximum content in the DOCX at the same trim', async () => {
    const fit = await fitOnePage(FAKE_HEADER, maxCv(), fakeDateOf);
    if (!fit.ok) throw new Error('did not fit');
    const docx = await renderCvDocx(FAKE_HEADER, fit.content, fakeDateOf);
    expectInOrder(await extractText(docx, 'docx'), readingOrder(fit.content).slice(0, -1));
  });

  it('reports too_long when even the fully trimmed CV is over a page', async () => {
    const huge = maxCv();
    // Beyond the schema's limits on purpose: thirty experience headings cannot fit one page,
    // and headings are never trimmed.
    huge.experience = Array.from({ length: 30 }, (_, i) => ({
      heading: { role: filler(80, i), org: filler(80, i + 1), factRef: 'F1' },
      bullets: [],
    }));
    expect(await fitOnePage(FAKE_HEADER, huge, fakeDateOf)).toEqual({
      ok: false,
      code: 'too_long',
    });
  });

  it('renders content the validator accepted, with the cited facts the document stores', async () => {
    const content: CvContent = validCv();
    expect(validateCv(content, CV_ALIASES, CV_FACTS)).toEqual({ ok: true });
    const fit = await fitOnePage(FAKE_HEADER, content, fakeDateOf);
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
      'Dear hiring team,',
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
