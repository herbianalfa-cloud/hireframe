import { defineConfig } from 'vitest/config';

// `source` resolves `@hireframe/shared` to its TypeScript sources (ADR-012); `node` resolves
// packages the way Node does at runtime (see vitest.config.ts).
const conditions = ['source', 'node'];

// Rules and emulator integration tests need the Firestore + Storage emulators, so they run
// apart from `npm test`: `npm run test:rules` wraps this config in `firebase emulators:exec`
// (ADR-013).
export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    name: 'rules',
    include: ['tests/rules/**/*.rules.test.ts', 'tests/emulator/**/*.test.ts'],
    // Both suites share one emulator and clear it between tests.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
