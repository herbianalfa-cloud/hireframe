/**
 * Web bundle budget (ADR-021, PRD R7 "usable in < 2 s on 4G"), run after `npm run build`:
 * - no JS chunk over 500 kB minified (Vite's own warning threshold);
 * - the JS every visit loads (the entry script plus its modulepreloads) stays under the
 *   gzip budget. Lazy screens and the Functions/Storage SDKs don't count.
 * - the dev-only Firestore read counter (C5) is tree-shaken: its warning text is in no chunk.
 * - Firestore (ADR-066) is in no initial file and in exactly one chunk, under its own gzip cap.
 * It prints each initial file's gzip size, largest first.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { READ_WARNING } from '../web/src/services/read-warning.ts';

// `CHECK_BUNDLE_DIST` points the check at another folder (the script's own tests use it).
const DIST = process.env.CHECK_BUNDLE_DIST ?? 'web/dist';
const MAX_CHUNK_BYTES = 500 * 1000;
const MAX_INITIAL_GZIP_BYTES = 200 * 1000;
// The Firestore SDK loads once the Firebase core is up (ADR-066). Its RPC service path is only in
// the SDK, so it finds the chunk whatever the chunk is named; it appears in exactly one chunk.
const FIRESTORE_MARKER = 'google.firestore.v1.Firestore';
const MAX_FIRESTORE_GZIP_BYTES = 165 * 1000;

const kB = (bytes: number) => `${(bytes / 1000).toFixed(1)} kB`;
const failures: string[] = [];

const firestoreChunks: string[] = [];
const chunks = readdirSync(join(DIST, 'assets')).filter((name) => name.endsWith('.js'));
for (const name of chunks) {
  const size = readFileSync(join(DIST, 'assets', name)).length;
  if (size > MAX_CHUNK_BYTES) failures.push(`${name} is ${kB(size)} (max ${kB(MAX_CHUNK_BYTES)})`);
  const text = readFileSync(join(DIST, 'assets', name), 'utf8');
  if (text.includes(READ_WARNING)) {
    failures.push(`${name} contains the dev-only read counter's warning (C5)`);
  }
  if (text.includes(FIRESTORE_MARKER)) firestoreChunks.push(name);
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
const initialSizes = initial.map((path) => ({
  path,
  gzip: gzipSync(readFileSync(join(DIST, path))).length,
}));
const initialGzip = initialSizes.reduce((sum, file) => sum + file.gzip, 0);
if (initialGzip > MAX_INITIAL_GZIP_BYTES) {
  failures.push(`initial JS is ${kB(initialGzip)} gzip (max ${kB(MAX_INITIAL_GZIP_BYTES)})`);
}

for (const { path } of initialSizes) {
  if (firestoreChunks.includes(path.replace(/^assets\//, ''))) {
    failures.push(`${path} is initial JS and contains the Firestore SDK (ADR-066)`);
  }
}
let firestoreGzip = 0;
if (firestoreChunks.length !== 1) {
  failures.push(
    `expected the Firestore SDK in exactly one chunk, found ${String(firestoreChunks.length)} (ADR-066)`,
  );
} else {
  firestoreGzip = gzipSync(readFileSync(join(DIST, 'assets', firestoreChunks[0] ?? ''))).length;
  if (firestoreGzip > MAX_FIRESTORE_GZIP_BYTES) {
    failures.push(
      `the Firestore chunk is ${kB(firestoreGzip)} gzip (max ${kB(MAX_FIRESTORE_GZIP_BYTES)})`,
    );
  }
}

if (failures.length > 0) {
  console.error(`check-bundle: over budget\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
// Per-file breakdown (largest first), so a creeping dependency is easy to spot.
for (const { path, gzip } of [...initialSizes].sort((a, b) => b.gzip - a.gzip)) {
  console.log(`  ${kB(gzip).padStart(9)} gzip  ${path}`);
}
console.log(`  ${kB(firestoreGzip).padStart(9)} gzip  Firestore (loaded after the core)`);
console.log(
  `check-bundle: ${String(chunks.length)} chunks, initial JS ${kB(initialGzip)} gzip in ${String(initial.length)} files`,
);
