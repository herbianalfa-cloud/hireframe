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

async function expectRefusal(
  promise: Promise<unknown>,
  code: string,
  message: string,
): Promise<void> {
  const error: unknown = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(HttpsError);
  expect((error as HttpsError).code).toBe(code);
  expect((error as HttpsError).message).toBe(message);
}

describe('requireOwner', () => {
  it('returns the config for the owner', async () => {
    await expect(requireOwner({ auth: { uid: OWNER } }, read(config))).resolves.toEqual(config);
  });

  it('rejects a signed-out caller', async () => {
    await expectRefusal(requireOwner({}, read(config)), 'unauthenticated', 'Sign in first.');
  });

  it('rejects an anonymous caller with a consumed token as signed out', async () => {
    await expectRefusal(
      requireOwner({ app: { alreadyConsumed: true } }, read(config)),
      'unauthenticated',
      'Sign in first.',
    );
  });

  it('rejects another user', async () => {
    await expectRefusal(
      requireOwner({ auth: { uid: 'someone-else' } }, read(config)),
      'permission-denied',
      'Not allowed.',
    );
  });

  it('gives another user the same refusal when the token was already consumed', async () => {
    await expectRefusal(
      requireOwner({ auth: { uid: 'someone-else' }, app: { alreadyConsumed: true } }, read(config)),
      'permission-denied',
      'Not allowed.',
    );
  });

  it('rejects a replayed App Check token, in words the owner can act on, without logging text', async () => {
    const lines: string[] = [];
    setLogSink((level, event, fields) => {
      lines.push(JSON.stringify({ level, event, fields }));
    });
    const error: unknown = await requireOwner(
      { auth: { uid: OWNER }, app: { alreadyConsumed: true } },
      read(config),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpsError);
    expect((error as HttpsError).code).toBe('permission-denied');
    expect((error as HttpsError).message).toBe(
      'This request may already have gone through. Check the page before you try again.',
    );
    expect(lines).toEqual([
      JSON.stringify({
        level: 'warn',
        event: 'owner.denied',
        fields: { reason: 'app_check_replay' },
      }),
    ]);
  });

  it.each([
    ['a missing config/app', undefined],
    ['a malformed config/app', { ...config, ownerUid: '' }],
  ])('fails closed on %s', async (_name, value) => {
    await expectRefusal(
      requireOwner({ auth: { uid: OWNER } }, read(value)),
      'permission-denied',
      'Not allowed.',
    );
  });

  it('keeps "Not allowed." for an invalid config even when the token was consumed', async () => {
    await expectRefusal(
      requireOwner({ auth: { uid: OWNER }, app: { alreadyConsumed: true } }, read(undefined)),
      'permission-denied',
      'Not allowed.',
    );
  });

  it('accepts the optional spend overrides', async () => {
    const withOverrides = { ...config, monthlyCapPence: 2000, fxUsdToGbp: 0.8 };
    await expect(requireOwner({ auth: { uid: OWNER } }, read(withOverrides))).resolves.toEqual(
      withOverrides,
    );
  });
});
