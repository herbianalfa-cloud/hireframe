import type { CvKind } from '@hireframe/shared';
import mammoth from 'mammoth';
import { extractText as extractPdfText, getDocumentProxy } from 'unpdf';

/**
 * CV text extraction (ADR-018). The file type comes from its first bytes, never from the
 * client's content type or file name.
 */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // PK.. (DOCX is a zip)

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return magic.every((byte, index) => bytes[index] === byte);
}

export function detectKind(bytes: Uint8Array): CvKind | null {
  if (startsWith(bytes, PDF_MAGIC)) return 'pdf';
  if (startsWith(bytes, ZIP_MAGIC)) return 'docx';
  return null;
}

export async function extractText(bytes: Uint8Array, kind: CvKind): Promise<string> {
  if (kind === 'pdf') {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractPdfText(pdf, { mergePages: true });
    return text;
  }
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  return value;
}
