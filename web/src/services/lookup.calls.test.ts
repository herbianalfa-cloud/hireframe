import { httpsCallable } from 'firebase/functions';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { lookupAdd, lookupDescribe, lookupParse } from './lookup';

const invoke = vi.fn();
vi.mock('firebase/functions', () => ({ httpsCallable: vi.fn(() => invoke) }));
vi.mock('./firebase', () => ({ getFunctionsClient: () => Promise.resolve({}) }));

beforeEach(() => {
  invoke.mockReset();
  vi.mocked(httpsCallable).mockClear();
});

describe('a failing lookup call (it spends money, so it is never retried)', () => {
  // The errors a retrying client would retry: a dropped connection, a timeout, a server hiccup.
  const transient = ['functions/unavailable', 'functions/deadline-exceeded', 'functions/internal'];

  it.each(transient)('is invoked once and rethrown on %s, for every action', async (code) => {
    for (const call of [
      () => lookupAdd([{ kind: 'url', url: 'https://boards.greenhouse.io/acme/jobs/1' }]),
      () => lookupDescribe('job1', 'A description'),
      () => lookupParse('Some pasted page', []),
    ]) {
      invoke.mockReset();
      invoke.mockRejectedValue(Object.assign(new Error('failed'), { code }));
      await expect(call()).rejects.toMatchObject({ code });
      expect(invoke).toHaveBeenCalledTimes(1);
    }
  });
});
