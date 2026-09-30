import { describe, expect, it } from 'vitest';

import { AppConfigSchema } from './config.js';

const valid = {
  ownerUid: 'owner-uid-123',
  schemaVersion: 1,
  createdAt: new Date('2026-09-30T08:00:00Z'),
  updatedAt: new Date('2026-09-30T08:00:00Z'),
};

describe('AppConfigSchema', () => {
  it('parses a valid config', () => {
    expect(AppConfigSchema.parse(valid)).toEqual(valid);
  });

  it.each([
    ['missing ownerUid', { ...valid, ownerUid: undefined }],
    ['empty ownerUid', { ...valid, ownerUid: '' }],
    ['whitespace ownerUid', { ...valid, ownerUid: '   ' }],
    ['wrong schemaVersion', { ...valid, schemaVersion: 2 }],
    ['string createdAt', { ...valid, createdAt: '2026-09-30' }],
    ['missing updatedAt', { ...valid, updatedAt: undefined }],
    [
      'Timestamp-like object instead of Date',
      { ...valid, createdAt: { seconds: 1, nanoseconds: 0 } },
    ],
  ])('rejects %s', (_name, input) => {
    expect(AppConfigSchema.safeParse(input).success).toBe(false);
  });
});
