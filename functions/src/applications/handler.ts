import {
  ApplicationInputSchema,
  type ApplicationInput,
  type ApplicationResult,
} from '@hireframe/shared';
import { HttpsError } from 'firebase-functions/https';

import { DailyCapExceededError } from '../llm/errors.js';
import {
  ApplicationRefusal,
  runApplication,
  type ApplicationDeps,
  type RefusalCode,
} from './run.js';

/**
 * The `application` request handling, kept apart from the callable so it is testable without
 * Firebase: input validation, the dispatch and the error mapping. The owner check ran before this
 * (`requireOwner`, auth.ts). `build` runs after the input validates, so a bad request touches no
 * store. Messages carry no job or answer text.
 */
const REFUSALS: Readonly<
  Record<
    RefusalCode,
    { code: 'not-found' | 'failed-precondition' | 'aborted' | 'invalid-argument'; message: string }
  >
> = {
  not_found: { code: 'not-found', message: 'That job or application was not found.' },
  wrong_stage: {
    code: 'failed-precondition',
    message: "That can't be done from where this application is now.",
  },
  lost: { code: 'aborted', message: 'This application changed. Reload and try again.' },
  no_fact: {
    code: 'invalid-argument',
    message: "Couldn't turn that into a fact: rephrase it or skip.",
  },
  header_missing: {
    code: 'failed-precondition',
    message: 'Add your CV header on Profile first.',
  },
  no_verdict: { code: 'failed-precondition', message: 'This job has not been judged yet.' },
};

export async function applicationHandler(
  data: unknown,
  build: () => Promise<ApplicationDeps>,
): Promise<ApplicationResult> {
  const parsed = ApplicationInputSchema.safeParse(data);
  if (!parsed.success) throw new HttpsError('invalid-argument', 'Unexpected input.');
  const input: ApplicationInput = parsed.data;
  try {
    return await runApplication(await build(), input);
  } catch (error) {
    if (error instanceof ApplicationRefusal) {
      const { code, message } = REFUSALS[error.code];
      throw new HttpsError(code, message);
    }
    if (error instanceof DailyCapExceededError) {
      throw new HttpsError(
        'resource-exhausted',
        "Today's budget for applications has been used. Try again tomorrow.",
      );
    }
    throw error;
  }
}
