import { HttpsError } from 'firebase-functions/https';

import { SpendCapExceededError } from './llm/errors.js';
import { errorFields, log } from './log.js';

/**
 * Wraps a callable handler so nothing unsanitised leaves it: `HttpsError`s (already
 * user-safe) pass through, the spend cap becomes `resource-exhausted`, and anything else is
 * logged by class and code only and returned as a generic `internal` error.
 */
export function safeHandler<Req, Res>(
  name: string,
  handler: (request: Req) => Promise<Res>,
): (request: Req) => Promise<Res> {
  return async (request) => {
    try {
      return await handler(request);
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      if (error instanceof SpendCapExceededError) {
        throw new HttpsError('resource-exhausted', 'The monthly AI spend cap has been reached.');
      }
      log.error('callable.failed', { callable: name, ...errorFields(error) });
      throw new HttpsError('internal', 'Something went wrong. Try again.');
    }
  };
}
