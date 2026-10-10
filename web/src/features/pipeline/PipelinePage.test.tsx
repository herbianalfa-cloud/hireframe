import type { BlockedCode } from '@hireframe/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { saveBlob } from '@/lib/download';
import {
  answerQuestion,
  downloadCvFile,
  loadAppliedThisWeek,
  regenerateApplication,
  retryApplication,
  skipAllQuestions,
  skipQuestion,
  watchStage,
  withdrawApplication,
  type ApplicationView,
  type PipelineStage,
} from '@/services/applications';
import type { LiveState } from '@/services/profile';

import { makeApplication, QUESTION_A, QUESTION_B } from './fixtures';
import { BLOCKED_TEXT } from './labels';
import { PipelinePage } from './PipelinePage';

vi.mock('@/services/applications', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  watchStage: vi.fn(),
  loadAppliedThisWeek: vi.fn(),
  answerQuestion: vi.fn(),
  skipQuestion: vi.fn(),
  skipAllQuestions: vi.fn(),
  retryApplication: vi.fn(),
  regenerateApplication: vi.fn(),
  withdrawApplication: vi.fn(),
  downloadCvFile: vi.fn(),
}));
vi.mock('@/lib/download', () => ({ saveBlob: vi.fn() }));
vi.mock('@/features/profile/hooks', () => ({
  useCvHeader: () => ({
    status: 'ready',
    invalid: 0,
    data: { header: { name: 'Alex Example' }, raw: {} },
  }),
}));

type Lists = Partial<Record<PipelineStage, LiveState<ApplicationView[]>>>;

function given(lists: Lists) {
  vi.mocked(watchStage).mockImplementation((stage, callback) => {
    callback(lists[stage] ?? { status: 'ready', data: [], invalid: 0 });
    return () => undefined;
  });
}

const ready = (...data: ApplicationView[]): LiveState<ApplicationView[]> => ({
  status: 'ready',
  data,
  invalid: 0,
});

function open() {
  return render(
    <MemoryRouter>
      <PipelinePage />
    </MemoryRouter>,
  );
}

function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`No item at ${String(index)}`);
  return item;
}

const RESULT = { jobId: 'job1', stage: 'generating', unanswered: 0 } as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadAppliedThisWeek).mockResolvedValue(3);
  for (const fn of [
    answerQuestion,
    skipQuestion,
    skipAllQuestions,
    retryApplication,
    regenerateApplication,
    withdrawApplication,
  ]) {
    vi.mocked(fn).mockResolvedValue(RESULT);
  }
});

describe('PipelinePage states', () => {
  it('shows a skeleton per section while loading', () => {
    vi.mocked(watchStage).mockImplementation((_stage, callback) => {
      callback({ status: 'loading' });
      return () => undefined;
    });
    open();
    expect(screen.getByRole('status', { name: 'Loading Needs your input' })).toBeDefined();
    expect(screen.getByRole('status', { name: 'Loading Ready to send' })).toBeDefined();
  });

  it('explains how to start when there are no applications at all', async () => {
    given({});
    open();
    expect(await screen.findByText('No applications yet')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Go to Jobs' }).getAttribute('href')).toBe('/jobs');
  });

  it('shows one failing stage as an error and leaves the others intact', () => {
    given({
      generating: { status: 'error', message: "Couldn't load these applications." },
      ready: ready(
        makeApplication('job1', { stage: 'ready', cvIds: ['job1-v1'], currentCvId: 'job1-v1' }),
      ),
    });
    open();
    expect(screen.getByRole('alert').textContent).toBe("Couldn't load these applications.");
    expect(screen.getByRole('button', { name: 'Download CV as PDF' })).toBeDefined();
  });

  it('counts each stage, with Applied this week from the jobs, and "20+" for a full read', async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => makeApplication(`chosen-${String(i)}`));
    given({
      chosen: ready(...twenty),
      needs_input: ready(
        makeApplication('job2', { stage: 'needs_input', questions: [QUESTION_A] }),
      ),
    });
    open();
    const tiles = screen.getByRole('list', { name: 'Stage counts' });
    expect(within(tiles).getByText('20+')).toBeDefined();
    expect(within(tiles).getByText('Applied this week')).toBeDefined();
    expect(await within(tiles).findByText('3')).toBeDefined();
  });

  it('shows a dash when the applied count fails, never a wrong number', async () => {
    vi.mocked(loadAppliedThisWeek).mockRejectedValue(new Error('offline'));
    given({});
    open();
    const tiles = screen.getByRole('list', { name: 'Stage counts' });
    await waitFor(() => {
      const applied = within(tiles).getByText('Applied this week').closest('li');
      expect(applied?.textContent).toContain('–');
    });
  });

  it('labels every stage with text and an icon, not colour alone', () => {
    given({});
    open();
    for (const name of ['Chosen', 'Needs your input', 'Generating', 'Ready to send', 'Applied']) {
      const heading = screen.getByRole('heading', { name: new RegExp(`^${name}`) });
      expect(heading.querySelector('svg')).not.toBeNull();
    }
  });

  it('links each card to its job and never offers Mark applied or Undo', () => {
    given({
      ready: ready(
        makeApplication('job1', { stage: 'ready', cvIds: ['job1-v1'], currentCvId: 'job1-v1' }),
      ),
      applied: ready(makeApplication('job9', { stage: 'applied', stageBefore: 'ready' })),
    });
    open();
    expect(
      screen.getByRole('link', { name: 'Open job: Data Analyst job1' }).getAttribute('href'),
    ).toBe('/jobs?job=job1');
    expect(screen.queryByRole('button', { name: /mark applied/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /undo/i })).toBeNull();
    expect(screen.getByText(/Marked applied/)).toBeDefined();
  });
});

