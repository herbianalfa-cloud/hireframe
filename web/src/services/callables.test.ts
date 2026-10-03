import { CALLABLE_TIMEOUT_SECONDS } from '@hireframe/shared';
import { httpsCallable } from 'firebase/functions';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { addFact, parseCv, resetProfile } from './profile';
import { scanNow } from './system';

vi.mock('firebase/functions', () => ({
  httpsCallable: vi.fn(() => () => Promise.reject(new Error('not under test'))),
}));
vi.mock('./firebase', () => ({ getFunctionsClient: () => Promise.resolve({}) }));

const callable = vi.mocked(httpsCallable);

beforeEach(() => {
  callable.mockClear();
});

describe('callable clients', () => {
  it.each([
    ['parseCv', () => parseCv('abcdefghij0123456789', 'cv.pdf')],
    ['addFact', () => addFact('A note')],
    ['resetProfile', () => resetProfile('RESET')],
    ['scanNow', () => scanNow()],
  ] as const)(
    '%s waits longer than the server timeout and uses a limited-use App Check token',
    async (name, invoke) => {
      await invoke().catch(() => undefined);
      expect(callable).toHaveBeenCalledTimes(1);
      const [, calledName, options] = callable.mock.calls[0] ?? [];
      expect(calledName).toBe(name);
      expect(options?.limitedUseAppCheckTokens).toBe(true);
      expect(options?.timeout).toBeGreaterThanOrEqual(
        CALLABLE_TIMEOUT_SECONDS[name] * 1000 + 10_000,
      );
    },
  );
});
