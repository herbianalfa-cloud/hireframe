import { spendMeter, type TodayKpis } from '@hireframe/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeView } from '@/features/jobs/fixtures';
import { loadAgreement, loadTodayKpis, watchSpend, watchTodayList } from '@/services/dashboard';
import { setJobStatus, watchJob, type JobView } from '@/services/jobs';
import type { LiveState } from '@/services/profile';

import { TodayPage } from './TodayPage';

vi.mock('@/services/dashboard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  watchTodayList: vi.fn(),
  loadTodayKpis: vi.fn(),
  watchSpend: vi.fn(),
  loadAgreement: vi.fn(),
}));
vi.mock('@/services/jobs', () => ({
  watchJob: vi.fn(),
  loadJobDescription: vi.fn(() => Promise.resolve(null)),
  setJobStatus: vi.fn(),
  rateJob: vi.fn(),
  jobActionErrorMessage: () => 'failed',
}));
vi.mock('@/features/profile/hooks', () => ({
  useFacts: () => ({ status: 'ready', data: [], invalid: 0 }),
}));
vi.mock('@/features/criteria/hooks', () => ({
  useCurrentCriteria: () => ({ status: 'ready', criteria: { weekly_target: 10 } }),
}));

const KPIS: TodayKpis = {
  toApply: 3,
  toReview: 5,
  judgedToday: 12,
  appliedThisWeek: 4,
  weeklyTarget: 1,
  weeklyRemaining: 0,
  weeklyMet: true, // recomputed by the page from the criteria target
};

type Lists = Record<string, LiveState<JobView[]>>;
const ready = (...views: JobView[]): LiveState<JobView[]> => ({
  status: 'ready',
  data: views,
  invalid: 0,
});

function setup(lists: Lists, options: { search?: string; kpis?: 'ok' | 'fail' } = {}) {
  vi.mocked(watchTodayList).mockImplementation((list, callback) => {
    callback(lists[list] ?? ready());
    return () => undefined;
  });
  if (options.kpis === 'fail') vi.mocked(loadTodayKpis).mockRejectedValue(new Error('offline'));
  else vi.mocked(loadTodayKpis).mockResolvedValue(KPIS);
  vi.mocked(watchSpend).mockImplementation((_now, callback) => {
    callback({
      status: 'ready',
      data: { meter: spendMeter(1230, 1500), untouched: false },
      invalid: 0,
    });
    return () => undefined;
  });
  vi.mocked(loadAgreement).mockResolvedValue({
    ratedAgree: 0,
    ratedDisagree: 0,
    appliedAgree: 0,
    agree: 0,
    disagree: 0,
    total: 0,
    rate: null,
  });
  let search = '';
  function Probe() {
    search = useLocation().search;
    return null;
  }
  render(
    <MemoryRouter initialEntries={[`/${options.search ?? ''}`]}>
      <TodayPage />
      <Probe />
    </MemoryRouter>,
  );
  return { search: () => search };
}

beforeEach(() => {
  vi.mocked(watchTodayList).mockReset();
  vi.mocked(loadTodayKpis).mockReset();
  vi.mocked(watchSpend).mockReset();
  vi.mocked(setJobStatus).mockReset().mockResolvedValue();
  vi.mocked(watchJob).mockReset();
  performance.clearMeasures('hf:usable');
});

describe('TodayPage', () => {
  it('shows the four tiles and the three lists', async () => {
    setup({
      apply: ready(makeView('a1', { title: 'Apply role' })),
      near_miss: ready(makeView('n1', { title: 'Near role', verdict: 'near_miss' })),
      wildcard: ready(makeView('w1', { title: 'Wild role', verdict: 'wildcard' })),
    });
    await screen.findByText('12 judged today');
    const text = document.body.textContent;
    expect(text).toContain('To apply');
    expect(text).toContain('To review');
    expect(text).toContain('Applied this week');
    expect(text).toContain('4 / 10');
    expect(text).toContain('6 to go');
    expect(text).toContain('£12.30');
    expect(text).toContain('of £15.00');
    for (const heading of ['Apply', 'Near misses', 'Wildcards']) {
      expect(screen.getByRole('heading', { name: new RegExp(heading) })).toBeDefined();
    }
    expect(
      within(screen.getByRole('list', { name: 'Apply jobs' })).getByText('Apply role'),
    ).toBeDefined();
    expect(screen.getByText('Near role')).toBeDefined();
    expect(screen.getByText('Wild role')).toBeDefined();
  });

  it('warns amber from 80% of the cap', async () => {
    setup({});
    await screen.findByText(/82% of the monthly cap used/);
    expect(
      screen
        .getByRole('progressbar', { name: 'AI spend this month' })
        .getAttribute('aria-valuetext'),
    ).toBe('£12.30 of £15.00');
  });

  it('has designed empty, loading and error states per list', async () => {
    setup({
      apply: { status: 'loading' },
      near_miss: ready(),
      wildcard: { status: 'error', message: "Couldn't load this list. Reload to try again." },
    });
    expect(screen.getByRole('status', { name: 'Loading Apply' })).toBeDefined();
    expect(document.body.textContent).toContain('No near misses waiting.');
    expect((await screen.findAllByRole('alert'))[0]?.textContent).toContain(
      "Couldn't load this list",
    );
  });

  it('says so when the numbers cannot load, and still shows the lists', async () => {
    setup({ apply: ready(makeView('a1', { title: 'Apply role' })) }, { kpis: 'fail' });
    expect((await screen.findByText(/Couldn.t load the numbers/)).getAttribute('role')).toBe(
      'alert',
    );
    expect(screen.getByText('Apply role')).toBeDefined();
  });

  it('opens a job in the sheet through the URL and closes back to Today', async () => {
    const view = makeView('a1', { title: 'Apply role' });
    vi.mocked(watchJob).mockImplementation((_id, callback) => {
      callback({ status: 'ready', data: view, invalid: 0 });
      return () => undefined;
    });
    const probe = setup({ apply: ready(view) });
    await userEvent.click(await screen.findByText('Apply role'));
    expect(probe.search()).toBe('?job=a1');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Apply role' })).toBeDefined();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(probe.search()).toBe('');
    });
  });

  it('opens straight to a job from a link', async () => {
    const view = makeView('a1', { title: 'Linked role' });
    vi.mocked(watchJob).mockImplementation((_id, callback) => {
      callback({ status: 'ready', data: view, invalid: 0 });
      return () => undefined;
    });
    setup({}, { search: '?job=a1' });
    expect((await screen.findByRole('dialog')).textContent).toContain('Linked role');
  });

  it('refreshes the numbers after a keyboard action', async () => {
    setup({ apply: ready(makeView('a1')) });
    await screen.findByText('12 judged today');
    expect(loadTodayKpis).toHaveBeenCalledTimes(1);
    screen.getByText('Data Analyst').closest('button')?.focus();
    await userEvent.keyboard('a');
    await waitFor(() => {
      expect(loadTodayKpis).toHaveBeenCalledTimes(2);
    });
  });

  it('marks hf:usable once the tiles and the Apply list are filled', async () => {
    setup({ apply: ready(makeView('a1')) });
    await waitFor(() => {
      expect(performance.getEntriesByName('hf:usable')).toHaveLength(1);
    });
  });

  it('links to the full list when a list is truncated', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      makeView(`a${String(i)}`, { title: `Role ${String(i)}` }),
    );
    setup({ apply: ready(...many) });
    expect(screen.getByRole('link', { name: /see all apply jobs/i }).getAttribute('href')).toBe(
      '/jobs?verdict=apply',
    );
  });
});
