/**
 * Bundles Cloud Functions for deploy (ADR-017). Cloud Build can't install the workspace package
 * `@hireframe/shared`, so esbuild inlines it with the pure-JS dependencies into
 * `functions/deploy/index.js`. Only `firebase-functions` and `firebase-admin` stay external;
 * the generated `functions/deploy/package.json` pins them to the exact versions in
 * functions/package.json. `firebase.json` deploys from `functions/deploy`.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const functionsDir = join(root, 'functions');
const outDir = join(functionsDir, 'deploy');

const EXTERNAL = ['firebase-functions', 'firebase-admin'] as const;

interface FunctionsPackage {
  dependencies: Record<string, string>;
  engines?: Record<string, string>;
}

const pkg = JSON.parse(
  readFileSync(join(functionsDir, 'package.json'), 'utf8'),
) as FunctionsPackage;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(functionsDir, 'src/index.ts')],
  outfile: join(outDir, 'index.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  conditions: ['source'],
  external: EXTERNAL.flatMap((name) => [name, `${name}/*`]),
  sourcemap: 'linked',
  legalComments: 'linked',
  logLevel: 'warning',
  // Bundled CommonJS dependencies call require(); give the ES module one.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});

const dependencies = Object.fromEntries(
  EXTERNAL.map((name) => {
    const version = pkg.dependencies[name];
    if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
      throw new Error(`functions/package.json must pin ${name} to an exact version.`);
    }
    return [name, version];
  }),
);

writeFileSync(
  join(outDir, 'package.json'),
  `${JSON.stringify(
    {
      name: 'hireframe-functions-deploy',
      private: true,
      type: 'module',
      main: 'index.js',
      engines: { node: '22' },
      dependencies,
    },
    null,
    2,
  )}\n`,
);

console.log(`build-functions: wrote ${outDir}`);
