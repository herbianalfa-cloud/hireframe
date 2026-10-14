import type { DeleteAllDataInput, DeleteAllDataResult } from '@hireframe/shared';
import { httpsCallable } from 'firebase/functions';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deleteAllData, runWipe, WIPE_MAX_CALLS } from './wipe';

vi.mock('firebase/functions', () => ({
  httpsCallable: vi.fn(),
}));
vi.mock('./firebase', () => ({ getFunctionsClient: () => Promise.resolve({}) }));

const callable = vi.mocked(httpsCallable);
const INPUT: DeleteAllDataInput = { confirm: 'DELETE', resetProfile: false };

function result(overrides: Partial<DeleteAllDataResult> = {}): DeleteAllDataResult {
  return {
    done: false,
    deleted: { documents: 10, files: 1 },
    remaining: ['jobs'],
    ...overrides,
  };
}

beforeEach(() => {
  callable.mockReset();
});

describe('deleteAllData (ADR-057)', () => {
  it('validates the input before any call', async () => {
    await expect(
      deleteAllData({ confirm: 'delete', resetProfile: false } as unknown as DeleteAllDataInput),
    ).rejects.toThrow();
    await expect(
      deleteAllData({ confirm: 'DELETE' } as unknown as DeleteAllDataInput),
    ).rejects.toThrow();
    expect(callable).not.toHaveBeenCalled();
  });

  it('parses the result and sends a limited-use token with the callable timeout', async () => {
    const send = vi.fn().mockResolvedValue({ data: result({ done: true, remaining: [] }) });
    callable.mockReturnValue(send as never);
    await expect(deleteAllData(INPUT)).resolves.toMatchObject({ done: true });
    const [, name, options] = callable.mock.calls[0] ?? [];
    expect(name).toBe('deleteAllData');
    expect(options?.limitedUseAppCheckTokens).toBe(true);
    expect(options?.timeout).toBe(140_000);
    expect(send).toHaveBeenCalledWith(INPUT);
  });

  it('rejects a malformed result and never retries a failure', async () => {
    const send = vi.fn().mockResolvedValue({ data: { done: 'yes' } });
    callable.mockReturnValue(send as never);
    await expect(deleteAllData(INPUT)).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('runWipe', () => {
  it('repeats until done and sums the profile counts over calls', async () => {
    const call = vi
      .fn<(input: DeleteAllDataInput) => Promise<DeleteAllDataResult>>()
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(
        result({ remaining: [], profile: { facts: 4, documents: 1, files: 1 } }),
      )
      .mockResolvedValueOnce(
        result({
          done: true,
          deleted: { documents: 0, files: 0 },
          remaining: [],
          profile: { facts: 0, documents: 0, files: 0 },
        }),
      );
    const seen: number[] = [];
    const totals = await runWipe(
      { confirm: 'DELETE', resetProfile: true },
      { call, onProgress: (t) => seen.push(t.documents) },
    );
    expect(call).toHaveBeenCalledTimes(3);
    expect(seen).toEqual([10, 20, 20]);
    expect(totals).toMatchObject({
      done: true,
      calls: 3,
      documents: 20,
      files: 2,
      profile: { facts: 4, documents: 1, files: 1 },
    });
  });

  it('stops at 20 calls, and Continue runs 20 more', async () => {
    const call = vi
      .fn<(input: DeleteAllDataInput) => Promise<DeleteAllDataResult>>()
      .mockResolvedValue(result());
    const first = await runWipe(INPUT, { call });
    expect(first).toMatchObject({ done: false, calls: WIPE_MAX_CALLS });
    expect(call).toHaveBeenCalledTimes(20);
    const second = await runWipe(INPUT, { call, from: first });
    expect(second.calls).toBe(40);
    expect(call).toHaveBeenCalledTimes(40);
  });

  it('stops at the first error and does not retry', async () => {
    const call = vi
      .fn<(input: DeleteAllDataInput) => Promise<DeleteAllDataResult>>()
      .mockResolvedValueOnce(result())
      .mockRejectedValueOnce(new Error('refused'));
    await expect(runWipe(INPUT, { call })).rejects.toThrow('refused');
    expect(call).toHaveBeenCalledTimes(2);
  });
});
