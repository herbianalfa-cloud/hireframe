import type { Fact } from '@hireframe/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acceptReview,
  addFact,
  archiveFact,
  cvKindOf,
  keepReview,
  parseCv,
  unarchiveFact,
  updateFact,
  uploadCv,
  watchDocuments,
  watchFacts,
  watchFactVersions,
  type DocumentView,
  type FactView,
} from '@/services/profile';

import { ProfilePage } from './ProfilePage';

vi.mock('@/services/profile', () => ({
  watchFacts: vi.fn(),
  watchDocuments: vi.fn(),
  watchFactVersions: vi.fn(),
  cvKindOf: vi.fn(),
  uploadCv: vi.fn(),
  parseCv: vi.fn(),
  addFact: vi.fn(),
  updateFact: vi.fn(),
  archiveFact: vi.fn(),
  unarchiveFact: vi.fn(),
  acceptReview: vi.fn(),
  keepReview: vi.fn(),
  callableErrorMessage: vi.fn(() => 'Something went wrong. Try again.'),
  writeErrorMessage: vi.fn(() => "Couldn't save. Check your connection and try again."),
}));

const NOW = new Date('2026-10-01T09:00:00Z');

function makeFact(id: string, overrides: Partial<Fact> = {}): FactView {
  const fact: Fact = {
    type: 'skill',
    text: 'Builds dashboards in SQL',
    evidence: 'Built SQL dashboards for the ops team',
    dates: {},
    tags: ['sql'],
    lanes: ['primary'],
    source: 'cv',
    sourceDocId: 'doc-1',
    status: 'active',
    version: 1,
    evidenceVerified: true,
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
    ...overrides,
  };
  return { id, fact, raw: {} };
}

function givenFacts(data: FactView[]) {
  vi.mocked(watchFacts).mockImplementation((callback) => {
    callback({ status: 'ready', data, invalid: 0 });
    return () => undefined;
  });
}

