import { CV_LIMITS, type CvFileFormat, type CvFileKind } from '@hireframe/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { downloadCvFile } from './applications';

// The path a download reads comes from the `cvs` document, not from the cvId or a file-name
// pattern. Firestore and Storage are faked; the document is parsed by the real schema.
const state = vi.hoisted(() => ({
  data: undefined as Record<string, unknown> | undefined,
  refs: [] as string[],
  docPaths: [] as string[],
}));

vi.mock('firebase/firestore', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  doc: (_db: unknown, path: string) => {
    state.docPaths.push(path);
    return { path };
  },
  getDoc: () =>
    Promise.resolve({
      exists: () => state.data !== undefined,
      data: () => state.data,
    }),
}));
vi.mock('firebase/storage', () => ({
  ref: (_storage: unknown, path: string) => {
    state.refs.push(path);
    return { path };
  },
  getBlob: (reference: { path: string }) => Promise.resolve(new Blob([reference.path])),
}));
vi.mock('./firebase', () => ({
  getFirebase: () => Promise.resolve({ db: {} }),
  getStorageClient: () => Promise.resolve({}),
}));

const cited = { text: 'Built weekly SQL reports for a sales team', factRefs: ['F1'] };

const cvDoc = (storagePaths: Record<string, string>) => ({
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
  storagePaths,
  trimmed: 0,
  model: 'claude-sonnet-5-5',
  costPence: 1.2,
  createdAt: new Date('2026-10-07T09:00:00Z'),
  schemaVersion: 1,
});

// Deliberately not the layout code writes today: the name must not matter.
const PATHS = {
  cvPdf: 'cvs/layout-b/one.pdf',
  cvDocx: 'cvs/layout-b/two.docx',
  notePdf: 'cvs/layout-b/three.pdf',
  noteDocx: 'cvs/layout-b/four.docx',
};

beforeEach(() => {
  state.data = cvDoc(PATHS);
  state.refs = [];
  state.docPaths = [];
});

describe('downloadCvFile', () => {
  const cases: [CvFileKind, CvFileFormat, string][] = [
    ['cv', 'pdf', PATHS.cvPdf],
    ['cv', 'docx', PATHS.cvDocx],
    ['cover-note', 'pdf', PATHS.notePdf],
    ['cover-note', 'docx', PATHS.noteDocx],
  ];

  for (const [kind, format, path] of cases) {
    it(`reads ${kind} as ${format} from the document's storagePaths`, async () => {
      const file = await downloadCvFile({
        cvId: 'job1-v1',
        kind,
        format,
        headerName: 'Alex Example',
        company: 'Acme Ltd',
      });
      expect(state.docPaths).toEqual(['cvs/job1-v1']);
      expect(state.refs).toEqual([path]);
      expect(await file.blob.text()).toBe(path);
    });
  }

  it('never builds a path from the cvId', async () => {
    await downloadCvFile({
      cvId: '../other-job-v9',
      kind: 'cv',
      format: 'pdf',
      headerName: undefined,
      company: 'Acme',
    });
    expect(state.refs).toEqual([PATHS.cvPdf]);
    expect(state.refs.join()).not.toContain('other-job');
  });

  it('refuses a version that has no document, without touching Storage', async () => {
    state.data = undefined;
    await expect(
      downloadCvFile({
        cvId: 'job1-v1',
        kind: 'cv',
        format: 'pdf',
        headerName: undefined,
        company: 'Acme',
      }),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect(state.refs).toEqual([]);
  });
});
