import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loadAgreement } from '@/services/dashboard';
import { loadJobsPage, loadJobsWindow, setJobStatus, watchJob } from '@/services/jobs';

import { makeView } from './fixtures';
import { JobsPage } from './JobsPage';

vi.mock('@/services/dashboard', () => ({ loadAgreement: vi.fn() }));
vi.mock('@/services/jobs', () => ({
  JOBS_PAGE_SIZE: 25,
  JOBS_SORT_CAP: 300,
  loadJobsPage: vi.fn(),
  loadJobsWindow: vi.fn(),
  watchJob: vi.fn(),
  loadJobDescription: vi.fn(() => Promise.resolve(null)),
  setJobStatus: vi.fn(),
  rateJob: vi.fn(),
  jobActionErrorMessage: () => 'failed',
}));
vi.mock('@/features/profile/hooks', () => ({
  useFacts: () => ({ status: 'ready', data: [], invalid: 0 }),
}));

const page = (titles: string[], cursor: object | null = null, invalid = 0) => ({
  jobs: titles.map((title, i) => makeView(`j-${title}-${String(i)}`, { title })),
  invalid,
  cursor: cursor as never,
});

function setup(search = '') {
  let location = '';
  function Probe() {
    const l = useLocation();
    location = l.pathname + l.search;
    return null;
  }
  render(
    <MemoryRouter initialEntries={[`/jobs${search}`]}>
      <JobsPage />
      <Probe />
    </MemoryRouter>,
  );
  return { location: () => location };
}

beforeEach(() => {
  vi.mocked(setJobStatus).mockReset().mockResolvedValue();
  vi.mocked(loadJobsPage).mockReset();
  vi.mocked(loadJobsWindow).mockReset();
  vi.mocked(watchJob).mockReset();
  vi.mocked(loadAgreement).mockReset().mockResolvedValue({
    ratedAgree: 2,
    ratedDisagree: 1,
    appliedAgree: 1,
    agree: 3,
    disagree: 1,
    total: 4,
    rate: 0.75,
  });
});

