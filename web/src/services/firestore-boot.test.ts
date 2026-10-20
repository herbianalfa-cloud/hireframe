import { Timestamp } from 'firebase/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  getFirestore: vi.fn(() => ({ kind: 'db' })),
  connectFirestoreEmulator: vi.fn(),
  getDoc: vi.fn(),
}));

vi.mock('firebase/firestore', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getFirestore: sdk.getFirestore,
  connectFirestoreEmulator: sdk.connectFirestoreEmulator,
  doc: (_db: unknown, path: string) => ({ path }),
  getDoc: sdk.getDoc,
}));

import type { FirebaseApp } from 'firebase/app';
import type { Firestore } from 'firebase/firestore';

import { connectDb, readAppConfig } from './firestore-boot';

const db = {} as Firestore;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('readAppConfig', () => {
  it('converts console Timestamps to Dates, nested and in arrays', async () => {
    const at = new Date('2026-09-30T08:00:00Z');
    sdk.getDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({
        createdAt: Timestamp.fromDate(at),
        nested: { list: [Timestamp.fromDate(at), 'text'] },
        count: 3,
      }),
    });
    await expect(readAppConfig(db)).resolves.toEqual({
      exists: true,
      data: { createdAt: at, nested: { list: [at, 'text'] }, count: 3 },
    });
  });

  it('reports a missing document', async () => {
    sdk.getDoc.mockResolvedValue({ exists: () => false, data: () => undefined });
    await expect(readAppConfig(db)).resolves.toEqual({ exists: false });
  });
});

describe('connectDb', () => {
  it('gets the Firestore for the app and connects the emulator in dev', () => {
    const app = { name: 'app' } as FirebaseApp;
    expect(connectDb(app)).toEqual({ kind: 'db' });
    expect(sdk.getFirestore).toHaveBeenCalledWith(app);
    expect(sdk.connectFirestoreEmulator).toHaveBeenCalledWith({ kind: 'db' }, '127.0.0.1', 8080);
  });
});