function givenDocuments(data: DocumentView[] = []) {
  vi.mocked(watchDocuments).mockImplementation((callback) => {
    callback({ status: 'ready', data, invalid: 0 });
    return () => undefined;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  givenDocuments();
  vi.mocked(cvKindOf).mockReturnValue('pdf');
});

describe('Profile facts', () => {
  it('groups facts by type and shows where each came from', () => {
    givenFacts([
      makeFact('a', {
        type: 'experience',
        text: 'Ran onboarding at Example Ltd',
        source: 'manual',
      }),
      makeFact('b', { type: 'skill' }),
    ]);
    render(<ProfilePage />);

    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings.indexOf('Skills (1)')).toBeLessThan(headings.indexOf('Experience (1)'));
    expect(screen.getByText('From your CV')).toBeDefined();
    expect(screen.getByText('Added by you')).toBeDefined();
    expect(screen.getByText(/active facts/).textContent).toContain('2 active facts');
  });

  it('shows a designed empty state with no facts', () => {
    givenFacts([]);
    render(<ProfilePage />);
    expect(screen.getByRole('heading', { name: 'No facts yet' })).toBeDefined();
  });

  it('shows a skeleton while loading and an error when facts fail', () => {
    vi.mocked(watchFacts).mockImplementation((callback) => {
      callback({ status: 'loading' });
      return () => undefined;
    });
    const { unmount } = render(<ProfilePage />);
    expect(screen.getByRole('status', { name: 'Loading facts' })).toBeDefined();
    unmount();

    vi.mocked(watchFacts).mockImplementation((callback) => {
      callback({ status: 'error', message: "Couldn't load your facts. Reload to try again." });
      return () => undefined;
    });
    render(<ProfilePage />);
    expect(screen.getByRole('alert').textContent).toContain("Couldn't load your facts");
  });

  it('marks a quote that was not found in the CV', () => {
    givenFacts([makeFact('a', { evidenceVerified: false })]);
    render(<ProfilePage />);
    expect(screen.getByText('Quote not found in the CV')).toBeDefined();
  });

  it('filters by search and by the archived toggle', async () => {
    const user = userEvent.setup();
    givenFacts([
      makeFact('a', { text: 'Builds dashboards in SQL' }),
      makeFact('b', { text: 'Speaks Spanish', tags: ['language'], evidence: 'Spanish (fluent)' }),
      makeFact('c', { text: 'Old role', status: 'archived' }),
    ]);
    render(<ProfilePage />);

    await user.type(screen.getByRole('searchbox', { name: 'Search facts' }), 'language');
    expect(screen.queryByText('Builds dashboards in SQL')).toBeNull();
    expect(screen.getByText('Speaks Spanish')).toBeDefined();

    await user.clear(screen.getByRole('searchbox', { name: 'Search facts' }));
    await user.click(screen.getByRole('button', { name: /Archived/ }));
    expect(screen.getByText('Old role')).toBeDefined();
    expect(screen.queryByText('Speaks Spanish')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Unarchive' }));
    expect(unarchiveFact).toHaveBeenCalledOnce();
  });

  it('archives a fact', async () => {
    const user = userEvent.setup();
    const view = makeFact('a');
    givenFacts([view]);
    vi.mocked(archiveFact).mockResolvedValue();
    render(<ProfilePage />);

    await user.click(screen.getByRole('button', { name: 'Archive' }));
    expect(archiveFact).toHaveBeenCalledWith(view);
  });

  it('shows a fact history, newest first', async () => {
    const user = userEvent.setup();
    const view = makeFact('a', { version: 2 });
    givenFacts([view]);
    vi.mocked(watchFactVersions).mockImplementation((_id, callback) => {
      callback({
        status: 'ready',
        invalid: 0,
        data: [
          { version: 2, entry: { snapshot: view.fact, change: 'edit', at: NOW } },
          {
            version: 1,
            entry: {
              snapshot: { ...view.fact, text: 'Older wording' },
              change: 'created',
              at: NOW,
            },
          },
        ],
      });
      return () => undefined;
    });
    render(<ProfilePage />);

    await user.click(screen.getByRole('button', { name: 'History' }));
    const dialog = screen.getByRole('dialog', { name: 'Fact history' });
    const items = within(dialog).getAllByRole('listitem');
    expect(items[0]?.textContent).toContain('v2 · Edited · 1 Oct 2026');
    expect(items[1]?.textContent).toContain('v1 · Created');
    expect(items[1]?.textContent).toContain('Older wording');
  });
});

describe('Needs review', () => {
  function flagged() {
    return makeFact('a', {
      text: 'Managed a team of 3',
      review: {
        kind: 'changed',
        docId: 'doc-2',
        at: NOW,
        proposed: {
          type: 'skill',
          text: 'Managed a team of 5',
          evidence: 'Managed a team of 5',
          dates: {},
          tags: [],
          lanes: [],
        },
      },
    });
  }

  it('accepts the proposed change', async () => {
    const user = userEvent.setup();
    const view = flagged();
    givenFacts([view]);
    vi.mocked(acceptReview).mockResolvedValue();
    render(<ProfilePage />);

    expect(screen.getByText('Managed a team of 5')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Accept change' }));
    expect(acceptReview).toHaveBeenCalledWith(view);
  });

  it('keeps the current text and reports a failed write', async () => {
    const user = userEvent.setup();
    const view = flagged();
    givenFacts([view]);
    vi.mocked(keepReview).mockRejectedValue(new Error('offline'));
    render(<ProfilePage />);

    await user.click(screen.getByRole('button', { name: 'Keep current' }));
    expect(keepReview).toHaveBeenCalledWith(view);
    expect((await screen.findByRole('alert')).textContent).toContain("Couldn't save");
  });

  it('is hidden when nothing needs review', () => {
    givenFacts([makeFact('a')]);
    render(<ProfilePage />);
    expect(screen.queryByRole('heading', { name: /Needs review/ })).toBeNull();
  });
});

describe('Edit dialog', () => {
  it('saves only the changed fields', async () => {
    const user = userEvent.setup();
    const view = makeFact('a');
    givenFacts([view]);
    vi.mocked(updateFact).mockResolvedValue();
    render(<ProfilePage />);

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit fact' });
    const text = within(dialog).getByLabelText('Text');
    await user.clear(text);
    await user.type(text, 'Builds dashboards in SQL and Python');
    await user.type(within(dialog).getByLabelText('Start date'), '2021-03');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    expect(updateFact).toHaveBeenCalledWith(view, {
      text: 'Builds dashboards in SQL and Python',
      dates: { start: '2021-03' },
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('keeps the CV quote read-only', async () => {
    const user = userEvent.setup();
    givenFacts([makeFact('a')]);
    render(<ProfilePage />);

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const evidence = within(screen.getByRole('dialog')).getByLabelText('Evidence');
    expect((evidence as HTMLTextAreaElement).readOnly).toBe(true);
  });

  it('blocks invalid input with inline errors', async () => {
    const user = userEvent.setup();
    givenFacts([makeFact('a')]);
    render(<ProfilePage />);

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit fact' });
    await user.clear(within(dialog).getByLabelText('Text'));
    await user.type(within(dialog).getByLabelText('Start date'), 'last year');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    expect(within(dialog).getByText(/Enter the fact/)).toBeDefined();
    expect(within(dialog).getByText(/Use YYYY or YYYY-MM, for example/)).toBeDefined();
    expect(updateFact).not.toHaveBeenCalled();
  });

  it('shows the write error and stays open when saving fails', async () => {
    const user = userEvent.setup();
    givenFacts([makeFact('a')]);
    vi.mocked(updateFact).mockRejectedValue(new Error('offline'));
    render(<ProfilePage />);

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit fact' });
    await user.type(within(dialog).getByLabelText('Tags'), ', python');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    expect((await within(dialog).findByRole('alert')).textContent).toContain("Couldn't save");
  });
});

describe('Add a fact', () => {
  it('adds facts and announces the result', async () => {
    const user = userEvent.setup();
    givenFacts([]);
    vi.mocked(addFact).mockResolvedValue({ added: ['x1', 'x2'], skippedDuplicates: 1 });
    render(<ProfilePage />);

    await user.type(screen.getByLabelText('New fact'), 'Led a migration to a new CRM');
    expect(screen.getByText('28/2000')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Add fact' }));

    expect(addFact).toHaveBeenCalledWith('Led a migration to a new CRM');
    expect(await screen.findByText('Added 2 facts · 1 already in your profile')).toBeDefined();
  });

  it('shows the callable error message', async () => {
    const user = userEvent.setup();
    givenFacts([]);
    vi.mocked(addFact).mockRejectedValue(new Error('boom'));
    render(<ProfilePage />);

    await user.type(screen.getByLabelText('New fact'), 'Something');
    await user.click(screen.getByRole('button', { name: 'Add fact' }));
    expect(await screen.findByText('Something went wrong. Try again.')).toBeDefined();
  });
});

describe('Upload CV', () => {
  it('uploads, reads, and shows the summary', async () => {
    const user = userEvent.setup();
    givenFacts([]);
    vi.mocked(uploadCv).mockResolvedValue('doc123');
    let finish: (value: Awaited<ReturnType<typeof parseCv>>) => void = () => undefined;
    vi.mocked(parseCv).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<ProfilePage />);

    const file = new File(['fake cv'], 'alex-example.pdf', { type: 'application/pdf' });
    await user.upload(screen.getByLabelText('CV file (PDF or Word)'), file);

    expect(uploadCv).toHaveBeenCalledWith(file);
    expect(await screen.findByText(/Reading your CV…/)).toBeDefined();
    expect(parseCv).toHaveBeenCalledWith('doc123');

    finish({
      docId: 'doc123',
      summary: {
        factsExtracted: 10,
        added: 7,
        unchanged: 2,
        flagged: 1,
        skippedArchived: 0,
        duplicatesInCv: 0,
        unverified: 3,
        missingFromCv: 0,
      },
    });
    expect(
      await screen.findByText(
        'Added 7, unchanged 2, flagged 1 for review, 3 without a matching quote',
      ),
    ).toBeDefined();
  });

  it('shows the cvKindOf message for an invalid file without uploading', async () => {
    const user = userEvent.setup({ applyAccept: false });
    givenFacts([]);
    vi.mocked(cvKindOf).mockImplementation(() => {
      throw new Error('Choose a PDF or Word (.docx) file.');
    });
    render(<ProfilePage />);

    await user.upload(
      screen.getByLabelText('CV file (PDF or Word)'),
      new File(['x'], 'notes.txt', { type: 'text/plain' }),
    );
    expect(await screen.findByText('Choose a PDF or Word (.docx) file.')).toBeDefined();
    expect(uploadCv).not.toHaveBeenCalled();
  });

  it('lists recent uploads with a readable failure reason', () => {
    givenFacts([]);
    givenDocuments([
      {
        id: 'd1',
        document: {
          kind: 'pdf',
          storagePath: 'x',
          status: 'failed',
          errorCode: 'no_text',
          createdAt: NOW,
          updatedAt: NOW,
          schemaVersion: 1,
        },
      },
      {
        id: 'd2',
        document: {
          kind: 'docx',
          storagePath: 'y',
          status: 'parsing',
          createdAt: NOW,
          updatedAt: NOW,
          schemaVersion: 1,
        },
      },
    ]);
    render(<ProfilePage />);

    expect(screen.getByText('Failed')).toBeDefined();
    expect(screen.getByText(/No text could be read/)).toBeDefined();
    expect(screen.getByText('Reading')).toBeDefined();
  });
});
