import { HttpsError } from 'firebase-functions/https';
import { describe, expect, it, vi } from 'vitest';

import { loadDevFakes, useFakes } from '../callable.js';
import { scanNowHandler, secretValue } from './handler.js';

const completed = {
  status: 'completed',
  runId: 'run-1',
  runStatus: 'succeeded',
  perSource: {},
  s0: { in: 0, new: 0, merged: 0, duplicate: 0, conflicts: 0 },
} as const;

describe('scanNowHandler', () => {
  it('rejects unexpected input before scanning', async () => {
    const scan = vi.fn(() => Promise.resolve(completed));
    const error: unknown = await scanNowHandler({ force: true }, scan).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpsError);
    expect(error).toMatchObject({ code: 'invalid-argument' });
    expect(scan).not.toHaveBeenCalled();
  });

  it('accepts an empty object or no data at all', async () => {
    await expect(scanNowHandler({}, () => Promise.resolve(completed))).resolves.toEqual(completed);
    await expect(scanNowHandler(undefined, () => Promise.resolve(completed))).resolves.toEqual(
      completed,
    );
  });

  it('turns a busy lock into failed-precondition', async () => {
    const error: unknown = await scanNowHandler({}, () =>
      Promise.resolve({ status: 'busy' as const }),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'failed-precondition',
      message: 'A scan is already running.',
    });
  });

  it('passes a skipped scan through', async () => {
    const skipped = {
      status: 'skipped_recent',
      lastFinishedAt: '2026-10-03T08:00:00.000Z',
      retryAfterSeconds: 30,
    } as const;
    await expect(scanNowHandler({}, () => Promise.resolve(skipped))).resolves.toEqual(skipped);
  });
});

describe('secretValue', () => {
  it('treats empty and placeholder secrets as missing', () => {
    expect(secretValue('')).toBeUndefined();
    expect(secretValue('  ')).toBeUndefined();
    expect(secretValue('emulator-placeholder')).toBeUndefined();
    expect(secretValue(' real-key \n')).toBe('real-key');
  });
});

describe('fakes outside the emulator (ADR-017, ADR-029)', () => {
  it('are off unless FUNCTIONS_EMULATOR is set, and absent from bundles built without them', async () => {
    expect(process.env.FUNCTIONS_EMULATOR).toBeUndefined();
    expect(useFakes).toBe(false);
    await expect(loadDevFakes()).rejects.toThrow(/no dev fakes/);
  });
});
