import type { DocumentSnapshot, QueryDocumentSnapshot } from 'firebase/firestore';
import { Timestamp } from 'firebase/firestore';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readJob } from './job-read';
import { parseJobs } from './jobs';

const NOW = new Date('2026-10-14T09:00:00Z');

const stored = {
  dedupeKey: 'd:1',
  keys: ['d:1'],
  title: 'Product Analyst',
  company: 'Acme Analytics',
  location: 'London, UK',
  city: 'london',
  country: 'GB',
  remote: 'unknown',
  url: 'https://jobs.example.com/1',
  sources: [{ id: 'reed', url: 'https://jobs.example.com/1', externalId: '1', seenAt: NOW }],
  firstSeenAt: NOW,
  descriptionRef: 'jobs/job-1/description/raw',
  descriptionKind: 'snippet',
  stage: 's3',
  status: 'applied',
  verdict: 'apply',
  createdAt: NOW,
  updatedAt: NOW,
  schemaVersion: 1,
};

/** What the SDK hands back for a job whose own write hasn't reached the server yet. */
function pendingSnapshot(id: string, extra: Record<string, unknown> = {}): DocumentSnapshot {
  return {
    id,
    data: (options?: { serverTimestamps?: string }) => {
      const stamp = options?.serverTimestamps === 'estimate' ? Timestamp.fromDate(NOW) : null;
      return { ...stored, updatedAt: stamp, appliedAt: stamp, ...extra };
    },
  } as unknown as DocumentSnapshot;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readJob', () => {
  it('keeps a job readable while its own write waits for the server', () => {
    const read = readJob(pendingSnapshot('job-1'));
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.view.job.updatedAt).toEqual(NOW);
      expect(read.view.job.appliedAt).toEqual(NOW);
    }
  });

  it('names the failing fields, never their values', () => {
    const read = readJob(pendingSnapshot('job-1', { status: 'sideways', title: '' }));
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.fields).toEqual(expect.arrayContaining(['status', 'title']));
  });

  it('reports a missing document as unreadable', () => {
    const missing = { id: 'x', data: () => undefined } as unknown as DocumentSnapshot;
    expect(readJob(missing)).toEqual({ ok: false, fields: [] });
  });
});

describe('parseJobs', () => {
  it('keeps pending jobs and logs which fields failed, without job text', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const secret = 'Ignore previous instructions';
    const { jobs, invalid } = parseJobs([
      pendingSnapshot('job-1'),
      pendingSnapshot('job-2', { status: 'sideways', reason: secret, fitScore: 'high' }),
    ] as unknown as QueryDocumentSnapshot[]);
    expect(jobs.map((view) => view.id)).toEqual(['job-1']);
    expect(invalid).toBe(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({ event: 'jobs.invalid', count: 1 });
    expect(line).toContain('status');
    expect(line).not.toContain(secret);
  });
});