describe('JobsPage', () => {
  it('lists jobs with the agreement line above', async () => {
    vi.mocked(loadJobsPage).mockResolvedValue(page(['Alpha', 'Beta']));
    setup();
    expect(screen.getByRole('status', { name: 'Loading jobs' })).toBeDefined();
    expect(await screen.findByText('Alpha')).toBeDefined();
    expect(screen.getByText('Beta')).toBeDefined();
    expect(await screen.findByText(/Verdict agreement, last 14 days: 75%/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('filters by verdict and status through the URL', async () => {
    vi.mocked(loadJobsPage).mockResolvedValue(page(['Alpha']));
    const probe = setup();
    await screen.findByText('Alpha');
    await userEvent.selectOptions(screen.getByLabelText('Verdict'), 'near_miss');
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'saved');
    expect(probe.location()).toBe('/jobs?verdict=near_miss&status=saved');
    await waitFor(() => {
      expect(loadJobsPage).toHaveBeenLastCalledWith({ verdict: 'near_miss', status: 'saved' });
    });
  });

  it('starts from the filters in the URL and ignores unknown values', async () => {
    vi.mocked(loadJobsPage).mockResolvedValue(page(['Alpha']));
    setup('?verdict=apply&status=bogus');
    await screen.findByText('Alpha');
    expect(loadJobsPage).toHaveBeenCalledWith({ verdict: 'apply' });
  });

  it('shows only jobs waiting for review when asked, and clears the other filters', async () => {
    vi.mocked(loadJobsPage).mockResolvedValue(page(['Alpha']));
    setup('?verdict=apply');
    await screen.findByText('Alpha');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Needs review' }));
    await waitFor(() => {
      expect(loadJobsPage).toHaveBeenLastCalledWith({ needsReview: true });
    });
    expect(screen.getByLabelText<HTMLSelectElement>('Verdict').disabled).toBe(true);
  });

  it('loads more with the cursor and appends', async () => {
    const cursor = { id: 'cursor' };
    vi.mocked(loadJobsPage)
      .mockResolvedValueOnce(page(['Alpha'], cursor))
      .mockResolvedValueOnce(page(['Beta']));
    setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Beta')).toBeDefined();
    expect(screen.getByText('Alpha')).toBeDefined();
    expect(loadJobsPage).toHaveBeenLastCalledWith({}, cursor);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('has an empty state with and without filters, and an error state', async () => {
    vi.mocked(loadJobsPage).mockResolvedValue(page([]));
    const { unmount } = renderEmpty();
    expect(await screen.findByText('No judged jobs yet')).toBeDefined();
    unmount();
    setup('?verdict=wildcard');
    expect(await screen.findByText('No jobs match these filters')).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => {
      expect(loadJobsPage).toHaveBeenLastCalledWith({});
    });
  });

  it('shows an error when the page cannot load', async () => {
    vi.mocked(loadJobsPage).mockRejectedValue(new Error('offline'));
    setup();
    expect((await screen.findByRole('alert')).textContent).toContain("Couldn't load jobs");
  });

  it('counts jobs that could not be read', async () => {
    vi.mocked(loadJobsPage).mockResolvedValue(page(['Alpha'], null, 2));
    setup();
    expect(await screen.findByText(/2 jobs couldn.t be read and were left out/)).toBeDefined();
  });

  it('opens a job into ?job= and keeps the filters when it closes', async () => {
    const view = makeView('j1', { title: 'Alpha' });
    vi.mocked(loadJobsPage).mockResolvedValue({ jobs: [view], invalid: 0, cursor: null });
    vi.mocked(watchJob).mockImplementation((_id, callback) => {
      callback({ status: 'ready', data: view, invalid: 0 });
      return () => undefined;
    });
    const probe = setup('?verdict=apply');
    await userEvent.click(await screen.findByText('Alpha'));
    expect(probe.location()).toBe('/jobs?verdict=apply&job=j1');
    await screen.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(probe.location()).toBe('/jobs?verdict=apply');
    });
  });
});

describe('actions on the Jobs list', () => {
  const row = (title: string) => screen.getByRole('button', { name: new RegExp(title) });

  async function loadTwoPages() {
    const alpha = makeView('a', { title: 'Alpha' });
    const beta = makeView('b', { title: 'Beta' });
    vi.mocked(loadJobsPage)
      .mockResolvedValueOnce({ jobs: [alpha], invalid: 0, cursor: { id: 'c' } as never })
      .mockResolvedValueOnce({ jobs: [beta], invalid: 0, cursor: null });
    const probe = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await screen.findByText('Beta');
    return probe;
  }

  it('updates the row in place: no reload, loaded pages and focus kept', async () => {
    await loadTwoPages();
    expect(loadJobsPage).toHaveBeenCalledTimes(2);
    row('Alpha').focus();
    await userEvent.keyboard('s');
    await waitFor(() => {
      expect(row('Alpha').textContent).toContain('skipped');
    });
    expect(loadJobsPage).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Beta')).toBeDefined();
    expect(document.activeElement).toBe(row('Alpha'));
    expect(screen.queryByRole('status', { name: 'Loading jobs' })).toBeNull();
  });

  it('puts the row back and shows the error when the write is refused', async () => {
    vi.mocked(setJobStatus).mockRejectedValue(new Error('This job changed since you opened it.'));
    await loadTwoPages();
    row('Beta').focus();
    await userEvent.keyboard('a');
    expect((await screen.findByRole('alert')).textContent).toBe('failed');
    expect(row('Beta').textContent).not.toContain('applied');
    expect(screen.getByText('Alpha')).toBeDefined();
  });

  it('keeps an edit made while Load more is in flight, and never lists a job twice', async () => {
    const alpha = makeView('a', { title: 'Alpha' });
    const beta = makeView('b', { title: 'Beta' });
    let finish: (value: Awaited<ReturnType<typeof loadJobsPage>>) => void = () => undefined;
    vi.mocked(loadJobsPage)
      .mockResolvedValueOnce({ jobs: [alpha], invalid: 0, cursor: { id: 'c' } as never })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
    setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    row('Alpha').focus();
    await userEvent.keyboard('s');
    await waitFor(() => {
      expect(row('Alpha').textContent).toContain('skipped');
    });
    finish({ jobs: [alpha, beta], invalid: 0, cursor: null });
    await screen.findByText('Beta');
    expect(screen.getAllByText('Alpha')).toHaveLength(1);
    expect(row('Alpha').textContent).toContain('skipped');
  });

  it('shows an action taken in the detail sheet on its row', async () => {
    const alpha = makeView('a', { title: 'Alpha' });
    vi.mocked(loadJobsPage).mockResolvedValue({ jobs: [alpha], invalid: 0, cursor: null });
    vi.mocked(watchJob).mockImplementation((_id, callback) => {
      callback({ status: 'ready', data: alpha, invalid: 0 });
      return () => undefined;
    });
    setup('?job=a');
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.getAllByText(/saved/i).length).toBeGreaterThan(0);
    });
    expect(loadJobsPage).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog')).toBeDefined();
  });
});