describe('Applied', () => {
  it('shows when it was marked applied (updatedAt, which the mirror writes), not the stage move', () => {
    given({
      applied: ready(
        makeApplication('job9', {
          stage: 'applied',
          stageBefore: 'ready',
          stageAt: new Date('2026-10-01T09:00:00Z'),
          updatedAt: new Date('2026-10-09T09:00:00Z'),
        }),
      ),
    });
    open();
    const card = screen.getByRole('link', { name: 'Open job: Data Analyst job9' }).closest('li');
    expect(card?.textContent).toContain('marked applied 9 Oct 2026');
    expect(card?.textContent).not.toContain('1 Oct 2026');
  });
});

describe('Needs your input', () => {
  const view = makeApplication('job2', {
    stage: 'needs_input',
    questions: [
      QUESTION_A,
      QUESTION_B,
      {
        id: 'q-aaaaaaaaaaaa',
        requirement: 'SQL window functions',
        level: 'must',
        type: 'skill',
        match: 'partial',
        answer: { kind: 'fact', factIds: ['f1'] },
      },
    ],
  });

  it('shows the requirement as text only, never as markup', () => {
    const hostile = makeApplication('job2', {
      stage: 'needs_input',
      questions: [
        {
          ...QUESTION_A,
          requirement: '<img src=x onerror=alert(1)> and <b>bold</b>',
        },
      ],
    });
    given({ needs_input: ready(hostile) });
    const { container } = open();
    expect(screen.getByText('<img src=x onerror=alert(1)> and <b>bold</b>')).toBeDefined();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
  });

  it('shows handled questions as answered or skipped, and asks only the open ones', () => {
    given({ needs_input: ready(view) });
    open();
    expect(screen.getByText('SQL window functions')).toBeDefined();
    expect(screen.getByText('Answered')).toBeDefined();
    expect(screen.getAllByRole('textbox')).toHaveLength(2);
  });

  it('sends an answer, clears the box and reports the saved fact', async () => {
    const user = userEvent.setup();
    given({ needs_input: ready(view) });
    vi.mocked(answerQuestion).mockResolvedValue({
      jobId: 'job2',
      stage: 'needs_input',
      factIds: ['f9'],
      unanswered: 1,
    });
    open();
    const answerButtons = screen.getAllByRole('button', { name: 'Answer' });
    expect((answerButtons[0] as HTMLButtonElement).disabled).toBe(true);
    const box = nth(screen.getAllByRole('textbox'), 0);
    await user.type(box, 'Built dbt models for the finance team');
    await user.click(nth(screen.getAllByRole('button', { name: 'Answer' }), 0));
    expect(answerQuestion).toHaveBeenCalledWith(
      'job2',
      QUESTION_A.id,
      'Built dbt models for the finance team',
    );
    expect(await screen.findByText('Saved as a fact on Profile. 1 left.')).toBeDefined();
    expect((box as HTMLTextAreaElement).value).toBe('');
  });

  it("shows the server's words when an answer can't become a fact, and keeps the text", async () => {
    const user = userEvent.setup();
    given({ needs_input: ready(view) });
    vi.mocked(answerQuestion).mockRejectedValue(
      Object.assign(new Error("Couldn't turn that into a fact: rephrase it or skip"), {
        code: 'functions/invalid-argument',
      }),
    );
    open();
    const box = nth(screen.getAllByRole('textbox'), 0);
    await user.type(box, 'stuff');
    await user.click(nth(screen.getAllByRole('button', { name: 'Answer' }), 0));
    expect((await screen.findByRole('alert')).textContent).toBe(
      "Couldn't turn that into a fact: rephrase it or skip",
    );
    expect((box as HTMLTextAreaElement).value).toBe('stuff');
  });

  it('skips one question, or all of them', async () => {
    const user = userEvent.setup();
    given({ needs_input: ready(view) });
    open();
    await user.click(nth(screen.getAllByRole('button', { name: 'Skip' }), 1));
    expect(skipQuestion).toHaveBeenCalledWith('job2', QUESTION_B.id);
    await user.click(screen.getByRole('button', { name: 'Skip all' }));
    expect(skipAllQuestions).toHaveBeenCalledWith('job2');
  });

  it('offers Skip all only when two or more questions are open', () => {
    given({
      needs_input: ready(
        makeApplication('job3', { stage: 'needs_input', questions: [QUESTION_A] }),
      ),
    });
    open();
    expect(screen.queryByRole('button', { name: 'Skip all' })).toBeNull();
  });
});

