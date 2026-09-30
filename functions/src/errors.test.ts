import { HttpsError } from 'firebase-functions/https';
import { afterEach, describe, expect, it } from 'vitest';

import { safeHandler } from './errors.js';
import { SpendCapExceededError } from './llm/errors.js';
import { setLogSink, type LogFields } from './log.js';

afterEach(() => {
  setLogSink();
});

async function caught(promise: Promise<unknown>): Promise<HttpsError> {
  const error: unknown = await promise.catch((value: unknown) => value);
  expect(error).toBeInstanceOf(HttpsError);
  return error as HttpsError;
}

describe('safeHandler', () => {
  it('passes results and HttpsErrors through', async () => {
    await expect(safeHandler('t', () => Promise.resolve(1))(undefined)).resolves.toBe(1);
    const error = await caught(
      safeHandler('t', () => Promise.reject(new HttpsError('not-found', 'No file.')))(undefined),
    );
    expect(error.code).toBe('not-found');
  });

  it('maps the spend cap to resource-exhausted', async () => {
    const error = await caught(
      safeHandler('t', () => Promise.reject(new SpendCapExceededError()))(undefined),
    );
    expect(error.code).toBe('resource-exhausted');
  });

  it('hides unexpected errors and never logs or returns their message', async () => {
    const lines: LogFields[] = [];
    setLogSink((_level, _event, fields) => lines.push(fields));
    const secret = 'Led onboarding for twelve clients at Example Ltd';
    const error = await caught(
      safeHandler('parseCv', () => Promise.reject(new Error(secret)))(undefined),
    );
    expect(error.code).toBe('internal');
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(lines)).not.toContain(secret);
    expect(lines).toEqual([{ callable: 'parseCv', errorName: 'Error' }]);
  });
});
