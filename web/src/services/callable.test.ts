import { APP_CHECK_REPLAY_MESSAGE } from '@hireframe/shared';
import { CustomProvider, initializeAppCheck } from 'firebase/app-check';
import { initializeApp } from 'firebase/app';
import { getFunctions, type Functions } from 'firebase/functions';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { callOwnerCallable, isAppCheckReplay } from './callable';

/**
 * These run the real Functions SDK with a real App Check instance whose custom provider mints a
 * new token on every request, and a fetch stub that records the token each request carried.
 */
const { functionsRef } = vi.hoisted(() => ({
  functionsRef: { current: undefined as Functions | undefined },
}));
vi.mock('./firebase', () => ({
  getFunctionsClient: () => Promise.resolve(functionsRef.current),
}));

let minted = 0;
const app = initializeApp({ projectId: 'demo-callable', apiKey: 'demo', appId: 'demo-app' });
initializeAppCheck(app, {
  provider: new CustomProvider({
    getToken: () => {
      minted += 1;
      return Promise.resolve({
        token: `token-${String(minted)}`,
        expireTimeMillis: Date.now() + 3_600_000,
      });
    },
  }),
});
functionsRef.current = getFunctions(app, 'europe-west2');

function stubFetch(): { tokens: string[]; release: () => void } {
  const tokens: string[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
      tokens.push(init.headers['X-Firebase-AppCheck'] ?? 'none');
      await gate;
      return new Response(JSON.stringify({ result: { ok: true } }), { status: 200 });
    }),
  );
  return { tokens, release };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('callOwnerCallable', () => {
  it('sends a different App Check token on each of two calls in a row', async () => {
    const { tokens, release } = stubFetch();
    release();
    await callOwnerCallable('application', { action: 'skipAll', jobId: 'job1' });
    await callOwnerCallable('application', { action: 'skipAll', jobId: 'job1' });
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it('sends one request for a double click, and a new one after it settles', async () => {
    const { tokens, release } = stubFetch();
    const first = callOwnerCallable('application', { action: 'retry', jobId: 'job1' });
    const second = callOwnerCallable('application', { action: 'retry', jobId: 'job1' });
    await vi.waitFor(() => {
      expect(tokens).toHaveLength(1);
    });
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(tokens).toHaveLength(1);
    await callOwnerCallable('application', { action: 'retry', jobId: 'job1' });
    expect(tokens).toHaveLength(2);
  });
});

describe('isAppCheckReplay', () => {
  it('recognises the refusal by code and words, and nothing else', () => {
    const replay = Object.assign(new Error(APP_CHECK_REPLAY_MESSAGE), {
      code: 'functions/permission-denied',
    });
    expect(isAppCheckReplay(replay)).toBe(true);
    expect(
      isAppCheckReplay(
        Object.assign(new Error('Not allowed.'), { code: 'functions/permission-denied' }),
      ),
    ).toBe(false);
    expect(isAppCheckReplay(new Error(APP_CHECK_REPLAY_MESSAGE))).toBe(false);
  });
});
