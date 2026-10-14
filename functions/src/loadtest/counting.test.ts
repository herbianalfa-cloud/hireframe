import { describe, expect, it } from 'vitest';

import { counted, newCounters } from './counting.js';

/** A tiny stand-in for the Admin Firestore: enough surface for the proxy. */
function fakeFirestore() {
  const ref = (path: string) => ({
    path,
    get: () => Promise.resolve({ exists: true }),
  });
  const batch = () => {
    const ops: string[] = [];
    const api = {
      set: (r: { path: string }) => (ops.push(r.path), api),
      update: (r: { path: string }) => (ops.push(r.path), api),
      commit: () => Promise.resolve(ops.length),
    };
    return api;
  };
  return {
    doc: ref,
    collection: () => ({ get: () => Promise.resolve({ size: 7 }), doc: ref }),
    getAll: (...refs: unknown[]) => Promise.resolve(refs.map(() => ({ exists: true }))),
    batch,
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        get: () => Promise.resolve({ size: 3 }),
        set: () => undefined,
      }),
  };
}

describe('counted', () => {
  it('counts reads, getAll, batch writes and sizes, and transactions', async () => {
    const counters = newCounters();
    const db = counted(fakeFirestore(), counters);
    await db.collection().get();
    await db.doc('a').get();
    await db.getAll(db.doc('a'), db.doc('b'));
    const batch = db.batch();
    batch.set(db.doc('a'));
    batch.update(db.doc('b'));
    batch.set(db.doc('c'));
    await batch.commit();
    await db.runTransaction(async (tx) => {
      await (tx as { get: () => Promise<unknown> }).get();
      (tx as { set: () => void }).set();
    });
    expect(counters.reads).toBe(7 + 1 + 2 + 3);
    expect(counters.writes).toBe(3 + 1);
    expect(counters.batches).toEqual([3]);
    expect(counters.observed).toBeGreaterThan(0);
  });

  it('hands the real object back when a wrapped ref is passed in', async () => {
    const counters = newCounters();
    const raw = fakeFirestore();
    const seen: unknown[] = [];
    const original = raw.getAll;
    raw.getAll = (...refs: unknown[]) => {
      seen.push(...refs);
      return original(...refs);
    };
    const db = counted(raw, counters);
    const ref = db.doc('x');
    await db.getAll(ref);
    expect(seen[0]).not.toBe(ref);
    expect((seen[0] as { path: string }).path).toBe('x');
  });
});
