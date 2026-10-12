import { APP_CHECK_REPLAY_MESSAGE, clientTimeoutMs, type CallableName } from '@hireframe/shared';
import { httpsCallable } from 'firebase/functions';

import { getFunctionsClient } from './firebase';
import { errorCode } from './log';

/**
 * The one way the web app calls an owner callable (M7 fix, docs/SECURITY.md "Runaway cost").
 * - A fresh `httpsCallable` and a limited-use App Check token per call: the server consumes the
 *   token, so a token must never be reused (the SDK mints one in every `call`; nothing is cached).
 * - Never retried here: a repeat could spend money twice. The owner sees the failure and decides.
 * - Single flight: while a call with the same name and the same input is running, a second one
 *   (a double click that lands before the button re-renders as disabled) gets the running call's
 *   result instead of sending another request.
 */
const inFlight = new Map<string, Promise<unknown>>();

export async function callOwnerCallable(name: CallableName, input: unknown): Promise<unknown> {
  const key = `${name}:${JSON.stringify(input)}`;
  const running = inFlight.get(key);
  if (running) return running;
  const started = (async () => {
    const functions = await getFunctionsClient();
    const call = httpsCallable(functions, name, {
      timeout: clientTimeoutMs(name),
      limitedUseAppCheckTokens: true,
    });
    return (await call(input)).data;
  })().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, started);
  return started;
}

/** True when the server refused a token it had already consumed. */
export function isAppCheckReplay(error: unknown): boolean {
  return (
    errorCode(error) === 'functions/permission-denied' &&
    error instanceof Error &&
    error.message === APP_CHECK_REPLAY_MESSAGE
  );
}
