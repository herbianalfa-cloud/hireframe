/**
 * `node scripts/load-test.ts [--jobs 1000] [--s1-passes 105]` (docs/plans/m8b-plan.md B4).
 * A 1,000-job scan and funnel run against its own Firestore and Storage emulators with fake data,
 * then a wipe of what it made. It takes about ten minutes, because the run's deadlines are real.
 * It never uses the network or a live model, refuses LIVE=1 and any project not `demo-*`, and
 * refuses to start while the emulator ports are busy (stop `npm run dev` first), so it can never
 * touch dev data. Needs Java 21 for the emulators. Bundles functions/src/loadtest/run.ts with
 * esbuild, as dev-worker does.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createConnection } from 'node:net';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

import { parseLoadTestArgs } from '../functions/src/loadtest/args.ts';

const PROJECT = 'demo-hireframe-load';
const PORTS = [8080, 9199];
const INNER = 'LOAD_TEST_INNER';

function portBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      resolve(false);
    });
  });
}

const args = parseLoadTestArgs(process.argv.slice(2));

if (process.env.LIVE === '1') {
  console.error('load-test: never live. Unset LIVE.');
  process.exit(2);
}

if (process.env[INNER] !== '1') {
  for (const port of PORTS) {
    if (await portBusy(port)) {
      console.error(
        `load-test: port ${String(port)} is busy. Stop \`npm run dev\` and any emulators, then run it again.`,
      );
      process.exit(2);
    }
  }
  const forwarded = process.argv.slice(2).join(' ');
  const result = spawnSync(
    'npx',
    [
      'firebase',
      'emulators:exec',
      '--only',
      'firestore,storage',
      '--project',
      PROJECT,
      `${INNER}=1 node scripts/load-test.ts ${forwarded}`,
    ],
    { stdio: 'inherit' },
  );
  process.exit(result.status ?? 1);
}

// Inside the emulators.
process.env.GCLOUD_PROJECT = PROJECT;
const outfile = 'tmp/load-test.mjs';
mkdirSync('tmp', { recursive: true });
await build({
  entryPoints: ['functions/src/loadtest/run.ts'],
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
const loadTest = (await import(
  pathToFileURL(outfile).href
)) as typeof import('../functions/src/loadtest/run.ts');
const { table, checks } = await loadTest.runLoadTest(args);
console.log(table);
process.exit(checks.every((check) => check.pass) ? 0 : 1);
