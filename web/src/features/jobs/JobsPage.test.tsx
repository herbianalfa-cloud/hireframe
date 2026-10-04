import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loadAgreement } from '@/services/dashboard';
import { loadJobsPage, watchJob } from '@/services/jobs';

import { makeView } from './fixtures';
import { JobsPage } from './JobsPage';

vi.mock('@/services/dashboard', () => ({ loadAgreement: vi.fn() }));
vi.mock('@/services/jobs', () => ({
  loadJobsPage: vi.fn(),
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
  vi.mocked(loadJobsPage).mockReset();
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

function renderEmpty() {
  return render(
    <MemoryRouter initialEntries={['/jobs']}>
      <JobsPage />
    </MemoryRouter>,
  );
}
