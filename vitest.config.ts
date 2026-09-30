import { defineConfig } from 'vitest/config';

const workspaces = {
  shared: 'packages/shared',
  functions: 'functions',
  web: 'web',
};

export default defineConfig({
  test: {
    projects: [
      ...Object.entries(workspaces).map(([name, dir]) => ({
        test: { name, include: [`${dir}/src/**/*.test.ts`] },
      })),
      { test: { name: 'scripts', include: ['scripts/**/*.test.ts'] } },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'functions/src/**', 'web/src/**', 'scripts/**'],
    },
  },
});
