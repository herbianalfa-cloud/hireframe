import { assertNever, LookupInputSchema, type LookupResult } from '@hireframe/shared';
import { HttpsError } from 'firebase-functions/https';

import { runParse } from './parse-llm.js';
import { LookupUnavailableError, runAdd, runDescribe, type LookupDeps } from './run.js';

/**
 * The `lookup` request handling (ADR-049), kept apart from the callable so it is testable without
 * Firebase: input validation, the dispatch and the error mapping. The owner check ran before this
 * (`requireOwner`, auth.ts). `build` runs after the input validates, so a bad request reads no
 * config and touches no store.
 */
export async function lookupHandler(
  data: unknown,
  build: () => Promise<LookupDeps>,
): Promise<LookupResult> {
  const parsed = LookupInputSchema.safeParse(data);
  if (!parsed.success) throw new HttpsError('invalid-argument', 'Unexpected input.');
  const input = parsed.data;
  const deps = await build();
  try {
    switch (input.action) {
      case 'add':
        return await runAdd(deps, input.jobs);
      case 'describe':
        return await runDescribe(deps, input.jobId, input.text);
      case 'parse':
        return await runParse(deps.llm, input.text, input.links);
      default:
        return assertNever(input);
    }
  } catch (error) {
    if (error instanceof LookupUnavailableError) {
      throw new HttpsError('failed-precondition', 'Set your criteria before using Lookup.');
    }
    throw error;
  }
}
