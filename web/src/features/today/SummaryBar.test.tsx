import { spendMeter, type Run } from '@hireframe/shared';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  loadSummaryCounts,
  watchLastRun,
  watchSpend,
  type SummaryCountResults,
} from '@/services/dashboard';
import type { LiveState } from '@/services/profile';

import { SummaryBar } from './SummaryBar';

vi.mock('@/services/dashboard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadSummaryCounts: vi.fn(),
  watchLastRun: vi.fn(),
  watchSpend: vi.fn(),
}));

const run = (overrides: Partial<Run>): Run =>
  ({ trigger: 'schedule', status: 'succeeded', startedAt: new Date(), ...overrides }) as Run;

const COUNTS: SummaryCountResults = { apply: 3, nearMiss: 5, wildcard: 0, appliedThisWeek: 2 };

function setup(
  options: {
    run?: LiveState<Run | null>;
    cents?: number;
    target?: number;
    counts?: Promise<SummaryCountResults> | SummaryCountResults;
  } = {},
) {
  vi.mocked(loadSummaryCounts).mockImplementation(async () => options.counts ?? COUNTS);
  vi.mocked(watchLastRun).mockImplementation((callback) => {
    callback(options.run ?? { status: 'ready', data: run({}), invalid: 0 });
    return () => undefined;
  });
  vi.mocked(watchSpend).mockImplementation((_now, callback) => {
    callback({
      status: 'ready',
      data: { meter: spendMeter(options.cents ?? 500, 1500), untouched: false },
      invalid: 0,
    });
    return () => undefined;
  });
  render(
    <MemoryRouter>
      <SummaryBar weeklyTarget={options.target ?? 5} refreshKey={0} />
    </MemoryRouter>,
  );
  return screen.findByRole('region', { name: 'Summary' }).then((region) => within(region));
}

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.mocked(loadSummaryCounts).mockReset();
  vi.mocked(watchLastRun).mockReset();
  vi.mocked(watchSpend).mockReset();
});