describe('Generating', () => {
  it('says how long it usually takes, and names the checks a first draft failed', () => {
    given({
      generating: ready(
        makeApplication('job3', {
          stage: 'generating',
          attempt: 1,
          lastIssues: ['uncited', 'too_long'],
        }),
      ),
    });
    open();
    expect(screen.getByText(/Usually within 15 minutes/)).toBeDefined();
    expect(
      screen.getByText(/a claim had no supporting fact; it didn't fit on one page/),
    ).toBeDefined();
  });
});

describe('Chosen (blocked)', () => {
  it.each(Object.entries(BLOCKED_TEXT) as [BlockedCode, string][])(
    'says why for %s, in words',
    (code, words) => {
      given({
        chosen: ready(
          makeApplication('job4', { stage: 'chosen', blocked: { code, at: new Date() } }),
        ),
      });
      open();
      expect(screen.getByText(words)).toBeDefined();
      expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();
    },
  );

  it('links to Profile for a missing CV header', () => {
    given({
      chosen: ready(
        makeApplication('job4', {
          stage: 'chosen',
          blocked: { code: 'cv_header_missing', at: new Date() },
        }),
      ),
    });
    open();
    expect(screen.getByRole('link', { name: 'Add CV header' }).getAttribute('href')).toBe(
      '/profile',
    );
  });

  it('does not link to Profile for other reasons', () => {
    given({
      chosen: ready(
        makeApplication('job4', { stage: 'chosen', blocked: { code: 'cap', at: new Date() } }),
      ),
    });
    open();
    expect(screen.queryByRole('link', { name: 'Add CV header' })).toBeNull();
  });

  it('retries, and says when it is still blocked', async () => {
    const user = userEvent.setup();
    given({
      chosen: ready(
        makeApplication('job4', {
          stage: 'chosen',
          blocked: { code: 'daily_cap', at: new Date() },
        }),
      ),
    });
    vi.mocked(retryApplication).mockResolvedValue({
      jobId: 'job4',
      stage: 'chosen',
      blocked: 'daily_cap',
      unanswered: 0,
    });
    open();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retryApplication).toHaveBeenCalledWith('job4');
    expect(await screen.findByText(/Still blocked: Today's application budget/)).toBeDefined();
  });

  it('names the last fact-check codes for an invalid output', () => {
    given({
      chosen: ready(
        makeApplication('job4', {
          stage: 'chosen',
          blocked: { code: 'invalid_output', at: new Date() },
          lastIssues: ['unsupported_number'],
        }),
      ),
    });
    open();
    expect(screen.getByText(/a number was not in the cited fact/)).toBeDefined();
  });
});

describe('Ready to send', () => {
  const readyView = makeApplication('job5', {
    stage: 'ready',
    cvIds: ['job5-v1', 'job5-v2'],
    currentCvId: 'job5-v2',
    notes: 'lead with reporting',
  });

  it('downloads each of the four files with the current version and a readable name', async () => {
    const user = userEvent.setup();
    given({ ready: ready(readyView) });
    const blob = new Blob(['x']);
    vi.mocked(downloadCvFile).mockResolvedValue({
      blob,
      fileName: 'Alex Example - CV - Acme Analytics.pdf',
    });
    open();
    const downloads = within(screen.getByRole('list', { name: 'Downloads' }));
    expect(downloads.getAllByRole('button')).toHaveLength(4);

    const cases = [
      ['Download CV as PDF', 'cv', 'pdf'],
      ['Download CV as Word document', 'cv', 'docx'],
      ['Download cover note as PDF', 'cover-note', 'pdf'],
      ['Download cover note as Word document', 'cover-note', 'docx'],
    ] as const;
    for (const [name, kind, format] of cases) {
      await user.click(downloads.getByRole('button', { name }));
      await waitFor(() => {
        expect(downloadCvFile).toHaveBeenLastCalledWith({
          cvId: 'job5-v2',
          kind,
          format,
          headerName: 'Alex Example',
          company: 'Acme Analytics',
        });
      });
    }
    expect(saveBlob).toHaveBeenCalledTimes(4);
    expect(saveBlob).toHaveBeenLastCalledWith(blob, 'Alex Example - CV - Acme Analytics.pdf');
    expect(screen.getByText(/This is version 2/)).toBeDefined();
    expect(screen.getByText('Last notes: lead with reporting')).toBeDefined();
  });

  it('shows a failed download without leaving the page', async () => {
    const user = userEvent.setup();
    given({ ready: ready(readyView) });
    vi.mocked(downloadCvFile).mockRejectedValue(new Error('offline'));
    open();
    await user.click(screen.getByRole('button', { name: 'Download CV as PDF' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Couldn't download/);
    expect(saveBlob).not.toHaveBeenCalled();
  });

  it('regenerates with notes, and without', async () => {
    const user = userEvent.setup();
    given({ ready: ready(readyView) });
    open();
    await user.click(screen.getByRole('button', { name: 'Regenerate with notes' }));
    await user.type(screen.getByLabelText('What should change? (optional)'), 'Shorter summary');
    await user.click(screen.getByRole('button', { name: 'Regenerate' }));
    expect(regenerateApplication).toHaveBeenCalledWith('job5', 'Shorter summary');
    expect(await screen.findByText(/Writing a new version/)).toBeDefined();
  });

  it('withdraws keeping files, or deleting them, after a confirmation', async () => {
    const user = userEvent.setup();
    given({ ready: ready(readyView) });
    open();
    await user.click(screen.getByRole('button', { name: 'Withdraw' }));
    expect(withdrawApplication).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Withdraw, keep files' }));
    expect(withdrawApplication).toHaveBeenLastCalledWith('job5', false);
    await user.click(screen.getByRole('button', { name: 'Withdraw and delete files' }));
    expect(withdrawApplication).toHaveBeenLastCalledWith('job5', true);
  });

  it('can cancel a withdraw', async () => {
    const user = userEvent.setup();
    given({ ready: ready(readyView) });
    open();
    await user.click(screen.getByRole('button', { name: 'Withdraw' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Withdraw' })).toBeDefined();
    expect(withdrawApplication).not.toHaveBeenCalled();
  });

  it('moves focus into the withdraw confirmation, and back to Withdraw on cancel', async () => {
    const user = userEvent.setup();
    given({ ready: ready(readyView) });
    open();
    await user.click(screen.getByRole('button', { name: 'Withdraw' }));
    const panel = screen.getByRole('group', { name: 'Confirm withdraw' });
    expect(document.activeElement).toBe(panel);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Withdraw' }));
  });

  it('moves focus into the notes panel, and back to its button on cancel', async () => {
    const user = userEvent.setup();
    given({ ready: ready(readyView) });
    open();
    await user.click(screen.getByRole('button', { name: 'Regenerate with notes' }));
    expect(document.activeElement).toBe(screen.getByLabelText('What should change? (optional)'));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Regenerate with notes' }),
    );
  });

  it('renders job titles, companies, questions and notes as text, never as markup', async () => {
    const markup = '<img src=x onerror=alert(1)><script>alert(2)</script><b>bold</b>';
    given({
      needs_input: ready(
        makeApplication('job1', {
          stage: 'needs_input',
          job: { title: `Title ${markup}`, company: `Company ${markup}`, verdict: 'apply' },
          questions: [{ ...QUESTION_A, requirement: `Requirement ${markup}` }],
        }),
      ),
      ready: ready(
        makeApplication('job2', {
          stage: 'ready',
          cvIds: ['job2-v1'],
          currentCvId: 'job2-v1',
          notes: `Notes ${markup}`,
        }),
      ),
    });
    const { container } = open();
    // The strings are on the page, as characters.
    expect(container.textContent).toContain(`Title ${markup}`);
    expect(container.textContent).toContain(`Company ${markup}`);
    expect(container.textContent).toContain(`Requirement ${markup}`);
    expect(container.textContent).toContain(`Last notes: Notes ${markup}`);
    // And no element was made from them.
    expect(container.querySelector('img, script, b')).toBeNull();
  });
});
