import { describe, expect, it } from 'vitest';

import { LOCK_HOLDERS, SHORT_LOCK_HOLDERS } from './jobs.js';
import { DeleteAllDataInputSchema, DeleteAllDataResultSchema, WIPE_STEPS } from './wipe.js';

describe('DeleteAllDataInputSchema (ADR-057)', () => {
  it('needs the exact word and an explicit profile choice, and nothing else', () => {
    expect(
      DeleteAllDataInputSchema.safeParse({ confirm: 'DELETE', resetProfile: false }).success,
    ).toBe(true);
    for (const bad of [
      undefined,
      {},
      { confirm: 'DELETE' },
      { confirm: 'delete', resetProfile: false },
      { confirm: 'DELETE', resetProfile: 'false' },
      { confirm: 'DELETE', resetProfile: false, extra: true },
    ]) {
      expect(DeleteAllDataInputSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('DeleteAllDataResultSchema', () => {
  it('parses a progress result and a finished one with the profile counts', () => {
    expect(
      DeleteAllDataResultSchema.safeParse({
        done: false,
        deleted: { documents: 3000, files: 12 },
        remaining: ['jobs', 'runs'],
      }).success,
    ).toBe(true);
    expect(
      DeleteAllDataResultSchema.safeParse({
        done: true,
        deleted: { documents: 0, files: 0 },
        remaining: [],
        profile: { facts: 120, documents: 3, files: 3 },
      }).success,
    ).toBe(true);
    expect(
      DeleteAllDataResultSchema.safeParse({
        done: true,
        deleted: { documents: 0, files: 0 },
        remaining: ['nope'],
      }).success,
    ).toBe(false);
  });

  it('lists nine steps, applications first', () => {
    expect(WIPE_STEPS).toHaveLength(9);
    expect(WIPE_STEPS[0]).toBe('applications');
  });
});

describe('the wipe lock holder', () => {
  it('is a short holder, so a scheduled scan waits for it and then skips', () => {
    expect(LOCK_HOLDERS).toContain('wipe');
    expect(SHORT_LOCK_HOLDERS).toContain('wipe');
  });
});
