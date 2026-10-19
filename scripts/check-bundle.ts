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
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { READ_WARNING } from '../web/src/services/read-warning.ts';

const DIST = 'web/dist';
const MAX_CHUNK_BYTES = 500 * 1000;
const MAX_INITIAL_GZIP_BYTES = 300 * 1000;
// The pdf.js worker (legacy build, pinned) was 1,321 kB minified when measured; the cap leaves
// room for a patch bump, not for a different build. Fonts: largest file 162 kB, all 816 kB.
const WORKER_PATTERN = /^pdf\.worker\.min-.+\.mjs$/;
const MAX_WORKER_BYTES = 1400 * 1000;
const FONTS_PATTERN = /^pdfjs-[\d.]+$/;
const MAX_FONT_FILE_BYTES = 200 * 1000;
const MAX_FONTS_TOTAL_BYTES = 900 * 1000;
// `GlobalWorkerOptions` is a property name, so minification keeps it: it marks pdf.js code.
const PDFJS_MARKER = 'GlobalWorkerOptions';

const kB = (bytes: number) => `${(bytes / 1000).toFixed(1)} kB`;
const failures: string[] = [];

// `.mjs` is scanned too, so the pdf.js worker can't slip past the chunk rule unnamed.
const chunks = readdirSync(join(DIST, 'assets')).filter((name) => /\.m?js$/.test(name));
const workers = chunks.filter((name) => WORKER_PATTERN.test(name));
if (workers.length !== 1) {
  failures.push(`expected exactly one pdf.js worker asset, found ${String(workers.length)}`);
}
for (const name of chunks) {
  const size = readFileSync(join(DIST, 'assets', name)).length;
  const isWorker = WORKER_PATTERN.test(name);
  const max = isWorker ? MAX_WORKER_BYTES : MAX_CHUNK_BYTES;
  if (size > max) failures.push(`${name} is ${kB(size)} (max ${kB(max)})`);
  if (readFileSync(join(DIST, 'assets', name), 'utf8').includes(READ_WARNING)) {
    failures.push(`${name} contains the dev-only read counter's warning (C5)`);
  }
}

const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const initial = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.js)"/g)].map((m) => m[1] ?? '');
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
