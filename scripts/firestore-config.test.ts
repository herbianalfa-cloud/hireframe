import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * Deploy-time Firestore configuration the emulator can't check (ADR-046, ADR-047): the TTL
 * policies that delete spent nonces and old alert-message records. They are `fieldOverrides`
 * entries with `ttl: true` and no single-field indexes (nothing queries these fields).
 */
const { fieldOverrides } = JSON.parse(readFileSync('firestore.indexes.json', 'utf8')) as {
  fieldOverrides: {
    collectionGroup: string;
    fieldPath: string;
    ttl?: boolean;
    indexes: unknown[];
  }[];
};

describe('firestore.indexes.json TTL policies', () => {
  it.each(['nonces', 'alertMessages'])('expires %s documents on expireAt', (collectionGroup) => {
    expect(fieldOverrides).toContainEqual({
      collectionGroup,
      fieldPath: 'expireAt',
      ttl: true,
      indexes: [],
    });
  });

  it('puts a TTL on nothing else', () => {
    expect(
      fieldOverrides
        .filter((override) => override.ttl)
        .map((o) => o.collectionGroup)
        .sort(),
    ).toEqual(['alertMessages', 'nonces']);
  });
});
