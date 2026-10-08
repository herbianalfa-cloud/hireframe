import { spendMeter, type Run } from '@hireframe/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeView } from '@/features/jobs/fixtures';
import { hfMarks, markOnce, resetMarksForTest } from '@/lib/perf';
import {
  loadAgreement,
  loadSummaryCounts,
  watchAddedByYou,
  watchLastRun,
  watchSpend,
  watchTodayList,
  type SummaryCountResults,
} from '@/services/dashboard';
import { setJobStatus, watchJob, type JobView } from '@/services/jobs';
import type { LiveState } from '@/services/profile';

import { TodayPage } from './TodayPage';

vi.mock('@/services/dashboard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  watchTodayList: vi.fn(),
  watchAddedByYou: vi.fn(),
  loadSummaryCounts: vi.fn(),
  watchLastRun: vi.fn(),
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

const COUNTS: SummaryCountResults = {
  apply: 3,
  nearMiss: 5,
  wildcard: 1,
  appliedThisWeek: 4,
};

const RUN = {
  trigger: 'schedule',
  status: 'succeeded',
  startedAt: new Date('2026-10-14T06:30:00Z'),
} as Run;

type Lists = Record<string, LiveState<JobView[]>>;
const ready = (...views: JobView[]): LiveState<JobView[]> => ({
  status: 'ready',
  data: views,
  invalid: 0,
});

function setup(
  lists: Lists,
  options: {
    search?: string;
    kpis?: 'ok' | 'one-fails';
    /** Holds the counts back until resolved, to show the bar doesn't gate `hf:usable`. */
    counts?: Promise<SummaryCountResults>;
    run?: Run | null;
    added?: LiveState<JobView[]>;
    onAddedStart?: () => void;
    onCountsStart?: () => void;
    deferApply?: boolean;
  } = {},
) {
  vi.mocked(watchAddedByYou).mockImplementation((callback) => {
    options.onAddedStart?.();
    callback(options.added ?? ready());
    return () => undefined;
  });
  vi.mocked(watchTodayList).mockImplementation((list, callback) => {
    // The real service marks the first snapshot; the mock stands in for it.
    const deliver = () => {
      markOnce(`hf:list:${list}`);
      callback(lists[list] ?? ready());
    };
    // The real snapshot arrives after the first render; `deferApply` mimics that for ordering.
    if (options.deferApply && list === 'apply') setTimeout(deliver, 0);
    else deliver();
    return () => undefined;
  });
  vi.mocked(loadSummaryCounts).mockImplementation(async () => {
    options.onCountsStart?.();
    const counts =
      (await options.counts) ??
      (options.kpis === 'one-fails' ? { ...COUNTS, nearMiss: null } : COUNTS);
    markOnce('hf:counts');
    return counts;
  });
  vi.mocked(watchLastRun).mockImplementation((callback) => {
    callback({ status: 'ready', data: options.run === undefined ? RUN : options.run, invalid: 0 });
    return () => undefined;
  });
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
  vi.mocked(watchAddedByYou).mockReset();
  vi.mocked(loadSummaryCounts).mockReset();
  vi.mocked(watchLastRun).mockReset();
  vi.mocked(watchSpend).mockReset();
  vi.mocked(setJobStatus).mockReset().mockResolvedValue();
  vi.mocked(watchJob).mockReset();
  window.localStorage.clear();
  vi.restoreAllMocks();
  performance.clearMeasures('hf:usable');
  resetMarksForTest();
});

