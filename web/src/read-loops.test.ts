import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * C5 audit guard (m8c-plan): no timer or query may re-read Firestore on a short loop. The 8C1
 * audit found none; this keeps it that way. A tick that only changes React state (the clocks) is
 * fine, but must be at least a minute so a mistake costs little.
 */
const MIN_INTERVAL_MS = 60_000;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const files = sourceFiles('web/src').map((path) => ({ path, text: readFileSync(path, 'utf8') }));
const number = (raw: string) => Number(raw.replaceAll('_', ''));

describe('client read loops (C5 audit)', () => {
  it('has no refetchInterval under a minute (none today)', () => {
    for (const { path, text } of files) {
      for (const match of text.matchAll(/refetchInterval\s*:\s*([\w.]+)/g)) {
        const value = number(match[1] ?? '');
        expect(Number.isFinite(value) && value >= MIN_INTERVAL_MS, `${path}: ${match[0]}`).toBe(
          true,
        );
      }
    }
  });

  it('has no setInterval under a minute', () => {
    for (const { path, text } of files) {
      for (const match of text.matchAll(
        /setInterval\(\s*\(\)\s*=>\s*\{[\s\S]*?\},\s*([\w_]+)\s*\)/g,
      )) {
        const raw = match[1] ?? '';
        const named = new RegExp(`const ${raw}\\s*=\\s*([\\d_]+)`).exec(text)?.[1];
        const value = number(named ?? raw);
        expect(value >= MIN_INTERVAL_MS, `${path}: setInterval(…, ${raw})`).toBe(true);
      }
    }
  });

  it('finds the two known clocks, so the scan above is not vacuous', () => {
    const intervals = files
      .filter(({ text }) => text.includes('setInterval('))
      .map(({ path }) => path);
    expect(intervals.sort()).toEqual([
      join('web/src/features/profile/UploadCard.tsx'),
      join('web/src/features/today/SummaryBar.tsx'),
    ]);
  });
});
