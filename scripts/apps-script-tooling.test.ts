/**
 * The Gmail bridge's deploy tool is a pinned dependency, not whatever `npx` fetches the day it runs
 * (RUNBOOK Part G6): clasp holds a Google login and pushes code that reads mail.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(readFileSync('apps-script/package.json', 'utf8')) as {
  devDependencies?: Record<string, string>;
};
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as {
  packages: Record<string, { version?: string }>;
};

describe('clasp', () => {
  it('is an exact-pinned devDependency of apps-script', () => {
    const range = manifest.devDependencies?.['@google/clasp'];
    expect(range).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lock.packages['node_modules/@google/clasp']?.version).toBe(range);
  });

  it('is run through the workspace in the docs, never bare npx', () => {
    for (const file of ['docs/RUNBOOK.md', 'CLAUDE.md', 'scripts/build-apps-script.ts']) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/npx clasp/);
    }
    expect(readFileSync('docs/RUNBOOK.md', 'utf8')).toContain('npm exec -w apps-script clasp');
  });
});
