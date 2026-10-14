import { FUNNEL } from '../config.js';

/**
 * The load test's pass criteria and table (pure; plan B4). Times are seconds from the run's
 * invocation unless a name says otherwise. Anything the test could not measure is `null` and
 * is reported as "not measured", never as a pass.
 */
export interface StageTimes {
  ingest: number | null;
  s1: number | null;
  sweep: number | null;
  s2: number | null;
  hydrate: number | null;
  s3: number | null;
}

export interface WipeCall {
  documents: number;
  files: number;
  seconds: number;
  done: boolean;
}

export interface Run2 {
  new: number;
  /** Documents written outside the run doc, sources and company `lastScan`. */
  unexpectedWrites: number;
}

export interface Measurements {
  jobs: number;
  s1Passes: number;
  /** S3 calls expected: the S1 passes that pass S2, at most the S3 cap. */
  expectedS3: number;
  runSeconds: number;
  /** Seconds from invocation to the last HTTP request start; null if none. */
  lastFetchAt: number | null;
  fetches: { total: number; byStatus: Record<string, number> };
  lastS2StartAt: number | null;
  lastS3StartAt: number | null;
  s2Calls: number;
  s3Calls: number;
  s2Stop: string | null;
  s3Stop: string | null;
  s3StartedAt: number | null;
  s3EndedAt: number | null;
  stageTimes: StageTimes;
  sweepCounts: { s2Expired: number; s3Expired: number; released: number };
  hydrate: { reads: number; ok: number; failed: number; totalSeconds: number };
  leasePence: number;
  usedPence: number;
  reservationsLeft: number;
  reads: number | null;
  writes: number | null;
  maxBatchOps: number | null;
  peakRssMiB: number;
  run2: Run2;
  wipe: { documents: number; calls: WipeCall[] };
}

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

const secs = (value: number | null) => (value === null ? 'n/a' : `${value.toFixed(1)} s`);

export function evaluate(
  m: Measurements,
  limits: { runSeconds?: number; rssMiB?: number } = {},
): Check[] {
  const runLimit = limits.runSeconds ?? 540;
  const rssLimit = limits.rssMiB ?? 512;
  const s2Cap = 300;
  const s3Cap = 32;
  const checks: Check[] = [];
  const add = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });

  add(
    'run inside 540 s',
    m.runSeconds < runLimit,
    `${secs(m.runSeconds)} (limit ${String(runLimit)} s)`,
  );
  add(
    'no fetch after 300 s',
    m.lastFetchAt === null || m.lastFetchAt <= 300,
    `last fetch at ${secs(m.lastFetchAt)}`,
  );
  add(
    'no S2 call after 400 s',
    m.lastS2StartAt === null || m.lastS2StartAt <= FUNNEL.s2StopMs / 1000,
    `last S2 call started at ${secs(m.lastS2StartAt)}`,
  );
  add(
    'no S3 call after 450 s',
    m.lastS3StartAt === null || m.lastS3StartAt <= FUNNEL.s3StopMs / 1000,
    `last S3 call started at ${secs(m.lastS3StartAt)}`,
  );
  add('S2 calls ≤ 300', m.s2Calls <= s2Cap, String(m.s2Calls));
  add('S3 calls ≤ 32', m.s3Calls <= s3Cap, String(m.s3Calls));
  add(
    'spend inside the lease, nothing reserved',
    m.usedPence <= m.leasePence + 1e-9 && m.reservationsLeft === 0,
    `used ${m.usedPence.toFixed(2)}p of ${String(m.leasePence)}p, ${String(m.reservationsLeft)} reservations left`,
  );
  add(
    'every batch ≤ 400 ops',
    m.maxBatchOps === null || m.maxBatchOps <= 400,
    m.maxBatchOps === null ? 'not measured' : `largest ${String(m.maxBatchOps)}`,
  );
  add('peak RSS < 512 MiB', m.peakRssMiB < rssLimit, `${m.peakRssMiB.toFixed(0)} MiB`);
  add(
    'run 2: nothing new, writes limited',
    m.run2.new === 0 && m.run2.unexpectedWrites === 0,
    `${String(m.run2.new)} new, ${String(m.run2.unexpectedWrites)} unexpected writes`,
  );
  add(
    'wipe finishes',
    m.wipe.calls.length > 0 && m.wipe.calls[m.wipe.calls.length - 1]?.done === true,
    `${String(m.wipe.calls.length)} calls, ${String(m.wipe.documents)} documents`,
  );
  return checks;
}

