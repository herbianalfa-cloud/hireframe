/**
 * Bundles the Gmail bridge for Apps Script (ADR-046): esbuild → `apps-script/build/Code.js` plus
 * `appsscript.json`, ready for `npm exec -w apps-script clasp -- push` (docs/RUNBOOK.md Part G). Apps Script calls
 * top-level functions by name, so the footer defines `run` and `setup` as plain globals over the
 * bundle's exports.
 */
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'apps-script');
const out = join(dir, 'build');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(dir, 'src/main.ts')],
  outfile: join(out, 'Code.js'),
  bundle: true,
  format: 'iife',
  globalName: 'hireframeBridge',
  platform: 'neutral',
  target: 'es2022',
  conditions: ['source'],
  logLevel: 'warning',
  footer: {
    js: 'function run() { hireframeBridge.run(); }\nfunction setup() { hireframeBridge.setup(); }\n',
  },
});
copyFileSync(join(dir, 'appsscript.json'), join(out, 'appsscript.json'));
console.log(`build-apps-script: wrote ${out}`);
