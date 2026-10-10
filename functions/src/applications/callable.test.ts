import { CALLABLE_TIMEOUT_SECONDS } from '@hireframe/shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The exported `application` callable, as `onCall` receives it: the final option values (not the
 * source text) and the owner check running before anything is read or written. `onCall` is
 * replaced by a capture; the admin SDK by a recorder that fails on any access but the config read.
 */
const captured = vi.hoisted(() => ({
  options: undefined as Record<string, unknown> | undefined,
  handler: undefined as ((request: unknown) => Promise<unknown>) | undefined,
}));
const touched = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock('firebase-functions/https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase-functions/https')>();
  return {
    ...actual,
    onCall: (options: Record<string, unknown>, handler: (request: unknown) => Promise<unknown>) => {
      captured.options = options;
      captured.handler = handler;
      return () => undefined;
    },
  };
});

vi.mock('../admin.js', () => {
  const record = (access: string) => {
    touched.paths.push(access);
  };
  const failing = (access: string): never => {
    record(access);
    throw new Error(`unexpected access: ${access}`);
  };
  return {
    db: () => ({
      doc: (path: string) => ({
        get: () => {
          record(`get ${path}`);
          if (path !== 'config/app') return failing(`get ${path}`);
          return Promise.resolve({
            exists: true,
            data: () => ({ ownerUid: 'owner-uid', schemaVersion: 1 }),
          });
        },
        set: () => failing(`set ${path}`),
        update: () => failing(`update ${path}`),
      }),
      collection: (path: string) => failing(`collection ${path}`),
      runTransaction: () => failing('runTransaction'),
      batch: () => failing('batch'),
    }),
    bucket: () => failing('bucket'),
  };
});

beforeAll(async () => {
  vi.stubEnv('FUNCTIONS_EMULATOR', '');
  vi.stubEnv('LIVE', '');
  await import('./callable.js');
});

afterEach(() => {
  touched.paths = [];
});

describe('the application callable options', () => {
  it('enforces and consumes App Check, in one instance, with the shared timeout', () => {
    expect(captured.options).toMatchObject({
      region: 'europe-west2',
      enforceAppCheck: true,
      consumeAppCheckToken: true,
      maxInstances: 1,
      timeoutSeconds: CALLABLE_TIMEOUT_SECONDS.application,
    });
    expect(CALLABLE_TIMEOUT_SECONDS.application).toBe(120);
  });

  it('mounts the model key and no other secret', () => {
    const secrets = captured.options?.secrets as { name: string }[] | undefined;
    expect(secrets?.map((secret) => secret.name)).toEqual(['ANTHROPIC_API_KEY']);
  });
});

describe('the application handler refuses before any read or write', () => {
  const input = { action: 'withdraw', jobId: 'job-1', deleteFiles: true };
  const call = (request: Record<string, unknown>) => {
    if (!captured.handler) throw new Error('onCall was not reached');
    return captured.handler(request);
  };

  beforeEach(() => {
    touched.paths = [];
  });

  it('refuses an anonymous caller without touching Firestore or Storage', async () => {
    await expect(call({ data: input })).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(touched.paths).toEqual([]);
  });

  it('refuses a signed-in caller who is not the owner, after reading only config/app', async () => {
    await expect(call({ data: input, auth: { uid: 'stranger-uid' } })).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(touched.paths).toEqual(['get config/app']);
  });

  it('refuses a replayed App Check token, even from the owner', async () => {
    await expect(
      call({ data: input, auth: { uid: 'owner-uid' }, app: { alreadyConsumed: true } }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(touched.paths).toEqual([]);
  });
});
