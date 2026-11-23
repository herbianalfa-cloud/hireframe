import { CV_CRITERIA, CV_LIMITS } from '@hireframe/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loadReadyScores } from './applications';

// The Ready card's two reads: the version's `cvs` document and the job's luck score. Firestore is
// faked by path; both documents are parsed by the real schemas.
const state = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  read: [] as string[],
}));

vi.mock('firebase/firestore', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  doc: (_db: unknown, path: string) => ({ path }),
  getDoc: (reference: { path: string }) => {
    state.read.push(reference.path);
    const data = state.docs.get(reference.path);
    return Promise.resolve({ exists: () => data !== undefined, data: () => data });
  },
}));
vi.mock('./firebase', () => ({ getFirebase: () => Promise.resolve({ db: {} }) }));

const cited = { text: 'Built weekly SQL reports for a sales team', factRefs: ['F1'] };
const quality = {
  rubric: 'rubric-v1',
  total: 8.6,
  criteria: Object.fromEntries(CV_CRITERIA.map((name) => [name, 1])),
  findings: [],
  revised: true,
  dashesReplaced: 0,
  layout: { bodySize: 10, fill: 0.97 },
};
const cvDoc = (extra: Record<string, unknown> = {}) => ({
  jobId: 'job1',
  applicationVersion: 1,
  content: {
    summary: cited,
    experience: [],
    projects: [],
    education: [],
    skills: [],
    coverNote: {
      paragraphs: Array.from({ length: CV_LIMITS.noteParagraphsMin }, () => cited),
    },
  },
  aliases: { F1: 'fact-1' },
  factIds: ['fact-1'],
  storagePaths: { cvPdf: 'a.pdf', cvDocx: 'b.docx', notePdf: 'c.pdf', noteDocx: 'd.docx' },
  trimmed: 0,
  model: 'claude-sonnet-5-5',
  costPence: 1.2,
  createdAt: new Date('2026-10-07T09:00:00Z'),
  schemaVersion: 1,
  ...extra,
});

beforeEach(() => {
  state.docs.clear();
  state.read = [];
});

describe('loadReadyScores', () => {
  it('reads the version and the job, and returns the stored quality and the job luck', async () => {
    state.docs.set('cvs/job1-v1', cvDoc({ quality }));
    state.docs.set('jobs/job1', { luckScore: 7 });
    const scores = await loadReadyScores('job1', 'job1-v1');
    expect(scores.luck).toBe(7);
    expect(scores.quality?.total).toBe(8.6);
    expect([...state.read].sort()).toEqual(['cvs/job1-v1', 'jobs/job1']);
  });

  it('has no quality for a version written before scoring, and no luck for an unscored job', async () => {
    state.docs.set('cvs/job1-v1', cvDoc());
    state.docs.set('jobs/job1', { title: 'x' });
    expect(await loadReadyScores('job1', 'job1-v1')).toEqual({ quality: null, luck: null });
  });

  it('has neither when the documents are missing or the luck is not a score', async () => {
    expect(await loadReadyScores('job1', 'job1-v1')).toEqual({ quality: null, luck: null });
    state.docs.set('jobs/job1', { luckScore: 'high' });
    expect((await loadReadyScores('job1', 'job1-v1')).luck).toBeNull();
  });
});
