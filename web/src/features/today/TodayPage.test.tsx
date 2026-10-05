import { spendMeter } from '@hireframe/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeView } from '@/features/jobs/fixtures';
import {
  loadAgreement,
  loadTodayCounts,
  watchSpend,
  watchTodayList,
  type TodayCountResults,
} from '@/services/dashboard';
import { setJobStatus, watchJob, type JobView } from '@/services/jobs';
import type { LiveState } from '@/services/profile';

import { TodayPage } from './TodayPage';

vi.mock('@/services/dashboard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  watchTodayList: vi.fn(),
  loadTodayCounts: vi.fn(),
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

const COUNTS: TodayCountResults = {
  toApply: 3,
  toReview: 5,
  judgedToday: 12,
  appliedThisWeek: 4,
};

type Lists = Record<string, LiveState<JobView[]>>;
const ready = (...views: JobView[]): LiveState<JobView[]> => ({
  status: 'ready',
  data: views,
  invalid: 0,
});

function setup(lists: Lists, options: { search?: string; kpis?: 'ok' | 'one-fails' } = {}) {
  vi.mocked(watchTodayList).mockImplementation((list, callback) => {
    callback(lists[list] ?? ready());
    return () => undefined;
  });
  vi.mocked(loadTodayCounts).mockResolvedValue(
    options.kpis === 'one-fails' ? { ...COUNTS, toReview: null } : COUNTS,
  );
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
  vi.mocked(loadTodayCounts).mockReset();
  vi.mocked(watchSpend).mockReset();
  vi.mocked(setJobStatus).mockReset().mockResolvedValue();
  vi.mocked(watchJob).mockReset();
  window.localStorage.clear();
  vi.restoreAllMocks();
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

  it('fails one tile on its own and keeps the other numbers and the lists', async () => {
    setup({ apply: ready(makeView('a1', { title: 'Apply role' })) }, { kpis: 'one-fails' });
    expect(
      (await screen.findByText(/Couldn.t load this number/)).closest('[role="alert"]'),
    ).not.toBeNull();
    expect(screen.getAllByText(/Couldn.t load this number/)).toHaveLength(1);
    expect(screen.getByText('12 judged today')).toBeDefined();
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
    expect(loadTodayCounts).toHaveBeenCalledTimes(1);
    screen.getByText('Data Analyst').closest('button')?.focus();
    await userEvent.keyboard('a');
    await waitFor(() => {
      expect(loadTodayCounts).toHaveBeenCalledTimes(2);
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
    setup({ apply: ready(...many), wildcard: ready(...many) });
    const apply = screen.getByRole('link', { name: /see all apply jobs by best overall/i });
    expect(apply.getAttribute('href')).toBe('/jobs?verdict=apply&status=new&sort=best');
    expect(apply.closest('p')?.textContent).toContain('Sorted among the newest 10.');
    const wildcard = screen.getByRole('link', { name: /see all wildcard jobs/i });
    expect(wildcard.getAttribute('href')).toBe('/jobs?verdict=wildcard&status=new');
    expect(wildcard.closest('p')?.textContent).toContain('Showing the newest 10.');
  });
});

describe('sorting and the gap filter', () => {
  const scored = (id: string, fit: number, luck: number, hour: number, overrides = {}) =>
    makeView(id, {
      title: `Role ${id}`,
      fitScore: fit,
      luckScore: luck,
      judgedAt: new Date(Date.UTC(2026, 9, 14, hour)),
      ...overrides,
    });
  const rows = [scored('low', 5, 5, 9), scored('high', 9, 8, 1), scored('mid', 7, 7, 5)];
  const order = (list: string) =>
    within(screen.getByRole('list', { name: `${list} jobs` }))
      .getAllByText(/^Role /)
      .map((el) => el.textContent);
  const sortOf = (list: string) =>
    screen.getByLabelText<HTMLSelectElement>(new RegExp(`^Sort ${list}$`));

  it('defaults Apply to Best overall, and near misses and wildcards to Newest', () => {
    setup({ apply: ready(...rows), near_miss: ready(...rows), wildcard: ready(...rows) });
    expect(sortOf('Apply').value).toBe('best');
    expect(order('Apply')).toEqual(['Role high', 'Role mid', 'Role low']);
    expect(sortOf('Near misses').value).toBe('newest');
    expect(order('Near misses')).toEqual(['Role low', 'Role mid', 'Role high']);
    expect(sortOf('Wildcards').value).toBe('newest');
  });

  it('sorts only the list it belongs to, with no extra reads', async () => {
    setup({ apply: ready(...rows), near_miss: ready(...rows) });
    const reads = vi.mocked(watchTodayList).mock.calls.length;
    await userEvent.selectOptions(sortOf('Near misses'), 'fit');
    expect(order('Near misses')).toEqual(['Role high', 'Role mid', 'Role low']);
    expect(sortOf('Apply').value).toBe('best');
    expect(vi.mocked(watchTodayList).mock.calls.length).toBe(reads);
  });

  it('remembers a choice per list', async () => {
    setup({ apply: ready(...rows) });
    await userEvent.selectOptions(sortOf('Apply'), 'newest');
    expect(window.localStorage.getItem('hf:today-sort:apply')).toBe('newest');
    cleanup();
    setup({ apply: ready(...rows) });
    expect(sortOf('Apply').value).toBe('newest');
  });

  it('ignores a stored value that is not a sort', () => {
    window.localStorage.setItem('hf:today-sort:apply', 'oldest');
    setup({ apply: ready(...rows) });
    expect(sortOf('Apply').value).toBe('best');
  });

  it('still works when localStorage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    setup({ apply: ready(...rows) });
    expect(sortOf('Apply').value).toBe('best');
    await userEvent.selectOptions(sortOf('Apply'), 'newest');
    expect(order('Apply')).toEqual(['Role low', 'Role mid', 'Role high']);
  });

  it('filters near misses by gap and shows the count', async () => {
    const gap = (type: 'tool' | 'domain') => ({ type, text: 'Fake gap' });
    const near = [
      scored('t', 6, 6, 3, { gaps: [gap('tool')] }),
      scored('td', 6, 6, 2, { gaps: [gap('tool'), gap('domain')] }),
      scored('n', 6, 6, 1),
    ];
    setup({ near_miss: ready(...near) });
    expect(screen.getByRole('heading', { name: /Near misses/ }).textContent).toContain('3');
    await userEvent.selectOptions(screen.getByLabelText(/^Gap Near misses$/), 'tool-only');
    expect(order('Near misses')).toEqual(['Role t']);
    expect(screen.getByRole('heading', { name: /Near misses/ }).textContent).toContain('1 of 3');
    await userEvent.selectOptions(screen.getByLabelText(/^Gap Near misses$/), 'domain');
    expect(order('Near misses')).toEqual(['Role td']);
  });

  it('offers the gap select on near misses only', () => {
    setup({ apply: ready(...rows), near_miss: ready(...rows), wildcard: ready(...rows) });
    expect(screen.getAllByLabelText(/^Gap /)).toHaveLength(1);
  });

  it('says so when the gap filter leaves nothing', async () => {
    setup({ near_miss: ready(...rows) });
    await userEvent.selectOptions(screen.getByLabelText(/^Gap Near misses$/), 'tool');
    expect(screen.getByText(/No near misses with this gap in the newest 10/)).toBeDefined();
  });

  it('carries the sort and gap in the footer link', async () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      scored(`n${String(i)}`, 5, 5, i, { gaps: [{ type: 'tool', text: 'Fake gap' }] }),
    );
    setup({ near_miss: ready(...many) });
    await userEvent.selectOptions(screen.getByLabelText(/^Gap Near misses$/), 'tool-only');
    await userEvent.selectOptions(sortOf('Near misses'), 'fit');
    expect(
      screen.getByRole('link', { name: /see all near miss jobs by fit/i }).getAttribute('href'),
    ).toBe('/jobs?verdict=near_miss&status=new&sort=fit&gap=tool-only');
  });

  it('hides the controls while a list is empty or loading', () => {
    setup({ apply: ready() });
    expect(screen.queryByLabelText(/^Sort Apply$/)).toBeNull();
  });
});