describe('TodayPage', () => {
  it('shows the summary bar and the three lists', async () => {
    setup({
      apply: ready(makeView('a1', { title: 'Apply role' })),
      near_miss: ready(makeView('n1', { title: 'Near role', verdict: 'near_miss' })),
      wildcard: ready(makeView('w1', { title: 'Wild role', verdict: 'wildcard' })),
    });
    await screen.findByRole('region', { name: 'Summary' });
    await screen.findByText(/of £15\.00/);
    const text = document.body.textContent;
    expect(text).toContain('Open Apply');
    expect(text).toContain('Open near miss');
    expect(text).toContain('Open wildcard');
    expect(text).not.toContain('judged today');
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
    await screen.findByText(/82% used/);
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

  it('fails one count on its own and keeps the other numbers and the lists', async () => {
    setup({ apply: ready(makeView('a1', { title: 'Apply role' })) }, { kpis: 'one-fails' });
    const bar = within(await screen.findByRole('region', { name: 'Summary' }));
    expect(bar.getAllByText('unavailable')).toHaveLength(1);
    expect(bar.getByRole('link', { name: /Open near miss.*unavailable/ })).toBeDefined();
    expect(bar.getByRole('link', { name: 'Open Apply 3' })).toBeDefined();
    expect(bar.getByRole('link', { name: 'Open wildcard 1' })).toBeDefined();
    expect(bar.getByText('4')).toBeDefined();
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
    await screen.findByRole('region', { name: 'Summary' });
    expect(loadSummaryCounts).toHaveBeenCalledTimes(1);
    screen.getByText('Data Analyst').closest('button')?.focus();
    await userEvent.keyboard('a');
    await waitFor(() => {
      expect(loadSummaryCounts).toHaveBeenCalledTimes(2);
    });
  });

  it('marks hf:usable with the Apply list filled and the counts still pending', async () => {
    let release: (counts: SummaryCountResults) => void = () => undefined;
    const pending = new Promise<SummaryCountResults>((resolve) => {
      release = resolve;
    });
    setup({ apply: ready(makeView('a1')) }, { counts: pending });
    await waitFor(() => {
      expect(performance.getEntriesByName('hf:usable')).toHaveLength(1);
    });
    expect(hfMarks().map(([name]) => name)).not.toContain('hf:counts');
    expect(screen.getByRole('status', { name: 'Loading numbers' })).toBeDefined();
    release(COUNTS);
    expect(await screen.findByRole('region', { name: 'Summary' })).toBeDefined();
    expect(screen.queryByRole('status', { name: 'Loading numbers' })).toBeNull();
  });

  it('starts no count query before hf:usable', async () => {
    const order: string[] = [];
    const measure = performance.measure.bind(performance);
    vi.spyOn(performance, 'measure').mockImplementation((...args) => {
      order.push(`measure:${args[0]}`);
      return measure(...args);
    });
    setup({ apply: ready(makeView('a1')) }, { onCountsStart: () => order.push('counts') });
    await waitFor(() => {
      expect(loadSummaryCounts).toHaveBeenCalledTimes(1);
    });
    expect(order).toEqual(['measure:hf:usable', 'counts']);
  });

  it('shows no count query or last run while the Apply list is loading', () => {
    setup({ apply: { status: 'loading' } });
    expect(screen.getByRole('status', { name: 'Loading numbers' })).toBeDefined();
    expect(loadSummaryCounts).not.toHaveBeenCalled();
    expect(watchLastRun).not.toHaveBeenCalled();
  });

  it('marks hf:today-mount before hf:usable', async () => {
    setup({ apply: ready(makeView('a1')) }, { deferApply: true });
    await waitFor(() => {
      expect(performance.getEntriesByName('hf:usable')).toHaveLength(1);
    });
    await waitFor(() => {
      expect(hfMarks().map(([name]) => name)).toContain('hf:counts');
    });
    const names = hfMarks().map(([name]) => name);
    const at = (name: string) => names.indexOf(name);
    expect(at('hf:today-mount')).toBeGreaterThanOrEqual(0);
    expect(at('hf:today-mount')).toBeLessThan(at('hf:list:apply'));
    expect(at('hf:list:apply')).toBeLessThan(at('hf:usable'));
    expect(at('hf:usable')).toBeLessThan(at('hf:counts'));
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

describe('Added by you', () => {
  const added = (id: string, overrides = {}) =>
    makeView(id, { title: `Added ${id}`, addedAt: new Date('2026-10-14T08:00:00Z'), ...overrides });

  it('is hidden when nothing was added from Lookup', async () => {
    setup({ apply: ready(makeView('a1')) });
    await screen.findByRole('region', { name: 'Summary' });
    await waitFor(() => {
      expect(watchAddedByYou).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole('heading', { name: /Added by you/ })).toBeNull();
  });

  it('lists the newest added jobs with where each one stands', async () => {
    setup(
      { apply: ready(makeView('a1')) },
      {
        added: ready(
          added('v', { verdict: 'near_miss' }),
          added('d', { verdict: undefined, next: 'description', stage: 's2' }),
          added('q', { verdict: undefined, next: 's3', stage: 's2' }),
          added('s', { verdict: undefined, skip: { stage: 's1', ruleId: 'R1' } as never }),
        ),
      },
    );
    const list = await screen.findByRole('list', { name: 'Added by you' });
    const rows = within(list);
    expect(rows.getByText('Added v')).toBeDefined();
    expect(rows.getByText('Near miss')).toBeDefined();
    expect(rows.getByText('Needs a description')).toBeDefined();
    expect(rows.getByText('Queued for deep read')).toBeDefined();
    expect(rows.getByText('Skipped')).toBeDefined();
    expect(screen.getByRole('link', { name: /see all jobs you added/i }).getAttribute('href')).toBe(
      '/jobs?added=1',
    );
  });

  it('starts reading only after hf:usable, so it never delays it', async () => {
    const order: string[] = [];
    const measure = performance.measure.bind(performance);
    vi.spyOn(performance, 'measure').mockImplementation((...args) => {
      order.push(`measure:${args[0]}`);
      return measure(...args);
    });
    setup({ apply: ready(makeView('a1')) }, { onAddedStart: () => order.push('added') });
    await waitFor(() => {
      expect(watchAddedByYou).toHaveBeenCalledTimes(1);
    });
    expect(order).toEqual(['measure:hf:usable', 'added']);
  });

  it('does not start while the Apply list is still loading', async () => {
    setup({ apply: { status: 'loading' } });
    expect(screen.getByRole('status', { name: 'Loading numbers' })).toBeDefined();
    expect(watchAddedByYou).not.toHaveBeenCalled();
  });

  it('shows its own error without touching the lists', async () => {
    setup(
      { apply: ready(makeView('a1', { title: 'Apply role' })) },
      { added: { status: 'error', message: "Couldn't load the jobs you added." } },
    );
    expect(await screen.findByText("Couldn't load the jobs you added.")).toBeDefined();
    expect(screen.getByText('Apply role')).toBeDefined();
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
