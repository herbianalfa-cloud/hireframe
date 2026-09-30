import { HttpsError } from 'firebase-functions/https';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { requireOwner } from './auth.js';
import { setLogSink } from './log.js';

const OWNER = 'owner-uid';
const config = {
  ownerUid: OWNER,
  schemaVersion: 1,
  createdAt: new Date('2026-09-30T08:00:00Z'),
  updatedAt: new Date('2026-09-30T08:00:00Z'),
};
const read = (value: unknown) => () => Promise.resolve(value);

beforeEach(() => {
  setLogSink(() => undefined);
});

afterEach(() => {
  setLogSink();
});

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const error: unknown = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(HttpsError);
  expect((error as HttpsError).code).toBe(code);
}

describe('requireOwner', () => {
  it('returns the config for the owner', async () => {
    await expect(requireOwner({ auth: { uid: OWNER } }, read(config))).resolves.toEqual(config);
  });

  it('rejects a signed-out caller', async () => {
    await expectCode(requireOwner({}, read(config)), 'unauthenticated');
  });

  it('rejects another user', async () => {
    await expectCode(
      requireOwner({ auth: { uid: 'someone-else' } }, read(config)),
      'permission-denied',
    );
  });

  it('rejects a replayed App Check token', async () => {
    await expectCode(
      requireOwner({ auth: { uid: OWNER }, app: { alreadyConsumed: true } }, read(config)),
      'permission-denied',
    );
  });

  it.each([
    ['a missing config/app', undefined],
    ['a malformed config/app', { ...config, ownerUid: '' }],
  ])('fails closed on %s', async (_name, value) => {
    await expectCode(requireOwner({ auth: { uid: OWNER } }, read(value)), 'permission-denied');
  });

  it('accepts the optional spend overrides', async () => {
    const withOverrides = { ...config, monthlyCapPence: 2000, fxUsdToGbp: 0.8 };
    await expect(requireOwner({ auth: { uid: OWNER } }, read(withOverrides))).resolves.toEqual(
      withOverrides,
    );
  });
});