describe('sort and filters', () => {
  const CAP_NOTE =
    "Only the newest 300 jobs for this verdict and status were read, so older jobs that fit your sort or filters aren't shown.";
  const windowOf = (views: ReturnType<typeof makeView>[], capped = false) => ({
    jobs: views,
    invalid: 0,
    capped,
  });
  const scored = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      makeView(`s${String(i).padStart(3, '0')}`, {
        title: `Job ${String(i).padStart(3, '0')}`,
        fitScore: i % 10,
        luckScore: 0,
        judgedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)),
      }),
    );
  const titles = () =>
    screen
      .getAllByRole('button', { name: /^Job \d+/ })
      .map((el) => /Job \d+/.exec(el.textContent)?.[0]);

  it('reads the sort, lane and gap from the URL and writes them back', async () => {
    vi.mocked(loadJobsWindow).mockResolvedValue(
      windowOf([
        makeView('a', {
          title: 'Alpha',
          gaps: [{ type: 'tool', text: 'Fake gap' }],
          triage: {
            lane: 'primary',
            seniority: 'mid',
            blockers: [],
            pass: true,
            triageScore: 5,
            note: 'Fake note.',
          },
        }),
      ]),
    );
    const probe = setup('?verdict=near_miss&sort=best&lane=primary&gap=tool');
    await screen.findByText('Alpha');
    expect(screen.getByLabelText<HTMLSelectElement>('Sort').value).toBe('best');
    expect(screen.getByLabelText<HTMLSelectElement>('Lane').value).toBe('primary');
    expect(screen.getByLabelText<HTMLSelectElement>('Gap').value).toBe('tool');
    await userEvent.selectOptions(screen.getByLabelText('Sort'), 'luck');
    expect(probe.location()).toContain('sort=luck');
    await userEvent.selectOptions(screen.getByLabelText('Lane'), 'secondary');
    expect(probe.location()).toContain('lane=secondary');
    await userEvent.selectOptions(screen.getByLabelText('Sort'), 'newest');
    expect(probe.location()).not.toContain('sort=');
  });

  it('falls back to the defaults for invalid values', async () => {
    vi.mocked(loadJobsPage).mockResolvedValue(page(['Alpha']));
    setup('?sort=oldest&lane=none&gap=tool');
    await screen.findByText('Alpha');
    expect(screen.getByLabelText<HTMLSelectElement>('Sort').value).toBe('newest');
    expect(screen.getByLabelText<HTMLSelectElement>('Lane').value).toBe('');
    expect(loadJobsWindow).not.toHaveBeenCalled();
  });

  it('switching to Best does one full read, orders across Show more, and reads no more', async () => {
    vi.mocked(loadJobsPage).mockResolvedValue(page(['Alpha']));
    vi.mocked(loadJobsWindow).mockResolvedValue(windowOf(scored(60)));
    setup();
    await screen.findByText('Alpha');
    await userEvent.selectOptions(screen.getByLabelText('Sort'), 'best');
    await screen.findByText('Job 009');
    expect(loadJobsWindow).toHaveBeenCalledTimes(1);
    expect(loadJobsWindow).toHaveBeenLastCalledWith({});
    const first = titles();
    expect(first).toHaveLength(25);
    // Every fit-9 job (six of them) comes before any fit-8 job.
    expect(first.slice(0, 6).every((t) => Number(t?.slice(-1)) === 9)).toBe(true);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    const second = titles();
    expect(second).toHaveLength(50);
    expect(second.slice(0, 25)).toEqual(first);
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(titles()).toHaveLength(60);
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    expect(loadJobsWindow).toHaveBeenCalledTimes(1);
    expect(loadJobsPage).toHaveBeenCalledTimes(1);
  });

  it('notes when the full read hit the cap, and not otherwise', async () => {
    vi.mocked(loadJobsWindow).mockResolvedValueOnce(windowOf(scored(3), true));
    const { unmount } = render(
      <MemoryRouter initialEntries={['/jobs?sort=fit']}>
        <JobsPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(CAP_NOTE)).toBeDefined();
    unmount();
    vi.mocked(loadJobsWindow).mockResolvedValueOnce(windowOf(scored(3)));
    setup('?sort=fit');
    await screen.findByText('Job 000');
    expect(screen.queryByText(CAP_NOTE)).toBeNull();
  });

  it('shows the cap note with the empty state, since older jobs may match', async () => {
    vi.mocked(loadJobsWindow).mockResolvedValue(
      windowOf([makeView('a', { title: 'Alpha' })], true),
    );
    setup('?sort=fit&lane=primary');
    expect(await screen.findByText('No jobs match these filters')).toBeDefined();
    expect(screen.getByText(CAP_NOTE)).toBeDefined();
  });

  it('notes the cap for Newest with a lane filter too', async () => {
    vi.mocked(loadJobsWindow).mockResolvedValue(
      windowOf([makeView('a', { title: 'Alpha' })], true),
    );
    setup('?lane=primary');
    expect(await screen.findByText('No jobs match these filters')).toBeDefined();
    expect(screen.getByText(CAP_NOTE)).toBeDefined();
  });

  it('starts Show more over when the verdict changes', async () => {
    vi.mocked(loadJobsWindow).mockResolvedValue(windowOf(scored(60)));
    setup('?sort=fit');
    await screen.findByText('Job 009');
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(titles()).toHaveLength(50);
    await userEvent.selectOptions(screen.getByLabelText('Verdict'), 'apply');
    await waitFor(() => {
      expect(loadJobsWindow).toHaveBeenLastCalledWith({ verdict: 'apply' });
    });
    await screen.findByRole('button', { name: 'Show more' });
    expect(titles()).toHaveLength(25);
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(titles()).toHaveLength(50);
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'saved');
    await waitFor(() => {
      expect(loadJobsWindow).toHaveBeenLastCalledWith({ verdict: 'apply', status: 'saved' });
    });
    await screen.findByRole('button', { name: 'Show more' });
    expect(titles()).toHaveLength(25);
  });

  it('shows the Gap select only for near misses, and clears it when the verdict changes', async () => {
    vi.mocked(loadJobsPage).mockResolvedValue(page(['Alpha']));
    vi.mocked(loadJobsWindow).mockResolvedValue(
      windowOf([makeView('a', { title: 'Alpha', gaps: [{ type: 'tool', text: 'Fake gap' }] })]),
    );
    const probe = setup('?verdict=near_miss&gap=tool-only');
    await screen.findByText('Alpha');
    expect(screen.getByLabelText('Gap')).toBeDefined();
    await userEvent.selectOptions(screen.getByLabelText('Verdict'), 'apply');
    expect(probe.location()).toBe('/jobs?verdict=apply');
    expect(screen.queryByLabelText('Gap')).toBeNull();
  });

  it('ignores a gap in the URL unless the verdict is near miss', async () => {
    vi.mocked(loadJobsPage).mockResolvedValue(page(['Alpha']));
    setup('?verdict=apply&gap=tool');
    await screen.findByText('Alpha');
    expect(loadJobsWindow).not.toHaveBeenCalled();
  });

  it('filters by gap in the browser', async () => {
    const gap = (type: 'tool' | 'domain') => ({ type, text: 'Fake gap' });
    vi.mocked(loadJobsWindow).mockResolvedValue(
      windowOf([
        makeView('a', { title: 'Alpha', gaps: [gap('tool')] }),
        makeView('b', { title: 'Beta', gaps: [gap('tool'), gap('domain')] }),
        makeView('c', { title: 'Gamma' }),
      ]),
    );
    setup('?verdict=near_miss&gap=tool-only');
    await screen.findByText('Alpha');
    expect(screen.queryByText('Beta')).toBeNull();
    expect(screen.queryByText('Gamma')).toBeNull();
    expect(loadJobsWindow).toHaveBeenCalledWith({ verdict: 'near_miss' });
  });

  it('disables the new controls while Needs review is on and reads the paged list', async () => {
    vi.mocked(loadJobsPage).mockResolvedValue(page(['Alpha']));
    setup('?review=1&sort=best&lane=primary');
    await screen.findByText('Alpha');
    expect(screen.getByLabelText<HTMLSelectElement>('Sort').disabled).toBe(true);
    expect(screen.getByLabelText<HTMLSelectElement>('Lane').disabled).toBe(true);
    expect(screen.getByLabelText<HTMLSelectElement>('Sort').value).toBe('newest');
    expect(loadJobsWindow).not.toHaveBeenCalled();
    expect(loadJobsPage).toHaveBeenLastCalledWith({ needsReview: true });
  });

  it('counts lane and gap as filters: empty state, and Clear keeps the sort', async () => {
    vi.mocked(loadJobsWindow).mockResolvedValue(windowOf([makeView('a', { title: 'Alpha' })]));
    const probe = setup('?sort=fit&lane=primary');
    expect(await screen.findByText('No jobs match these filters')).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => {
      expect(probe.location()).toBe('/jobs?sort=fit');
    });
  });

  it('keeps Newest on cursor paging with Load more', async () => {
    vi.mocked(loadJobsPage).mockResolvedValue(page(['Alpha'], { id: 'c' }));
    setup();
    expect(await screen.findByRole('button', { name: 'Load more' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    expect(loadJobsWindow).not.toHaveBeenCalled();
  });

  it('re-sorts in place when an action changes a row, with no reload', async () => {
    const views = [
      makeView('a', { title: 'Job 001', fitScore: 9, luckScore: 9 }),
      makeView('b', { title: 'Job 002', fitScore: 5, luckScore: 5 }),
    ];
    vi.mocked(loadJobsWindow).mockResolvedValue(windowOf(views));
    setup('?sort=best');
    await screen.findByText('Job 001');
    screen.getByRole('button', { name: /Job 002/ }).focus();
    await userEvent.keyboard('s');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Job 002/ }).textContent).toContain('skipped');
    });
    expect(titles()).toEqual(['Job 001', 'Job 002']);
    expect(loadJobsWindow).toHaveBeenCalledTimes(1);
  });
});

function renderEmpty() {
  return render(
    <MemoryRouter initialEntries={['/jobs']}>
      <JobsPage />
    </MemoryRouter>,
  );
}
