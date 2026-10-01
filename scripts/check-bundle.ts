/**
 * Web bundle budget (ADR-021, PRD R7 "usable in < 2 s on 4G"), run after `npm run build`:
 * - no JS chunk over 500 kB minified (Vite's own warning threshold);
 * - the JS every visit loads (the entry script plus its modulepreloads) stays under the
 *   gzip budget. Lazy screens and the Functions/Storage SDKs don't count.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const DIST = 'web/dist';
const MAX_CHUNK_BYTES = 500 * 1000;
const MAX_INITIAL_GZIP_BYTES = 310 * 1000;

const kB = (bytes: number) => `${(bytes / 1000).toFixed(1)} kB`;
const failures: string[] = [];

const chunks = readdirSync(join(DIST, 'assets')).filter((name) => name.endsWith('.js'));
for (const name of chunks) {
  const size = readFileSync(join(DIST, 'assets', name)).length;
  if (size > MAX_CHUNK_BYTES) failures.push(`${name} is ${kB(size)} (max ${kB(MAX_CHUNK_BYTES)})`);
}

const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const initial = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.js)"/g)].map((m) => m[1] ?? '');
if (initial.length === 0) failures.push('index.html loads no JS: is web/dist built?');
const initialGzip = initial.reduce(
  (sum, path) => sum + gzipSync(readFileSync(join(DIST, path))).length,
  0,
);
if (initialGzip > MAX_INITIAL_GZIP_BYTES) {
  failures.push(`initial JS is ${kB(initialGzip)} gzip (max ${kB(MAX_INITIAL_GZIP_BYTES)})`);
}

if (failures.length > 0) {
  console.error(`check-bundle: over budget\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(
  `check-bundle: ${String(chunks.length)} chunks, initial JS ${kB(initialGzip)} gzip in ${String(initial.length)} files`,
);
