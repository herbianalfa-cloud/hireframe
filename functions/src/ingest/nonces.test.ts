import type { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import { HMAC } from '../config.js';
import { firestoreNonceStore } from './nonces.js';

const NOW = new Date('2026-10-07T09:00:00Z');

/** A db that behaves like `create()`: a second create of the same path fails with ALREADY_EXISTS. */
function fakeDb() {
  const docs = new Map<string, Record<string, unknown>>();
  const db = {
    doc: (path: string) => ({
      create: (data: Record<string, unknown>) => {
        if (docs.has(path)) return Promise.reject(Object.assign(new Error('exists'), { code: 6 }));
        docs.set(path, data);
        return Promise.resolve();
      },
    }),
  } as unknown as Firestore;
  return { db, docs };
}

describe('nonce store (ADR-046)', () => {
  it('expires a nonce 10 minutes after it was claimed, twice the 5-minute skew', async () => {
    const { db, docs } = fakeDb();
    expect(await firestoreNonceStore(db).claim('n1', NOW)).toBe(true);
    const [stored] = [...docs.values()];
    expect(stored?.expireAt).toEqual(new Date(NOW.getTime() + 10 * 60_000));
    expect(HMAC.nonceTtlSeconds).toBe(10 * 60);
    expect(HMAC.nonceTtlSeconds).toBeGreaterThanOrEqual(2 * HMAC.maxSkewSeconds);
  });

  it('refuses a replay at any time before and after the TTL: one stored document, no growth', async () => {
    const { db, docs } = fakeDb();
    const store = firestoreNonceStore(db);
    expect(await store.claim('n1', NOW)).toBe(true);
    for (const offsetMs of [1, 5 * 60_000, 10 * 60_000 - 1, 10 * 60_000, 10 * 60_000 + 1]) {
      expect(await store.claim('n1', new Date(NOW.getTime() + offsetMs))).toBe(false);
    }
    expect(docs.size).toBe(1);
  });

  it('rethrows any other store error instead of treating it as a replay', async () => {
    const db = {
      doc: () => ({ create: () => Promise.reject(Object.assign(new Error('down'), { code: 14 })) }),
    } as unknown as Firestore;
    await expect(firestoreNonceStore(db).claim('n2', NOW)).rejects.toThrow('down');
  });
});
