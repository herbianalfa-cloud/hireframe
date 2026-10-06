import { describe, expect, it } from 'vitest';

import { ALERTS } from '../config.js';
import { mergeSenders, nextEmailHealth, OTHER_SENDERS, type IngestTally } from './health.js';

const NOW = new Date('2026-10-07T09:00:00Z');
const LATER = new Date('2026-10-07T09:30:00Z');

const tally = (patch: Partial<IngestTally> = {}): IngestTally => ({
  messages: 2,
  jobs: 7,
  new: 5,
  merged: 1,
  duplicate: 1,
  unparsed: 0,
  deferred: 0,
  durationMs: 1200,
  bySender: new Map([['linkedin.com', { messages: 2, jobs: 7, unparsed: 0, unverifiedLinks: 0 }]]),
  ...patch,
});

describe('nextEmailHealth (sources/email, ADR-047)', () => {
  it('maps a clean request to ok, with the counts under the source health names', () => {
    const health = nextEmailHealth(undefined, tally(), NOW);
    expect(health).toMatchObject({
      status: 'ok',
      lastRunAt: NOW,
      lastOkAt: NOW,
      consecutiveFailures: 0,
      lastCounts: {
        requests: 2,
        fetched: 7,
        new: 5,
        merged: 1,
        duplicate: 1,
        invalid: 0,
        errors: 0,
      },
      bySender: { 'linkedin.com': { messages: 2, jobs: 7, lastAt: NOW } },
    });
    expect(health.lastCounts.errorCode).toBeUndefined();
  });

  it('is degraded when some new messages were unparsed or deferred, failing when all were', () => {
    const some = nextEmailHealth(undefined, tally({ duplicate: 0, unparsed: 1 }), NOW);
    expect(some).toMatchObject({ status: 'degraded', lastCounts: { errorCode: 'unparsed' } });
    const all = nextEmailHealth(undefined, tally({ duplicate: 0, unparsed: 1, deferred: 1 }), NOW);
    expect(all).toMatchObject({ status: 'failing', consecutiveFailures: 1 });
    const deferred = nextEmailHealth(
      undefined,
      tally({ messages: 1, duplicate: 0, deferred: 1 }),
      NOW,
    );
    expect(deferred).toMatchObject({ status: 'failing', lastCounts: { errorCode: 'deferred' } });
  });

  it('is ok when every message was a duplicate (nothing new is not a failure)', () => {
    const health = nextEmailHealth(
      undefined,
      tally({ messages: 3, duplicate: 3, jobs: 0, new: 0, merged: 0 }),
      NOW,
    );
    expect(health.status).toBe('ok');
  });

  it('keeps lastOkAt through a failing request, and counts consecutive failures', () => {
    const ok = nextEmailHealth(undefined, tally(), NOW);
    const bad = tally({ messages: 1, duplicate: 0, unparsed: 1 });
    const first = nextEmailHealth(ok, bad, LATER);
    const second = nextEmailHealth(first, bad, LATER);
    expect(first).toMatchObject({ lastOkAt: NOW, consecutiveFailures: 1 });
    expect(second.consecutiveFailures).toBe(2);
  });
});

describe('mergeSenders', () => {
  const delta = { messages: 1, jobs: 3, unparsed: 0, unverifiedLinks: 1 };

  it('adds running totals per sender domain', () => {
    const once = mergeSenders(undefined, new Map([['a.example', delta]]), NOW);
    const twice = mergeSenders(once, new Map([['a.example', delta]]), LATER);
    expect(twice['a.example']).toEqual({
      messages: 2,
      jobs: 6,
      unparsed: 0,
      unverifiedLinks: 2,
      lastAt: LATER,
    });
  });

  it('lists at most 20 domains and counts the rest under other', () => {
    let senders = {};
    for (let i = 0; i < ALERTS.maxSenderDomains + 3; i++) {
      senders = mergeSenders(senders, new Map([[`d${String(i)}.example`, delta]]), NOW);
    }
    const keys = Object.keys(senders);
    expect(keys.filter((key) => key !== OTHER_SENDERS)).toHaveLength(ALERTS.maxSenderDomains);
    expect((senders as Record<string, { messages: number }>)[OTHER_SENDERS]?.messages).toBe(3);
    // A listed sender keeps its own row once the list is full.
    const again = mergeSenders(senders, new Map([['d0.example', delta]]), LATER);
    expect(again['d0.example']?.messages).toBe(2);
  });
});
