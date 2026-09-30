import { fileURLToPath } from 'node:url';

import { defaultClientConditions, defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

// `source` resolves `@hireframe/shared` to its TypeScript sources (ADR-012).
function withSource(conditions: readonly string[]) {
  const all = ['source', ...conditions];
  return { resolve: { conditions: all }, ssr: { resolve: { conditions: all } } };
}

const workspaces = {
  shared: 'packages/shared',
  functions: 'functions',
};

export default defineConfig({
  test: {
    projects: [
      ...Object.entries(workspaces).map(([name, dir]) => ({
        ...withSource(defaultServerConditions),
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
      { test: { name: 'scripts', include: ['scripts/**/*.test.ts'] } },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'functions/src/**', 'web/src/**', 'scripts/**'],
    },
  },
});
