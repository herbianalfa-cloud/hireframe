import { errorCode, logError } from './log';

/** CLAUDE.md: every external call has a timeout and at most 3 attempts with exponential backoff. */
export const MAX_ATTEMPTS = 3;

export class TimeoutError extends Error {
  override name = 'TimeoutError';
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(`${label} timed out after ${String(ms)} ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

interface RetryOptions {
  label: string;
  isRetryable: (error: unknown) => boolean;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const { label, isRetryable, baseDelayMs = 300, sleep = defaultSleep } = options;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const retrying = attempt < MAX_ATTEMPTS && isRetryable(error);
      logError(`${label}.failed`, {
        attempt,
        retrying,
        code: errorCode(error) ?? (error instanceof Error ? error.name : 'unknown'),
      });
      if (!retrying) throw error;
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
}

/** Network-ish failures worth retrying; auth/permission errors are not. */
export function isTransient(error: unknown): boolean {
  if (error instanceof TimeoutError) return true;
  const code = errorCode(error);
  return code === 'unavailable' || code === 'deadline-exceeded';
}