/** The question the run exists to answer (ADR-032's open one). Reported, never a gate. */
export function s3Answer(m: Measurements): string {
  const fit =
    m.s3Stop !== 'deadline' &&
    m.s3Calls >= Math.min(32, m.expectedS3) &&
    (m.lastS3StartAt === null || m.lastS3StartAt <= FUNNEL.s3StopMs / 1000);
  const want = Math.min(32, m.expectedS3);
  let why = '';
  if (!fit) {
    if (m.s3Stop === 'deadline') why = ' Time was the limit: S3 stopped at its deadline.';
    else if (m.s3Calls < want) {
      why =
        ` The limit was not time: S3 stopped at ${m.s3Stop ?? 'the end of its queue'} after ` +
        `${String(m.s3Calls)} of ${String(want)} calls` +
        (m.lastS3StartAt === null
          ? '.'
          : `, and the last call started at ${secs(m.lastS3StartAt)}.`);
    } else why = ' A call started after the deadline.';
  }
  return (
    `32 S3 calls + 12 board reads inside 450 s: ${fit ? 'YES' : 'NO'} ` +
    `(S3 ${secs(m.s3StartedAt)} to ${secs(m.s3EndedAt)}; stops.s3 ${m.s3Stop ?? 'none'}; ` +
    `${String(m.s3Calls)} S3 calls; ${String(m.hydrate.reads)} board reads, ` +
    `${String(m.hydrate.ok)} ok, ${secs(m.hydrate.totalSeconds)} in total).${why}`
  );
}

function row(label: string, value: string): string {
  return `  ${label.padEnd(34)}${value}`;
}

export function formatTable(m: Measurements, checks: Check[]): string {
  const t = m.stageTimes;
  const lines = [
    `Load test: ${String(m.jobs)} jobs, ${String(m.s1Passes)} expected S1 passes`,
    '',
    'Stage times (s)',
    row('ingest', secs(t.ingest)),
    row('S1', secs(t.s1)),
    row('sweep', secs(t.sweep)),
    row('S2', secs(t.s2)),
    row('hydrate (inside S3)', secs(t.hydrate)),
    row('S3', secs(t.s3)),
    row('whole run', secs(m.runSeconds)),
    '',
    'Counts',
    row(
      'sweep expired s2 / s3 / released',
      `${String(m.sweepCounts.s2Expired)} / ${String(m.sweepCounts.s3Expired)} / ${String(m.sweepCounts.released)}`,
    ),
    row('S2 calls, stop', `${String(m.s2Calls)}, ${m.s2Stop ?? 'none'}`),
    row('S3 calls, stop', `${String(m.s3Calls)}, ${m.s3Stop ?? 'none'}`),
    row('HTTP requests', `${String(m.fetches.total)} ${JSON.stringify(m.fetches.byStatus)}`),
    row('documents read', m.reads === null ? 'not measured' : String(m.reads)),
    row('documents written', m.writes === null ? 'not measured' : String(m.writes)),
    row('largest batch', m.maxBatchOps === null ? 'not measured' : String(m.maxBatchOps)),
    row('peak RSS', `${m.peakRssMiB.toFixed(0)} MiB`),
    row('lease, used', `${String(m.leasePence)}p, ${m.usedPence.toFixed(2)}p`),
    row(
      'run 2: new, unexpected writes',
      `${String(m.run2.new)}, ${String(m.run2.unexpectedWrites)}`,
    ),
    '',
    `Wipe: ${String(m.wipe.calls.length)} calls, ${String(m.wipe.documents)} documents`,
    ...m.wipe.calls.map(
      (call, index) =>
        `  call ${String(index + 1)}: ${String(call.documents)} docs, ${String(call.files)} files, ${call.seconds.toFixed(1)} s${call.done ? ' (done)' : ''}`,
    ),
    '',
    'Criteria',
    ...checks.map((c) => `  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}: ${c.detail}`),
    '',
    s3Answer(m),
  ];
  return lines.join('\n');
}
