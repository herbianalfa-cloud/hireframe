import { describe, expect, it } from 'vitest';

import { nextScheduledRun, SCHEDULE } from './schedule.js';

const next = (iso: string) => nextScheduledRun(new Date(iso)).toISOString();

describe('nextScheduledRun', () => {
  it('is 07:30 and 17:30 on weekdays (October 2026 is BST)', () => {
    // Mon 12 Oct 2026, BST = UTC+1
    expect(next('2026-10-12T06:29:00Z')).toBe('2026-10-12T06:30:00.000Z'); // 07:29 -> 07:30
    expect(next('2026-10-12T06:30:00Z')).toBe('2026-10-12T16:30:00.000Z'); // 07:30 -> 17:30
    expect(next('2026-10-12T16:30:00Z')).toBe('2026-10-13T06:30:00.000Z'); // 17:30 -> Tue 07:30
  });

  it('skips the weekend', () => {
    expect(next('2026-10-16T16:31:00Z')).toBe('2026-10-19T06:30:00.000Z'); // Fri 17:31 -> Mon
    expect(next('2026-10-17T10:00:00Z')).toBe('2026-10-19T06:30:00.000Z'); // Sat -> Mon
    expect(next('2026-10-18T23:59:00Z')).toBe('2026-10-19T06:30:00.000Z'); // Sun -> Mon
  });

  it('follows the March clock change (Sunday 29 Mar 2026)', () => {
    // Friday 27 Mar is GMT; Monday 30 Mar 07:30 is BST = 06:30Z.
    expect(next('2026-03-27T17:31:00Z')).toBe('2026-03-30T06:30:00.000Z');
    expect(next('2026-03-29T12:00:00Z')).toBe('2026-03-30T06:30:00.000Z');
    expect(next('2026-03-30T06:30:00Z')).toBe('2026-03-30T16:30:00.000Z');
    // The Friday before is still GMT: 17:30 = 17:30Z.
    expect(next('2026-03-27T07:30:00Z')).toBe('2026-03-27T17:30:00.000Z');
  });

  it('follows the October clock change (Sunday 25 Oct 2026)', () => {
    // Friday 23 Oct is BST; Monday 26 Oct 07:30 is GMT = 07:30Z.
    expect(next('2026-10-23T16:31:00Z')).toBe('2026-10-26T07:30:00.000Z');
    expect(next('2026-10-25T12:00:00Z')).toBe('2026-10-26T07:30:00.000Z');
    expect(next('2026-10-26T07:30:00Z')).toBe('2026-10-26T17:30:00.000Z');
  });

  it('throws on a cron form it does not support', () => {
    const at = new Date('2026-10-12T06:29:00Z');
    for (const cron of ['*/10 7-23 * * *', '30 7,17 1 * 1-5', '30 7,17 * * *', '61 7 * * 1-5']) {
      expect(() => nextScheduledRun(at, { cron, timeZone: 'Europe/London' }), cron).toThrow(
        'Unsupported cron form',
      );
    }
  });

  it('uses the app schedule by default', () => {
    expect(SCHEDULE.timeZone).toBe('Europe/London');
    expect(nextScheduledRun(new Date('2026-10-12T06:29:00Z'))).toEqual(
      new Date('2026-10-12T06:30:00Z'),
    );
  });
});
