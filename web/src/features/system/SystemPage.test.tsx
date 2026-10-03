import type { Run, SourceHealth, SourceRunCounts } from '@hireframe/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  countJobs,
  scanErrorMessage,
  scanNow,
  watchBrokenBoards,
  watchRecentRuns,
  watchSources,
  type BoardView,
  type RunView,
  type SourceView,
} from '@/services/system';

import { scanResultText } from './labels';
import { SystemPage } from './SystemPage';

vi.mock('@/services/system', () => ({
  watchSources: vi.fn(),
  watchRecentRuns: vi.fn(),
  watchBrokenBoards: vi.fn(),
  countJobs: vi.fn(),
  scanNow: vi.fn(),
  scanErrorMessage: vi.fn(() => 'A scan is already running.'),
}));

const AT = new Date('2026-10-01T08:00:00Z');
const counts: SourceRunCounts = {
  status: 'ok',
  fetched: 40,
  invalid: 0,
  new: 12,
  duplicate: 25,
  merged: 3,
  errors: 0,
  requests: 6,
  durationMs: 4000,
};
function health(overrides: Partial<SourceHealth> = {}): SourceHealth {
  return {
    status: 'ok',
    lastRunAt: AT,
    lastOkAt: AT,
    consecutiveFailures: 0,
    lastCounts: counts,
    updatedAt: AT,
    schemaVersion: 1,
    ...overrides,
  };
}

const SOURCES: SourceView[] = [
  { id: 'greenhouse', health: health() },
  {
    id: 'adzuna',
    health: health({
      status: 'degraded',
      lastErrorCode: 'rate_limited',
      quota: {
        day: '2026-10-01',
        dayCount: 20,
        week: '2026-W40',
        weekCount: 20,
        month: '2026-10',
        monthCount: 20,
      },
    }),
  },
  { id: 'reed', health: health({ status: 'disabled', lastErrorCode: 'no_key' }) },
];

const RUN: Run = {
  trigger: 'manual',
  status: 'partial',
  startedAt: AT,
  finishedAt: AT,
  perSource: {},
  perStage: { s0: { in: 40, new: 12, merged: 3, duplicate: 25, conflicts: 0 } },
  costPence: 0,
  errors: [],
  schemaVersion: 1,
};

function givenSources(data: SourceView[]) {
  vi.mocked(watchSources).mockImplementation((callback) => {
    callback({ status: 'ready', data, invalid: 0 });
    return () => undefined;
  });
}

function givenRuns(data: RunView[]) {
  vi.mocked(watchRecentRuns).mockImplementation((callback) => {
    callback({ status: 'ready', data, invalid: 0 });
    return () => undefined;
  });
}

function givenBrokenBoards(data: BoardView[]) {
  vi.mocked(watchBrokenBoards).mockImplementation((callback) => {
    callback({ status: 'ready', data, invalid: 0 });
    return () => undefined;
  });
}

function card(cards: HTMLElement[], index: number): HTMLElement {
  const found = cards[index];
  if (!found) throw new Error(`no card ${String(index)}`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  givenSources(SOURCES);
  givenRuns([{ id: 'run-1', run: RUN }]);
  givenBrokenBoards([]);
  vi.mocked(countJobs).mockResolvedValue(57);
});

