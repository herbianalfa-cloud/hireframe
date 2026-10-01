import JSZip from 'jszip';

/**
 * Builds real PDF and DOCX files from fake CV lines (tests and `node scripts/make-cv-fixtures.ts`),
 * so no binary fixtures are committed. Test-only: never imported by function code.
 */

function escapePdfText(line: string): string {
  if (!/^[\x20-\x7e]*$/.test(line)) throw new Error('PDF fixture lines must be printable ASCII.');
  return line.replace(/[\\()]/g, (char) => `\\${char}`);
}

/** A minimal uncompressed PDF: Helvetica 10pt, 50 lines per A4 page. */
export function makePdf(lines: readonly string[]): Uint8Array {
  const perPage = 50;
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));

  const objects: string[] = [];
  const add = (body: string) => objects.push(body); // returns the 1-based object number
  const catalog = add('');
  const pagesObj = add('');
  const font = add(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  );
  const pageNumbers: number[] = [];
  for (const pageLines of pages) {
    const stream = `BT /F1 10 Tf 14 TL 50 800 Td ${pageLines.map((line) => `(${escapePdfText(line)}) Tj T*`).join(' ')} ET`;
    const content = add(
      `<< /Length ${String(Buffer.byteLength(stream))} >>\nstream\n${stream}\nendstream`,
    );
    pageNumbers.push(
      add(
        `<< /Type /Page /Parent ${String(pagesObj)} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${String(font)} 0 R >> >> /Contents ${String(content)} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${String(pagesObj)} 0 R >>`;
  objects[pagesObj - 1] =
    `<< /Type /Pages /Kids [${pageNumbers.map((n) => `${String(n)} 0 R`).join(' ')}] /Count ${String(pageNumbers.length)} >>`;

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${String(index + 1)} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${String(objects.length + 1)} /Root ${String(catalog)} 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (char) => `&#${String(char.charCodeAt(0))};`);
}

/** A minimal DOCX: one paragraph per line. */
export async function makeDocx(lines: readonly string[]): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  const paragraphs = lines
    .map((line) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`)
    .join('');
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'uint8array' });
}
