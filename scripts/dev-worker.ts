/**
 * `node scripts/dev-worker.ts`: one pass of the CV worker against the running emulators (M7 7D.2).
 * The Functions emulator doesn't fire schedules, so this stands in for `generateCvs`: it turns
 * every `generating` application into a CV, with the fake model unless LIVE=1. It refuses any
 * project that isn't `demo-*`. Bundles functions/src/applications/dev-worker.ts with esbuild (the
 * functions sources use `.js` import paths Node can't resolve to `.ts`), as `npm run eval` does.
 */
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const outfile = 'tmp/dev-worker.mjs';
mkdirSync('tmp', { recursive: true });
await build({
  entryPoints: ['functions/src/applications/dev-worker.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  conditions: ['source'],
  outfile,
  logLevel: 'warning',
  external: ['firebase-admin', 'firebase-admin/*', 'firebase-functions', 'firebase-functions/*'],
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
const worker = (await import(pathToFileURL(outfile).href)) as {
  runDevWorker: () => Promise<Record<string, unknown>>;
};
const summary = await worker.runDevWorker();
console.log(`dev-worker: ${JSON.stringify(summary)}`);