describe('System screen', () => {
  it('shows each source with its status, counts and the reason it is not OK', () => {
    render(<SystemPage />);
    const sources = screen.getByRole('region', { name: 'Sources' });
    const cards = within(sources).getAllByRole('listitem');
    expect(cards).toHaveLength(3);
    expect(cards[0]?.textContent).toContain('Greenhouse');
    expect(cards[0]?.textContent).toContain('OK');
    expect(within(card(cards, 0)).getByText('Merged').nextSibling?.textContent).toBe('3');
    expect(cards[1]?.textContent).toContain('Degraded');
    expect(cards[1]?.textContent).toContain('Why: the site asked us to slow down');
    expect(cards[1]?.textContent).toContain('20 API calls today');
    expect(within(card(cards, 1)).getByRole('link', { name: 'Jobs by Adzuna' })).toBeDefined();
    expect(cards[2]?.textContent).toContain('Why: API key missing');
  });

  it('shows a paused host as "Paused until <time>" on its card', () => {
    const until = new Date(Date.now() + 23 * 3600_000);
    givenSources([
      {
        id: 'workable',
        health: health({
          status: 'skipped',
          lastErrorCode: 'host_paused',
          pausedHosts: [{ host: 'apply.workable.com', until }],
        }),
      },
      {
        id: 'lever',
        health: health({ pausedHosts: [{ host: 'api.lever.co', until: new Date(0) }] }),
      },
    ]);
    render(<SystemPage />);
    const cards = within(screen.getByRole('region', { name: 'Sources' })).getAllByRole('listitem');
    const label = new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(until);
    expect(card(cards, 0).textContent).toContain(`Paused until ${label}`);
    expect(card(cards, 0).textContent).toContain('Why: the site asked us to pause');
    // A pause that has ended isn't shown.
    expect(card(cards, 1).textContent).not.toContain('Paused until');
  });

  it('shows the job count and recent runs', async () => {
    render(<SystemPage />);
    expect(await screen.findByText('Jobs stored: 57')).toBeDefined();
    const runs = screen.getByRole('region', { name: 'Recent runs' });
    expect(runs.textContent).toContain('12 new · 3 merged · 25 known');
    expect(runs.textContent).toContain('Partial');
  });

  it('lists broken boards', () => {
    givenBrokenBoards([
      {
        id: 'echo-gone',
        company: {
          name: 'Echo Gone',
          domain: 'echo-gone.example.com',
          ats: { type: 'greenhouse', token: 'echogone' },
          hq: 'London',
          watch: true,
          origin: 'seed',
          createdAt: AT,
          updatedAt: AT,
          schemaVersion: 1,
        },
      },
    ]);
    render(<SystemPage />);
    const broken = screen.getByRole('region', { name: 'Broken job boards' });
    expect(broken.textContent).toContain('Echo Gone');
    expect(broken.textContent).toContain('greenhouse:echogone');
  });

  it('runs a scan once per click, disables the button meanwhile, and reports the result', async () => {
    const user = userEvent.setup();
    let finish: (value: Awaited<ReturnType<typeof scanNow>>) => void = () => undefined;
    vi.mocked(scanNow).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<SystemPage />);
    await user.click(screen.getByRole('button', { name: 'Scan now' }));
    const busy = screen.getByRole('button', { name: 'Scanning…' });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    await user.click(busy);
    expect(scanNow).toHaveBeenCalledTimes(1);

    finish({
      status: 'completed',
      runId: 'run-2',
      runStatus: 'succeeded',
      perSource: {},
      s0: { in: 5, new: 2, merged: 1, duplicate: 2, conflicts: 0 },
    });
    expect(
      await screen.findByText(
        'Scan finished: 2 new jobs, 1 merged into known jobs, 2 already known.',
      ),
    ).toBeDefined();
    expect(countJobs).toHaveBeenCalledTimes(2);
  });

  it('shows why a scan could not run', async () => {
    const user = userEvent.setup();
    vi.mocked(scanNow).mockRejectedValue(new Error('busy'));
    render(<SystemPage />);
    await user.click(screen.getByRole('button', { name: 'Scan now' }));
    expect(await screen.findByText('A scan is already running.')).toBeDefined();
    expect(scanErrorMessage).toHaveBeenCalled();
  });

  it('says when there are no scans yet', () => {
    givenSources([]);
    render(<SystemPage />);
    expect(screen.getByText('No scans yet. Run Scan now.')).toBeDefined();
  });
});

describe('System screen states', () => {
  it('shows a loading state for recent runs', () => {
    vi.mocked(watchRecentRuns).mockImplementation((callback) => {
      callback({ status: 'loading' });
      return () => undefined;
    });
    render(<SystemPage />);
    expect(screen.getByRole('status', { name: 'Loading runs' })).toBeDefined();
  });

  it('shows errors for recent runs and broken boards', () => {
    vi.mocked(watchRecentRuns).mockImplementation((callback) => {
      callback({ status: 'error', message: "Couldn't load recent runs. Reload to try again." });
      return () => undefined;
    });
    vi.mocked(watchBrokenBoards).mockImplementation((callback) => {
      callback({ status: 'error', message: "Couldn't load board status." });
      return () => undefined;
    });
    render(<SystemPage />);
    const alerts = screen.getAllByRole('alert').map((alert) => alert.textContent);
    expect(alerts).toEqual(
      expect.arrayContaining([
        "Couldn't load recent runs. Reload to try again.",
        "Couldn't load board status.",
      ]),
    );
  });

  it('shows a run stuck at running past the callable timeout as timed out', () => {
    const stuck: Run = {
      ...RUN,
      status: 'running',
      startedAt: new Date(Date.now() - 11 * 60_000),
      perStage: {},
    };
    const live: Run = { ...RUN, status: 'running', startedAt: new Date(), perStage: {} };
    givenRuns([
      { id: 'stuck', run: stuck },
      { id: 'live', run: live },
    ]);
    render(<SystemPage />);
    const runs = screen.getByRole('region', { name: 'Recent runs' });
    const items = within(runs).getAllByRole('listitem');
    expect(items[0]?.textContent).toContain('Timed out');
    expect(items[0]?.textContent).toContain('Stopped before it finished');
    expect(items[1]?.textContent).toContain('Running');
    expect(items[1]?.textContent).toContain('In progress');
  });
});

describe('scanResultText', () => {
  it('explains a skipped scan', () => {
    expect(
      scanResultText(
        {
          status: 'skipped_recent',
          lastFinishedAt: '2026-10-01T07:58:00.000Z',
          retryAfterSeconds: 180,
        },
        AT,
      ),
    ).toBe(
      'The last scan finished 2 minutes ago, so this one was skipped. Try again in 180 seconds.',
    );
  });

  it('flags partial and failed runs', () => {
    const base = {
      status: 'completed',
      runId: 'r',
      perSource: {},
      s0: { in: 1, new: 1, merged: 0, duplicate: 0, conflicts: 0 },
    } as const;
    expect(scanResultText({ ...base, runStatus: 'partial' }, AT)).toContain(
      'Some sources had problems',
    );
    expect(scanResultText({ ...base, runStatus: 'failed' }, AT)).toContain('Every source failed');
  });
});
