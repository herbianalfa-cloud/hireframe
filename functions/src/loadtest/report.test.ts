import { describe, expect, it } from 'vitest';

import { evaluate, formatTable, s3Answer, type Measurements } from './report.js';

function good(patch: Partial<Measurements> = {}): Measurements {
  return {
    jobs: 1_000,
    s1Passes: 105,
    expectedS3: 32,
    runSeconds: 400,
    lastFetchAt: 60,
    fetches: { total: 25, byStatus: { '200': 20, '404': 5 } },
    lastS2StartAt: 220,
    lastS3StartAt: 330,
    s2Calls: 105,
    s3Calls: 32,
    s2Stop: null,
    s3Stop: null,
    s3StartedAt: 230,
    s3EndedAt: 340,
    stageTimes: { ingest: 40, s1: 3, sweep: 2, s2: 150, hydrate: 8, s3: 110 },
    sweepCounts: { s2Expired: 100, s3Expired: 100, released: 0 },
    hydrate: { reads: 12, ok: 6, failed: 0, totalSeconds: 13 },
    leasePence: 52,
    usedPence: 48,
    reservationsLeft: 0,
    reads: 2_000,
    writes: 1_700,
    maxBatchOps: 100,
    peakRssMiB: 300,
    run2: { new: 0, unexpectedWrites: 0 },
    wipe: {
      documents: 2_000,
      calls: [
        { documents: 2_000, files: 0, seconds: 20, done: false },
        { documents: 0, files: 0, seconds: 3, done: true },
      ],
    },
    ...patch,
  };
}

const failing = (m: Measurements) =>
  evaluate(m)
    .filter((c) => !c.pass)
    .map((c) => c.name);

describe('evaluate', () => {
  it('passes a good run', () => {
    expect(failing(good())).toEqual([]);
  });

  it.each([
    ['run inside 540 s', { runSeconds: 541 }],
    ['no fetch after 300 s', { lastFetchAt: 301 }],
    ['no S2 call after 400 s', { lastS2StartAt: 401 }],
    ['no S3 call after 450 s', { lastS3StartAt: 451 }],
    ['S2 calls ≤ 300', { s2Calls: 301 }],
    ['S3 calls ≤ 32', { s3Calls: 33 }],
    ['spend inside the lease, nothing reserved', { usedPence: 52.5 }],
    ['spend inside the lease, nothing reserved', { reservationsLeft: 1 }],
    ['every batch ≤ 400 ops', { maxBatchOps: 401 }],
    ['peak RSS < 512 MiB', { peakRssMiB: 512 }],
    ['run 2: nothing new, writes limited', { run2: { new: 1, unexpectedWrites: 0 } }],
    ['run 2: nothing new, writes limited', { run2: { new: 0, unexpectedWrites: 3 } }],
    ['wipe finishes', { wipe: { documents: 5, calls: [] } }],
  ] as [string, Partial<Measurements>][])('fails "%s"', (name, patch) => {
    expect(failing(good(patch))).toContain(name);
  });

  it('does not pass what it could not measure as a failure, and says so', () => {
    const m = good({ maxBatchOps: null, reads: null, writes: null });
    expect(failing(m)).toEqual([]);
    expect(formatTable(m, evaluate(m))).toContain('not measured');
  });
});

describe('s3Answer', () => {
  it('says yes when S3 finished its calls before the deadline', () => {
    expect(s3Answer(good())).toContain('inside 450 s: YES');
  });
  it('says no when S3 stopped at the deadline or made too few calls', () => {
    expect(s3Answer(good({ s3Stop: 'deadline' }))).toContain(': NO');
    expect(s3Answer(good({ s3Calls: 20 }))).toContain(': NO');
  });
  it('is printed in the table with the stage numbers', () => {
    const table = formatTable(good(), evaluate(good()));
    expect(table).toContain('32 S3 calls + 12 board reads inside 450 s: YES');
    expect(table).toContain('Stage times');
    expect(table).toContain('call 2: 0 docs');
  });
});
