import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/** Every non-test source file under `functions/src`, as repo-relative paths. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

describe('cvJudge is eval-only (L6 of the CV quality review)', () => {
  it('is called only from functions/src/eval/ and defined in config', () => {
    const files = sources('functions/src');
    const callers = files
      .filter((path) => /purpose:\s*'cvJudge'/.test(readFileSync(path, 'utf8')))
      .sort();
    expect(callers).toEqual(['functions/src/eval/cv-evaluate.ts']);
    const mentions = files
      .filter((path) => readFileSync(path, 'utf8').includes('cvJudge'))
      .filter((path) => !path.startsWith(join('functions', 'src', 'eval')))
      .sort();
    expect(mentions).toEqual(['functions/src/config.ts']);
  });
});
