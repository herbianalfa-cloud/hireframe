import { HttpsError } from 'firebase-functions/https';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setLogSink, type LogFields } from '../log.js';
import { resetProfileHandler, type ResetDeps } from './reset.js';

const NOW = new Date('2026-10-01T09:00:00Z');

let logs: LogFields[];

beforeEach(() => {
  logs = [];
  setLogSink((level, event, fields) => logs.push({ level, event, ...fields }));
});

afterEach(() => {
  setLogSink();
});

function parsing(updatedAt: Date) {
  return {
    kind: 'pdf',
    storagePath: 'x',
    status: 'parsing',
    createdAt: updatedAt,
    updatedAt,
    schemaVersion: 1,
  };
}

function fakeDeps(parsingDocuments: unknown[] = []) {
  const calls: string[] = [];
  const deps: ResetDeps = {
    store: {
      parsingDocuments: () => Promise.resolve(parsingDocuments),
      deleteProfile: () => {
        calls.push('deleteProfile');
        return Promise.resolve({ facts: 120, documents: 3 });
      },
    },
    deleteFiles: (prefix) => {
      calls.push(`deleteFiles:${prefix}`);
      return Promise.resolve(3);
    },
    now: () => NOW,
  };
  return { deps, calls };
}

async function expectHttpsError(promise: Promise<unknown>, code: string): Promise<void> {
  const error: unknown = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(HttpsError);
  expect((error as HttpsError).code).toBe(code);
}

describe('resetProfileHandler', () => {
  it('deletes facts, documents and uploaded files, and reports the counts', async () => {
    const { deps, calls } = fakeDeps();
    await expect(resetProfileHandler({ confirm: 'RESET' }, deps)).resolves.toEqual({
      facts: 120,
      documents: 3,
      files: 3,
    });
    expect(calls).toEqual(['deleteProfile', 'deleteFiles:profile/documents/']);
    expect(logs).toContainEqual({
      level: 'info',
      event: 'profile.reset',
      facts: 120,
      documents: 3,
      files: 3,
    });
  });

  it.each([undefined, {}, { confirm: 'reset' }, { confirm: 'RESET ' }, { confirm: true }])(
    'deletes nothing without the exact confirmation (%j)',
    async (data) => {
      const { deps, calls } = fakeDeps();
      await expectHttpsError(resetProfileHandler(data, deps), 'invalid-argument');
      expect(calls).toEqual([]);
    },
  );

  it('refuses while a CV is being read', async () => {
    const { deps, calls } = fakeDeps([parsing(new Date(NOW.getTime() - 60_000))]);
    await expectHttpsError(resetProfileHandler({ confirm: 'RESET' }, deps), 'failed-precondition');
    expect(calls).toEqual([]);
  });

  it('goes ahead when the only parse was abandoned long ago', async () => {
    const { deps, calls } = fakeDeps([parsing(new Date(NOW.getTime() - 60 * 60_000))]);
    await resetProfileHandler({ confirm: 'RESET' }, deps);
    expect(calls).toHaveLength(2);
  });
});
