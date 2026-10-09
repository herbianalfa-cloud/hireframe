import { describe, expect, it } from 'vitest';

import { chooseDigest } from './state.js';
import { RUN_INVALID_CODE, readRunDoc } from './store.js';

const startedAt = new Date('2026-10-07T06:30:00Z');
const valid = {
  trigger: 'schedule',
  status: 'succeeded',
  startedAt,
  perSource: {},
  perStage: {},
  costPence: 1,
  errors: [],
  schemaVersion: 1,
};

describe('readRunDoc', () => {
  it('returns a valid run document as it is', () => {
    const read = readRunDoc('today', valid);
    expect(read?.valid).toBe(true);
    expect(read?.run).toMatchObject({ id: 'today', status: 'succeeded', errors: [] });
  });

  it('reports a document that fails RunSchema as a failed run with run_invalid', () => {
    const read = readRunDoc('today', { ...valid, costPence: 'a lot', schemaVersion: 2 });
    expect(read?.valid).toBe(false);
    expect(read?.run).toMatchObject({
      id: 'today',
      trigger: 'schedule',
      status: 'failed',
      startedAt,
      errors: [{ code: RUN_INVALID_CODE }],
    });
    expect(RUN_INVALID_CODE).toBe('run_invalid');
  });

  it('keeps the invalid document’s other fields out of the run', () => {
    const read = readRunDoc('today', { ...valid, status: 'bogus', note: 'Acme secret' });
    expect(JSON.stringify(read?.run)).not.toContain('Acme secret');
  });

  it('skips a document with no readable trigger or start, which can’t be placed on a day', () => {
    expect(readRunDoc('x', { ...valid, startedAt: 'yesterday' })).toBeUndefined();
    expect(readRunDoc('x', { ...valid, trigger: 'cron' })).toBeUndefined();
    expect(readRunDoc('x', null)).toBeUndefined();
  });

  it('makes the digest failed, not missing, when the morning run document is corrupt', () => {
    const read = readRunDoc('today', { ...valid, perStage: 'broken' });
    const choice = chooseDigest(
      read ? [read.run] : [],
      '2026-10-07',
      new Date('2026-10-07T07:30:00Z'),
    );
    expect(choice.state).toBe('failed');
    expect(choice.run?.id).toBe('today');
  });
});
