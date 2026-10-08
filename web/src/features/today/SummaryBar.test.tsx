import { spendMeter, type Run } from '@hireframe/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loadSummaryCounts, watchLastRun, watchSpend } from '@/services/dashboard';
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

function setup(options: { run?: LiveState<Run | null>; cents?: number; target?: number } = {}) {
  vi.mocked(loadSummaryCounts).mockResolvedValue({
    apply: 3,
    nearMiss: 5,
    wildcard: 0,
    appliedThisWeek: 2,
  });
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
});
