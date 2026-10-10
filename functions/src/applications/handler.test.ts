import { describe, expect, it } from 'vitest';

import { DailyCapExceededError } from '../llm/errors.js';
import { applicationHandler } from './handler.js';
import { ApplicationRefusal, type ApplicationDeps } from './run.js';
import { memoryApplicationStore, testJob, requirementOf, TEST_JOB_ID } from './testing.js';

function deps(): ApplicationDeps {
  const store = memoryApplicationStore();
  store.jobs.set(TEST_JOB_ID, testJob([requirementOf('Uses SQL')]));
  return {
    store,
    facts: () => Promise.resolve([]),
    llm: () => Promise.reject(new DailyCapExceededError()),
    deleteFiles: () => Promise.resolve(0),
    now: () => new Date('2026-10-05T08:00:00Z'),
  };
}

describe('applicationHandler', () => {
  it('rejects bad input before building anything', async () => {
    let built = 0;
    const build = () => {
      built += 1;
      return Promise.resolve(deps());
    };
    for (const data of [
      null,
      {},
      { action: 'start' },
      { action: 'start', jobId: 'job-1', extra: 1 },
      { action: 'answer', jobId: 'job-1', questionId: 'q-1', text: 'x' },
      { action: 'answer', jobId: 'job-1', questionId: 'q-0123456789ab', text: 'x'.repeat(2_001) },
      { action: 'regenerate', jobId: 'job-1', notes: 'x'.repeat(501) },
      { action: 'withdraw', jobId: 'job-1' },
      { action: 'generate', jobId: 'job-1' },
    ]) {
      await expect(applicationHandler(data, build)).rejects.toMatchObject({
        code: 'invalid-argument',
      });
    }
    expect(built).toBe(0);
  });

  it('answers a start', async () => {
    const result = await applicationHandler({ action: 'start', jobId: TEST_JOB_ID }, () =>
      Promise.resolve(deps()),
    );
    expect(result).toMatchObject({ jobId: TEST_JOB_ID, stage: 'needs_input', unanswered: 1 });
  });

  it.each([
    ['not_found', 'not-found'],
    ['wrong_stage', 'failed-precondition'],
    ['lost', 'aborted'],
    ['no_fact', 'invalid-argument'],
    ['header_missing', 'failed-precondition'],
    ['no_verdict', 'failed-precondition'],
  ] as const)('maps the %s refusal to %s', async (reason, code) => {
    const d = deps();
    d.store.getApplication = () => Promise.reject(new ApplicationRefusal(reason));
    await expect(
      applicationHandler({ action: 'retry', jobId: TEST_JOB_ID }, () => Promise.resolve(d)),
    ).rejects.toMatchObject({ code });
  });

  it('turns an exhausted daily cap into resource-exhausted', async () => {
    const d = deps();
    await applicationHandler({ action: 'start', jobId: TEST_JOB_ID }, () => Promise.resolve(d));
    const [q] = (await d.store.getApplication(TEST_JOB_ID))?.questions ?? [];
    await expect(
      applicationHandler(
        { action: 'answer', jobId: TEST_JOB_ID, questionId: q?.id, text: 'Did it.' },
        () => Promise.resolve(d),
      ),
    ).rejects.toMatchObject({ code: 'resource-exhausted' });
  });
});
