import { CLIENT_JOB_STATUSES, EventSchema, VERDICTS } from '@hireframe/shared';
import { deleteField, serverTimestamp, type DocumentData } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';

import { buildJobFeedbackWrite, buildJobStatusWrite } from './job-writes';

const NOW = serverTimestamp();
const job: DocumentData = { status: 'new', verdict: 'apply', title: 'Product Analyst' };

describe('buildJobStatusWrite', () => {
  it('stamps applied with the server time and the job’s verdict', () => {
    const { update, event } = buildJobStatusWrite('job-1', job, 'applied', NOW);
    expect(update).toEqual({
      status: 'applied',
      appliedAt: NOW,
      appliedVerdict: 'apply',
      updatedAt: NOW,
    });
    expect(event).toEqual({
      type: 'job_status',
      jobId: 'job-1',
      from: 'new',
      to: 'applied',
      verdict: 'apply',
      at: NOW,
      schemaVersion: 1,
    });
  });

  it('leaves out the verdict on a job that has none', () => {
    const { update, event } = buildJobStatusWrite('job-1', { status: 'new' }, 'applied', NOW);
    expect(update).not.toHaveProperty('appliedVerdict');
    expect(event).not.toHaveProperty('verdict');
  });

  it('clears the applied stamps on any other status', () => {
    const applied = { ...job, status: 'applied' };
    const { update } = buildJobStatusWrite('job-1', applied, 'saved', NOW);
    expect(update.status).toBe('saved');
    expect(update.appliedAt).toEqual(deleteField());
    expect(update.appliedVerdict).toEqual(deleteField());
  });

  it('refuses a no-op and a status the app does not own', () => {
    expect(() => buildJobStatusWrite('job-1', job, 'new', NOW)).toThrow('already');
    expect(() =>
      buildJobStatusWrite('job-1', { ...job, status: 'interview' }, 'saved', NOW),
    ).toThrow('can’t be changed');
  });
});

describe('buildJobFeedbackWrite', () => {
  it('records a 👍 against the verdict it judged', () => {
    const { update, event } = buildJobFeedbackWrite('job-1', job, { agree: true }, NOW);
    expect(update).toEqual({
      feedback: { agree: true, verdict: 'apply', at: NOW },
      updatedAt: NOW,
    });
    expect(event).toMatchObject({ type: 'job_feedback', agree: true, verdict: 'apply' });
  });

  it('keeps a trimmed note and the expected verdict on a 👎, and the note off the event', () => {
    const { update, event } = buildJobFeedbackWrite(
      'job-1',
      job,
      { agree: false, note: '  Needs SQL.  ', expected: 'near_miss' },
      NOW,
    );
    expect(update.feedback).toEqual({
      agree: false,
      verdict: 'apply',
      note: 'Needs SQL.',
      expected: 'near_miss',
      at: NOW,
    });
    expect(event).toMatchObject({ expected: 'near_miss' });
    expect(event).not.toHaveProperty('note');
  });

  it('drops expected on a 👍 and a blank note', () => {
    const { update } = buildJobFeedbackWrite(
      'job-1',
      job,
      { agree: true, note: '   ', expected: 'skip' },
      NOW,
    );
    expect(update.feedback).toEqual({ agree: true, verdict: 'apply', at: NOW });
  });

  it('refuses an unjudged job, a long note and an expected verdict equal to the verdict', () => {
    expect(() => buildJobFeedbackWrite('job-1', { status: 'new' }, { agree: true }, NOW)).toThrow(
      'judged',
    );
    expect(() =>
      buildJobFeedbackWrite('job-1', job, { agree: false, note: 'x'.repeat(281) }, NOW),
    ).toThrow('280');
    expect(() =>
      buildJobFeedbackWrite('job-1', job, { agree: false, expected: 'apply' }, NOW),
    ).toThrow('different');
  });
});

describe('built events match EventSchema', () => {
  // The server timestamp sentinel stands in for `at`; a stored event has a Date there.
  const parse = (event: DocumentData) => EventSchema.parse({ ...event, at: new Date() });

  it('every status move, with and without a verdict', () => {
    for (const from of CLIENT_JOB_STATUSES) {
      for (const to of CLIENT_JOB_STATUSES) {
        if (from === to) continue;
        for (const raw of [{ status: from, verdict: 'near_miss' }, { status: from }]) {
          const { event } = buildJobStatusWrite('job-1', raw, to, NOW);
          expect(parse(event)).toMatchObject({ type: 'job_status', from, to });
        }
      }
    }
  });

  it('every rating, for every verdict and expected verdict', () => {
    for (const verdict of VERDICTS) {
      const raw = { status: 'new', verdict };
      for (const input of [
        { agree: true },
        { agree: true, note: 'Right.' },
        { agree: false },
        ...VERDICTS.filter((expected) => expected !== verdict).map((expected) => ({
          agree: false,
          note: 'Off.',
          expected,
        })),
      ]) {
        const { event } = buildJobFeedbackWrite('job-1', raw, input, NOW);
        expect(parse(event)).toMatchObject({ type: 'job_feedback', verdict, agree: input.agree });
        expect('note' in event).toBe(false);
      }
    }
  });
});
