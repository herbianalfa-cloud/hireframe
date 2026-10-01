import { fileURLToPath } from 'node:url';

import { defaultClientConditions } from 'vite';
import { defineConfig } from 'vitest/config';

// `source` resolves `@hireframe/shared` to its TypeScript sources (ADR-012).
function withSource(conditions: readonly string[]) {
  const all = ['source', ...conditions];
  return { resolve: { conditions: all }, ssr: { resolve: { conditions: all } } };
}

// Node-side projects resolve packages the way Node does at runtime. Vite's server default
// includes `module`, which picks ESM builds Node itself can't load (e.g. @opentelemetry/api,
// pulled in by firebase-functions).
const NODE_CONDITIONS = ['node'];

const workspaces = {
  shared: 'packages/shared',
  functions: 'functions',
};

export default defineConfig({
  test: {
    projects: [
      ...Object.entries(workspaces).map(([name, dir]) => ({
        ...withSource(NODE_CONDITIONS),
        test: { name, include: [`${dir}/src/**/*.test.ts`] },
      })),
      {
        ...withSource(defaultClientConditions),
        resolve: {
          ...withSource(defaultClientConditions).resolve,
          alias: { '@': fileURLToPath(new URL('./web/src', import.meta.url)) },
        },
        test: {
          name: 'web',
          include: ['web/src/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['web/src/test/setup.ts'],
        },
      },
      {
        ...withSource(NODE_CONDITIONS),
        test: { name: 'scripts', include: ['scripts/**/*.test.ts'] },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'functions/src/**', 'web/src/**', 'scripts/**'],
    },
  },
});
