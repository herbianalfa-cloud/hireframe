/**
 * Writes the fake CV (and a revised copy that rewords one claim) as PDF and DOCX to
 * `tmp/fixtures/`, for uploading in `npm run dev`. Fake data only; `tmp/` is gitignored.
 */
import { mkdirSync, writeFileSync } from 'node:fs';

import { makeDocx, makePdf } from '../functions/src/fixtures/fake-cv-files.ts';
import { FAKE_CV_LINES, FAKE_CV_REVISED_LINES } from '../functions/src/fixtures/fake-cv-text.ts';

const outDir = 'tmp/fixtures';
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/fake-cv.pdf`, makePdf(FAKE_CV_LINES));
writeFileSync(`${outDir}/fake-cv.docx`, await makeDocx(FAKE_CV_LINES));
writeFileSync(`${outDir}/fake-cv-revised.pdf`, makePdf(FAKE_CV_REVISED_LINES));
writeFileSync(`${outDir}/fake-cv-revised.docx`, await makeDocx(FAKE_CV_REVISED_LINES));
console.log(`make-cv-fixtures: wrote fake CVs to ${outDir}/`);
