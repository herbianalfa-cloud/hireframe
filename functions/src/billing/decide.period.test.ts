import { describe, expect, it } from 'vitest';

import { decideGuard } from './decide.js';
import type { BudgetMessage } from './schema.js';

/** The period is compared in America/Los_Angeles (Beeb, 27 Nov), the zone Cloud Billing uses. */
function msg(costIntervalStart: string, costAmount = 25): BudgetMessage {
  return {
    budgetDisplayName: 'hireframe-kill',
    costAmount,
    budgetAmount: 25,
    currencyCode: 'GBP',
    costIntervalStart,
  } as BudgetMessage;
}
const at = (iso: string) => ({ now: Date.parse(iso) });
const armed = (start: string, now: string, cost = 25) =>
  decideGuard(msg(start, cost), 'armed', at(now));
const stale = { outcome: 'ignored', reason: 'stale_period' };

describe('decideGuard: the month is the Pacific month', () => {
  it('DST on: Nov 1 00:00 PDT is 07:00Z and is the current month', () => {
    expect(armed('2026-11-01T07:00:00Z', '2026-11-10T12:00:00Z')).toEqual({ outcome: 'disable' });
  });

  it('DST off: Dec 1 00:00 PST is 08:00Z and is the current month', () => {
    expect(armed('2026-12-01T08:00:00Z', '2026-12-10T12:00:00Z')).toEqual({ outcome: 'disable' });
  });

  it('still the old month in LA while it is already December in UTC', () => {
    expect(armed('2026-11-01T07:00:00Z', '2026-12-01T03:00:00Z')).toEqual({ outcome: 'disable' });
  });

  it('below the budget in that window is below, not stale', () => {
    expect(armed('2026-11-01T07:00:00Z', '2026-12-01T03:00:00Z', 1)).toEqual({ outcome: 'below' });
  });

  it('stale once LA is in the new month', () => {
    expect(armed('2026-11-01T07:00:00Z', '2026-12-01T09:00:00Z')).toEqual(stale);
  });

  it('a start of the new Pacific month, just after it begins, is current', () => {
    expect(armed('2026-12-01T08:00:00Z', '2026-12-01T08:00:01Z')).toEqual({ outcome: 'disable' });
  });

  it('year rollover: Dec to Jan in LA', () => {
    expect(armed('2026-12-01T08:00:00Z', '2027-01-01T07:59:00Z')).toEqual({ outcome: 'disable' });
    expect(armed('2026-12-01T08:00:00Z', '2027-01-01T08:00:00Z')).toEqual(stale);
    expect(armed('2027-01-01T08:00:00Z', '2027-01-01T08:00:01Z')).toEqual({ outcome: 'disable' });
  });

  it('a UTC-1st start that is still last month in LA is stale', () => {
    expect(armed('2026-11-01T00:00:00Z', '2026-11-10T12:00:00Z')).toEqual(stale);
  });

  it('a future or unparseable start stays stale', () => {
    expect(armed('2026-11-10T12:00:01Z', '2026-11-10T12:00:00Z')).toEqual(stale);
    expect(armed('not a date', '2026-11-10T12:00:00Z')).toEqual(stale);
  });

  it('dry run in the boundary window says would_disable', () => {
    expect(decideGuard(msg('2026-11-01T07:00:00Z'), 'dry_run', at('2026-12-01T03:00:00Z'))).toEqual(
      { outcome: 'would_disable' },
    );
  });
});

describe('decideGuard: month starts and the last Pacific hours', () => {
  it.each([
    ['PDT (07:00Z)', '2026-10-01T07:00:00Z', '2026-10-01T07:00:01Z', '2026-11-05T12:00:00Z'],
    ['PST (08:00Z)', '2026-12-01T08:00:00Z', '2026-12-01T08:00:01Z', '2027-01-05T12:00:00Z'],
    [
      'PST (08:00Z), January',
      '2027-01-01T08:00:00Z',
      '2027-01-01T08:00:01Z',
      '2027-02-05T12:00:00Z',
    ],
  ])(
    'a %s month start is current just after it and stale a month later',
    (_l, start, soon, later) => {
      expect(armed(start, soon)).toEqual({ outcome: 'disable' });
      expect(armed(start, later)).toEqual(stale);
    },
  );

  it('the last hours of a Pacific month: already the 1st in UTC, over budget, armed -> disable', () => {
    expect(armed('2026-11-01T07:00:00Z', '2026-12-01T07:59:59Z')).toEqual({ outcome: 'disable' });
  });

  it('just after the Pacific reset the old start is stale', () => {
    expect(armed('2026-11-01T07:00:00Z', '2026-12-01T08:00:00Z')).toEqual(stale);
  });
});

describe('the runtime resolves America/Los_Angeles (full ICU)', () => {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    hourCycle: 'h23',
  });
  it('knows the zone', () => {
    expect(fmt.resolvedOptions().timeZone).toBe('America/Los_Angeles');
  });
  it('formats known instants as Pacific time', () => {
    expect(fmt.format(Date.parse('2026-12-01T07:59:00Z'))).toBe('11/30/2026, 23');
    expect(fmt.format(Date.parse('2026-12-01T08:00:00Z'))).toBe('12/1/2026, 00');
    expect(fmt.format(Date.parse('2026-11-01T07:00:00Z'))).toBe('11/1/2026, 00');
    expect(fmt.format(Date.parse('2026-10-01T07:00:00Z'))).toBe('10/1/2026, 00');
  });
});
