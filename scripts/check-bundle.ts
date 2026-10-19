/**
 * Web bundle budget (ADR-021, PRD R7 "usable in < 2 s on 4G"), run after `npm run build`:
 * - no JS chunk over 500 kB minified (Vite's own warning threshold);
 * - the JS every visit loads (the entry script plus its modulepreloads) stays under the
 *   gzip budget. Lazy screens and the Functions/Storage SDKs don't count.
 * - the dev-only Firestore read counter (C5) is tree-shaken: its warning text is in no chunk.
 * - the CV preview's pdf.js (ADR-065) is lazy: no initial file contains it. Its worker is the one
 *   named exception to the chunk rule, with its own cap, and its standard fonts have caps too.
 * It prints each initial file's gzip size, largest first.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { READ_WARNING } from '../web/src/services/read-warning.ts';

// `CHECK_BUNDLE_DIST` points the check at another folder (the script's own tests use it).
const DIST = process.env.CHECK_BUNDLE_DIST ?? 'web/dist';
const MAX_CHUNK_BYTES = 500 * 1000;
const MAX_INITIAL_GZIP_BYTES = 300 * 1000;
// The pdf.js worker (legacy build, pinned) was 1,321 kB minified when measured; the cap leaves
// room for a patch bump, not for a different build. Fonts: largest file 162 kB, 798 kB in all (14 fonts and 2 licence files).
const WORKER_PATTERN = /^pdf\.worker\.min-.+\.mjs$/;
const MAX_WORKER_BYTES = 1400 * 1000;
const FONTS_PATTERN = /^pdfjs-[\d.]+$/;
const MAX_FONT_FILE_BYTES = 200 * 1000;
const MAX_FONTS_TOTAL_BYTES = 900 * 1000;
// `PDFWorker` is a pdf.js class name that minification keeps and our adapter never contains
// (it does carry `GlobalWorkerOptions`, so that one would match the adapter as well).
const PDFJS_MARKER = 'PDFWorker';

const kB = (bytes: number) => `${(bytes / 1000).toFixed(1)} kB`;
const failures: string[] = [];

// `.mjs` is scanned too, so the pdf.js worker can't slip past the chunk rule unnamed.
const chunks = readdirSync(join(DIST, 'assets')).filter((name) => /\.m?js$/.test(name));
const workers = chunks.filter((name) => WORKER_PATTERN.test(name));
if (workers.length !== 1) {
  failures.push(`expected exactly one pdf.js worker asset, found ${String(workers.length)}`);
}
const pdfjsChunks: string[] = [];
for (const name of chunks) {
  const text = readFileSync(join(DIST, 'assets', name), 'utf8');
  const size = Buffer.byteLength(text);
  const isWorker = WORKER_PATTERN.test(name);
  const isPdfjs = !isWorker && text.includes(PDFJS_MARKER);
  if (isPdfjs) pdfjsChunks.push(name);
  const max = isWorker ? MAX_WORKER_BYTES : MAX_CHUNK_BYTES;
  if (size > max) {
    failures.push(
      isPdfjs
        ? `${name} is ${kB(size)} (max ${kB(max)}): this is the pdf.js chunk, so a pdf.js bump grew it; see ADR-065 for what to do (investigate, or raise a named cap)`
        : `${name} is ${kB(size)} (max ${kB(max)})`,
    );
  }
  if (text.includes(READ_WARNING)) {
    failures.push(`${name} contains the dev-only read counter's warning (C5)`);
  }
}

const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const initial = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.m?js)"/g)].map(
  (m) => m[1] ?? '',
);
if (initial.length === 0) failures.push('index.html loads no JS: is web/dist built?');
// The Firebase config fetch must start from the HTML, before the entry script (ADR-061).
const preloadAt = html.search(/<link[^>]*rel="preload"[^>]*href="\/__\/firebase\/init\.json"/);
const entryAt = html.search(/<script[^>]*type="module"/);
if (preloadAt === -1) {
  failures.push('index.html has no preload for /__/firebase/init.json (ADR-061)');
} else if (entryAt !== -1 && preloadAt > entryAt) {
  failures.push('the init.json preload comes after the entry script (ADR-061)');
}
for (const path of initial) {
  if (readFileSync(join(DIST, path), 'utf8').includes(PDFJS_MARKER)) {
    failures.push(`${path} contains pdf.js: the CV preview must stay lazy (ADR-065)`);
  }
}
// The marker must exist in exactly one lazy chunk, or the initial-file scan below proves nothing.
if (pdfjsChunks.length !== 1) {
  failures.push(
    `expected exactly one lazy chunk with the pdf.js marker "${PDFJS_MARKER}", found ${String(pdfjsChunks.length)}: has pdf.js changed? (ADR-065)`,
  );
}
if (/pdf\.worker|pdfjs-[\d.]+\/standard_fonts/.test(html)) {
  failures.push('index.html references the pdf.js worker or fonts: the CV preview must stay lazy');
}
const fontFolders = readdirSync(join(DIST, 'assets')).filter((name) => FONTS_PATTERN.test(name));
if (fontFolders.length !== 1) {
  failures.push(`expected exactly one pdf.js fonts folder, found ${String(fontFolders.length)}`);
}
let fontsTotal = 0;
for (const folder of fontFolders) {
  const dir = join(DIST, 'assets', folder, 'standard_fonts');
  if (!existsSync(dir)) {
    failures.push(`${folder} has no standard_fonts folder: the fonts plugin broke (ADR-065)`);
    continue;
  }
  for (const name of readdirSync(dir)) {
    const size = readFileSync(join(dir, name)).length;
    fontsTotal += size;
    if (size > MAX_FONT_FILE_BYTES) {
      failures.push(`${folder}/${name} is ${kB(size)} (max ${kB(MAX_FONT_FILE_BYTES)})`);
    }
  }
}
if (fontsTotal > MAX_FONTS_TOTAL_BYTES) {
  failures.push(`pdf.js fonts total ${kB(fontsTotal)} (max ${kB(MAX_FONTS_TOTAL_BYTES)})`);
}
const initialSizes = initial.map((path) => ({
  path,
  gzip: gzipSync(readFileSync(join(DIST, path))).length,
}));
const initialGzip = initialSizes.reduce((sum, file) => sum + file.gzip, 0);
if (initialGzip > MAX_INITIAL_GZIP_BYTES) {
  failures.push(`initial JS is ${kB(initialGzip)} gzip (max ${kB(MAX_INITIAL_GZIP_BYTES)})`);
}

if (failures.length > 0) {
  console.error(`check-bundle: over budget\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
// Per-file breakdown (largest first), so a creeping dependency is easy to spot.
for (const { path, gzip } of [...initialSizes].sort((a, b) => b.gzip - a.gzip)) {
  console.log(`  ${kB(gzip).padStart(9)} gzip  ${path}`);
}
const workerBytes = workers.reduce(
  (sum, name) => sum + readFileSync(join(DIST, 'assets', name)).length,
  0,
);
console.log(
  `  lazy: pdf.js worker ${kB(workerBytes)} (cap ${kB(MAX_WORKER_BYTES)}), fonts ${kB(fontsTotal)} (cap ${kB(MAX_FONTS_TOTAL_BYTES)})`,
);
console.log(
  `check-bundle: ${String(chunks.length)} chunks, initial JS ${kB(initialGzip)} gzip in ${String(initial.length)} files`,
);
