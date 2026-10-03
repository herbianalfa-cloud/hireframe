/**
 * Watchlist ATS detection (ADR-031). Bundles functions/src/watchlist/detect-cli.ts with esbuild
 * (the functions sources use `.js` import paths Node can't resolve to `.ts`) and runs it:
 *   node scripts/detect-ats.ts tmp/watchlist-candidates.csv   → tmp/watchlist-review.csv
 *   node scripts/detect-ats.ts --write tmp/watchlist-review.csv → packages/shared/src/watchlist-seed.ts
 * Calls only the official job-board APIs (Greenhouse, Lever, Ashby, Workable), 1 request per
 * second per host, with the HireframeBot User-Agent. Never fetches careers pages.
 */
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const outfile = 'tmp/detect-ats.mjs';
mkdirSync('tmp', { recursive: true });
await build({
  entryPoints: ['functions/src/watchlist/detect-cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  conditions: ['source'],
  outfile,
  logLevel: 'warning',
});
const cli = (await import(pathToFileURL(outfile).href)) as {
  main: (args: readonly string[]) => Promise<void>;
};
await cli.main(process.argv.slice(2));
