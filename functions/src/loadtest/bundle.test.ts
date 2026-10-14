import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The load-test code must never reach the deploy bundle. This walks every relative import
 * (static, dynamic and re-export) from the functions entry point and fails if one lands under
 * `functions/src/loadtest/`. The smoke test only catches it by a marker string in one file.
 */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g;

function resolveImport(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier);
  const stem = base.replace(/\.js$/, '');
  for (const candidate of [`${stem}.ts`, `${stem}.tsx`, base, join(base, 'index.ts')]) {
    if (existsSync(candidate) && candidate.endsWith('.ts')) return candidate;
  }
  return undefined;
}

function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(IMPORT)) {
      const target = match[1] ? resolveImport(file, match[1]) : undefined;
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return seen;
}

describe('the functions bundle', () => {
  it('reaches no file under functions/src/loadtest/ from index.ts', () => {
    const files = reachable(join(SRC, 'index.ts'));
    expect(files.size).toBeGreaterThan(50);
    const offenders = [...files]
      .map((file) => relative(SRC, file))
      .filter((file) => file.split(sep)[0] === 'loadtest');
    expect(offenders).toEqual([]);
  });

  it('would see a load-test import (the walker follows real edges)', () => {
    const files = reachable(join(SRC, 'loadtest', 'run.ts'));
    expect([...files].some((f) => relative(SRC, f).startsWith(`loadtest${sep}data`))).toBe(true);
  });
});