describe('SummaryBar', () => {
  it('links each open count to its Jobs view, with a name that does not rely on colour', async () => {
    const bar = await setup();
    expect(bar.getByRole('link', { name: 'Open Apply 3' }).getAttribute('href')).toBe(
      '/jobs?verdict=apply&status=new',
    );
    expect(bar.getByRole('link', { name: 'Open near miss 5' }).getAttribute('href')).toBe(
      '/jobs?verdict=near_miss&status=new',
    );
    expect(bar.getByRole('link', { name: 'Open wildcard 0' }).getAttribute('href')).toBe(
      '/jobs?verdict=wildcard&status=new',
    );
  });

  it('puts an icon next to each verdict count', async () => {
    const bar = await setup();
    for (const name of ['Open Apply 3', 'Open near miss 5', 'Open wildcard 0']) {
      expect(
        bar.getByRole('link', { name }).querySelector('svg[aria-hidden="true"]'),
      ).not.toBeNull();
    }
  });

  it('shows applied this week against the target', async () => {
    const bar = await setup({ target: 5 });
    expect(bar.getByText('Applied this week').closest('li')?.textContent).toContain('2 / 5');
    expect(bar.getByText('3 to go')).toBeDefined();
  });

  it('has no Things to do item yet', async () => {
    const bar = await setup();
    expect(bar.queryByText(/things to do/i)).toBeNull();
  });

  it('shows the last run with its status in words, and the next run', async () => {
    const bar = await setup({
      run: { status: 'ready', data: run({ status: 'partial' }), invalid: 0 },
    });
    expect(bar.getByText('Last run').closest('li')?.textContent).toContain('Partial');
    expect(bar.getByText('Next run').closest('li')?.textContent).toMatch(/07:30|17:30/);
  });

  it('says timed out for a run that was killed before it finished', async () => {
    const bar = await setup({
      run: {
        status: 'ready',
        data: run({ status: 'running', startedAt: new Date('2020-01-01T07:30:00Z') }),
        invalid: 0,
      },
    });
    expect(bar.getByText('Timed out')).toBeDefined();
  });

  it('says so when there has been no run, or the run could not be read', async () => {
    const none = await setup({ run: { status: 'ready', data: null, invalid: 0 } });
    expect(none.getByText('No runs yet')).toBeDefined();
    cleanup();
    const failed = await setup({
      run: { status: 'error', message: "Couldn't load the last run." },
    });
    expect(failed.getByText('Unavailable')).toBeDefined();
  });

  it('links the spend chip to System and warns from 80%', async () => {
    const bar = await setup({ cents: 1230 });
    const chip = await bar.findByRole('link', { name: /£12\.30 of £15\.00/ });
    expect(chip.getAttribute('href')).toBe('/system');
    expect(chip.textContent).toContain('82% used');
  });

  it('renders the row at once: counts pending, last run and spend already shown', async () => {
    let release: (counts: SummaryCountResults) => void = () => undefined;
    const pending = new Promise<SummaryCountResults>((resolve) => {
      release = resolve;
    });
    const bar = await setup({ counts: pending });
    expect(bar.getByRole('link', { name: 'Open Apply, loading' })).toBeDefined();
    expect(bar.getByRole('link', { name: 'Open near miss, loading' })).toBeDefined();
    expect(bar.getByRole('link', { name: 'Open wildcard, loading' })).toBeDefined();
    expect(bar.getByRole('status', { name: 'Loading applied this week' })).toBeDefined();
    expect(bar.getByText('Last run').closest('li')?.textContent).toContain('Succeeded');
    expect(await bar.findByRole('link', { name: /£5\.00 of £15\.00/ })).toBeDefined();
    await act(async () => {
      release(COUNTS);
      await pending;
    });
    expect(await bar.findByRole('link', { name: 'Open Apply 3' })).toBeDefined();
    expect(bar.queryByRole('link', { name: /loading/ })).toBeNull();
  });

  it('shows a failed count as a dash with "unavailable" in the link name', async () => {
    const bar = await setup({ counts: { ...COUNTS, nearMiss: null } });
    const link = await bar.findByRole('link', { name: 'Open near miss unavailable' });
    expect(link.textContent).toContain('–');
    expect(link.textContent).toContain('unavailable');
    expect(bar.getByRole('link', { name: 'Open Apply 3' })).toBeDefined();
    expect(bar.queryByRole('alert')).toBeNull();
  });

  it('shows applied this week as a dash when it could not be counted', async () => {
    const bar = await setup({ counts: { ...COUNTS, appliedThisWeek: null } });
    await bar.findByRole('link', { name: 'Open Apply 3' });
    const item = bar.getByText('Applied this week').closest('li');
    expect(item?.textContent).toContain('–');
    expect(item?.textContent).toContain('unavailable');
    expect(item?.textContent).not.toContain('to go');
  });

  it('keeps list semantics: every item is a direct child li of the list', async () => {
    const bar = await setup();
    await bar.findByRole('link', { name: 'Open Apply 3' });
    const list = bar.getByRole('list');
    expect(bar.getAllByRole('listitem')).toHaveLength(7);
    for (const item of bar.getAllByRole('listitem')) expect(item.parentElement).toBe(list);
  });

  describe('clock', () => {
    // Sunday 11 Oct 2026, 08:00 BST (07:00Z): next is Monday 07:30 BST.
    it('moves Next run forward as time passes', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
      vi.setSystemTime(new Date('2026-10-12T06:29:30Z'));
      const bar = await setup();
      const next = () => bar.getByText('Next run').closest('li')?.textContent;
      expect(next()).toContain('07:30');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(next()).toContain('17:30');
    });

    it('turns a running run into Timed out once it is stalled', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
      const start = new Date('2026-10-12T06:30:00Z');
      vi.setSystemTime(new Date(start.getTime() + 60_000));
      const bar = await setup({
        run: { status: 'ready', data: run({ status: 'running', startedAt: start }), invalid: 0 },
      });
      expect(bar.queryByText('Timed out')).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2 * 3_600_000);
      });
      expect(bar.getByText('Timed out')).toBeDefined();
    });

    it('clears its timer on unmount', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
      await setup();
      expect(vi.getTimerCount()).toBe(1);
      cleanup();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
