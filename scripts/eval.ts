/**
 * `npm run eval` (FUNNEL.md "Evals", ADR-036): bundles functions/src/eval/cli.ts with esbuild (the
 * functions sources use `.js` import paths Node can't resolve to `.ts`) and runs it.
 *   npm run eval                          replay evals/recordings.jsonl (CI; no API key)
 *   LIVE=1 npm run eval                   call the API and refresh the recordings (local only)
 *   npm run eval -- --update-baseline     also store the agreement as the new floor
 */
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const outfile = 'tmp/eval.mjs';
mkdirSync('tmp', { recursive: true });
await build({
  entryPoints: ['functions/src/eval/cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  conditions: ['source'],
  outfile,
  logLevel: 'warning',
  // Loaded from node_modules at run time: they're only reached through shared modules (the
  // logger, Timestamp conversion), and bundling their CommonJS internals breaks under ESM.
  external: ['firebase-admin', 'firebase-admin/*', 'firebase-functions', 'firebase-functions/*'],
});
const cli = (await import(pathToFileURL(outfile).href)) as {
  main: (args: readonly string[]) => Promise<void>;
};
await cli.main(process.argv.slice(2));
