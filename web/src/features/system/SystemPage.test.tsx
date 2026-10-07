import type { Run, SourceHealth, SourceRunCounts } from '@hireframe/shared';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  countJobs,
  countWaitingForDescription,
  scanErrorMessage,
  scanNow,
  watchBrokenBoards,
  watchEmailHealth,
  watchRecentRuns,
  watchSources,
  type BoardView,
  type RunView,
  type SourceView,
} from '@/services/system';

import { scanResultText, systemAlerts } from './labels';
import { SystemPage } from './SystemPage';
import { loadAgreement, watchSpend } from '@/services/dashboard';
import { spendMeter } from '@hireframe/shared';

vi.mock('@/services/system', () => ({
  watchSources: vi.fn(),
  watchRecentRuns: vi.fn(),
  watchBrokenBoards: vi.fn(),
  watchEmailHealth: vi.fn(),
  countJobs: vi.fn(),
  countWaitingForDescription: vi.fn(),
  scanNow: vi.fn(),
  scanErrorMessage: vi.fn(() => 'A scan is already running.'),
}));

vi.mock('@/services/dashboard', () => ({ watchSpend: vi.fn(), loadAgreement: vi.fn() }));

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

function givenEmail(data: SourceHealth | null) {
  vi.mocked(watchEmailHealth).mockImplementation((callback) => {
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
  givenEmail(null);
  vi.mocked(countJobs).mockResolvedValue(57);
  vi.mocked(countWaitingForDescription).mockResolvedValue(4);
  vi.mocked(watchSpend).mockImplementation((_now, callback) => {
    callback({
      status: 'ready',
      data: { meter: spendMeter(800, 1500), untouched: false },
      invalid: 0,
    });
    return () => undefined;
  });
  vi.mocked(loadAgreement).mockResolvedValue({
    ratedAgree: 3,
    ratedDisagree: 1,
    appliedAgree: 1,
    agree: 4,
    disagree: 1,
    total: 5,
    rate: 0.8,
  });
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

  it("shows each run's funnel counts, cost, warnings and why it stopped (M4)", () => {
    givenRuns([
      {
        id: 'run-2',
        run: {
          ...RUN,
          trigger: 'schedule',
          status: 'succeeded',
          perStage: {
            ...RUN.perStage,
            s1: { in: 12, passed: 8, skipped: 4, byRule: { 'title:senior': 4 } },
            s2: {
              in: 8,
              passed: 3,
              skipped: 4,
              expired: 1,
              review: 0,
              queued: 2,
              costPence: 1.2,
              durationMs: 9,
            },
            s3: {
              in: 3,
              apply: 1,
              near_miss: 1,
              wildcard: 0,
              skip: 1,
              expired: 0,
              review: 1,
              queued: 1,
              drift: 0,
              recomputed: 0,
              costPence: 4.5,
              durationMs: 30,
            },
          },
          costPence: 5.7,
          budget: { leasePence: 24, usedPence: 5.7, stoppedBy: 'run_budget' },
          flags: ['spend_80'],
        },
      },
    ]);
    render(<SystemPage />);
    const runs = screen.getByRole('region', { name: 'Recent runs' });
    expect(runs.textContent).toContain('Scheduled');
    expect(runs.textContent).toContain(
      'S1 8 passed, 4 skipped · S2 3 passed, 5 skipped · S3 1 apply, 1 near miss, 0 wildcard, 1 skip · 3 queued · 1 for review · 5.7p',
    );
    expect(runs.textContent).toContain('80% of the monthly AI cap used');
    expect(runs.textContent).toContain('Stopped early: run budget used');
  });

  it('shows a separate stop reason for each AI stage, and none for deep reads paused by the cap', () => {
    givenRuns([
      {
        id: 'run-5',
        run: {
          ...RUN,
          budget: {
            leasePence: 24,
            usedPence: 24,
            stoppedBy: 'run_budget',
            stops: { s2: 'run_budget', s3: 'deadline' },
          },
          flags: [],
        },
      },
      {
        id: 'run-6',
        run: {
          ...RUN,
          budget: {
            leasePence: 24,
            usedPence: 9,
            stoppedBy: 'deep_pause',
            stops: { s3: 'deep_pause' },
          },
          flags: ['deep_pause'],
        },
      },
    ]);
    render(<SystemPage />);
    const runs = screen.getByRole('region', { name: 'Recent runs' });
    expect(runs.textContent).toContain('Triage stopped early: run budget used');
    expect(runs.textContent).toContain('Deep reads stopped early: out of time');
    expect(runs.textContent).not.toContain('Deep reads stopped early: deep reads paused');
    expect(runs.textContent).not.toContain('Stopped early:');
  });

  it('shows what a re-score changed', () => {
    givenRuns([
      {
        id: 'run-3',
        run: {
          ...RUN,
          trigger: 'rescore',
          status: 'succeeded',
          perStage: {
            rescore: {
              jobs: 40,
              s1Changed: 5,
              recomputed: 10,
              queuedS2: 2,
              queuedS3: 1,
              unchanged: 22,
            },
          },
        },
      },
    ]);
    render(<SystemPage />);
    const runs = screen.getByRole('region', { name: 'Recent runs' });
    expect(runs.textContent).toContain(
      'Re-score · 40 jobs · 5 changed by rules · 10 re-scored without AI · 3 sent back to the AI · 22 unchanged',
    );
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
    vi.mocked(countJobs).mockResolvedValueOnce(57).mockResolvedValue(59);
    render(<SystemPage />);
    expect(await screen.findByText('Jobs stored: 57')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Scan now' }));
    const busy = screen.getByRole('button', { name: 'Scanning…' });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    await user.click(busy);
    expect(scanNow).toHaveBeenCalledTimes(1);

    // The scan resolves inside act, so the refetch it triggers is flushed before we assert.
    await act(async () => {
      finish({
        status: 'completed',
        runId: 'run-2',
        runStatus: 'succeeded',
        perSource: {},
        s0: { in: 5, new: 2, merged: 1, duplicate: 2, conflicts: 0 },
      });
      await Promise.resolve();
    });
    expect(
      await screen.findByText(
        'Scan finished: 2 new jobs, 1 merged into known jobs, 2 already known.',
      ),
    ).toBeDefined();
    expect(await screen.findByText('Jobs stored: 59')).toBeDefined();
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

describe('System: Gmail alerts and jobs waiting for a description (M6)', () => {
  const EMAIL_AT = new Date('2026-10-07T09:30:00Z');

  it('says when no alert has been ingested yet', () => {
    render(<SystemPage />);
    expect(screen.getByText(/No alert emails yet/)).toBeDefined();
  });

  it('shows the last ingest, its counts and the counts per sender', () => {
    givenEmail(
      health({
        lastRunAt: EMAIL_AT,
        lastOkAt: EMAIL_AT,
        lastCounts: {
          ...counts,
          requests: 3,
          fetched: 9,
          new: 5,
          merged: 1,
          duplicate: 3,
          invalid: 1,
        },
        bySender: {
          'linkedin.com': {
            messages: 40,
            jobs: 210,
            unparsed: 1,
            unverifiedLinks: 0,
            lastAt: EMAIL_AT,
          },
          'example.com': {
            messages: 6,
            jobs: 17,
            unparsed: 0,
            unverifiedLinks: 2,
            lastAt: EMAIL_AT,
          },
        },
      }),
    );
    render(<SystemPage />);
    const sources = screen.getByRole('region', { name: 'Sources' });
    expect(within(sources).getByRole('heading', { name: 'Gmail alerts' })).toBeDefined();
    expect(within(sources).getByText('Emails').nextSibling?.textContent).toBe('3');
    // The counts come before the table, whose headers repeat some labels.
    expect(within(sources).getAllByText('Jobs')[0]?.nextSibling?.textContent).toBe('9');
    expect(within(sources).getAllByText('Unread')[0]?.nextSibling?.textContent).toBe('1');
    expect(within(sources).getByText(/Last ingest 7 Oct/)).toBeDefined();
    const table = within(sources).getByRole('table', { name: /per sender/ });
    const rows = within(table).getAllByRole('row');
    const cells = (row: HTMLElement | undefined) =>
      row
        ? [
            within(row).getByRole('rowheader').textContent,
            ...within(row)
              .getAllByRole('cell')
              .map((cell) => cell.textContent),
          ]
        : [];
    // Busiest sender first: received, jobs, unread, unverified links.
    expect(cells(rows[1])).toEqual(['linkedin.com', '40', '210', '1', '0']);
    expect(cells(rows[2])).toEqual(['example.com', '6', '17', '0', '2']);
  });

  it('shows a stale or failing bridge with its reason', () => {
    givenEmail(health({ status: 'failing', lastErrorCode: 'unparsed' }));
    render(<SystemPage />);
    const sources = screen.getByRole('region', { name: 'Sources' });
    expect(within(sources).getByText(/some alert emails could not be read/)).toBeDefined();
    expect(within(sources).getAllByText('Failing').length).toBeGreaterThan(0);
  });

  it('shows the jobs waiting for a description next to the job count', async () => {
    render(<SystemPage />);
    expect(await screen.findByText(/Waiting for a description: 4/)).toBeDefined();
  });

  it('adds the waiting count to a run line', () => {
    const run: Run = {
      ...RUN,
      perStage: {
        ...RUN.perStage,
        s3: {
          in: 2,
          apply: 0,
          near_miss: 0,
          wildcard: 0,
          skip: 2,
          expired: 0,
          review: 0,
          queued: 0,
          drift: 0,
          recomputed: 0,
          needsDescription: 3,
          costPence: 1,
          durationMs: 10,
        },
      },
    };
    givenRuns([{ id: 'run-1', run }]);
    render(<SystemPage />);
    expect(screen.getByText(/3 waiting for a description/)).toBeDefined();
  });
});

describe('System spend, agreement and alerts (M5)', () => {
  it('shows the spend meter and the agreement line', async () => {
    render(<SystemPage />);
    const spend = screen.getByRole('region', { name: 'AI spend this month' });
    expect(spend.textContent).toContain('£8.00');
    expect(spend.textContent).toContain('of £15.00');
    expect(within(spend).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('800');
    expect(
      (await within(spend).findByText(/Verdict agreement, last 14 days: 80%/)).textContent,
    ).toContain('3 rated right, 1 rated wrong, 1 applied on Apply');
  });

  it('lists what needs attention: a failing source, a failed run and the 80% flag', () => {
    givenSources([{ id: 'reed', health: health({ status: 'failing', lastErrorCode: 'timeout' }) }]);
    givenRuns([{ id: 'run-1', run: { ...RUN, status: 'failed', flags: ['spend_80'] } }]);
    render(<SystemPage />);
    const alerts = screen.getByRole('region', { name: 'Needs attention' });
    expect(alerts.textContent).toContain('Reed is failing: the site timed out.');
    expect(alerts.textContent).toContain('The latest run failed.');
    expect(alerts.textContent).toContain('80% of the monthly AI cap is used.');
  });

  it('shows no alerts section when everything is fine', () => {
    givenSources([{ id: 'greenhouse', health: health() }]);
    givenRuns([{ id: 'run-1', run: { ...RUN, status: 'succeeded' } }]);
    render(<SystemPage />);
    expect(screen.queryByRole('region', { name: 'Needs attention' })).toBeNull();
  });

  it('systemAlerts flags a stalled run, a paused deep read and an empty history', () => {
    const now = new Date(AT.getTime() + 3_600_000);
    const stalled = systemAlerts({
      sources: [],
      runs: [{ id: 'r', run: { ...RUN, status: 'running', flags: ['deep_pause'] } }],
      now,
    });
    expect(stalled.map((a) => a.text)).toEqual([
      'The latest run was stopped before it finished.',
      'Deep reads are paused near the monthly cap.',
    ]);
    expect(systemAlerts({ sources: [], runs: [], now })).toEqual([]);
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

  it('reports the funnel after a scan', () => {
    const text = scanResultText(
      {
        status: 'completed',
        runId: 'r',
        runStatus: 'succeeded',
        perSource: {},
        s0: { in: 3, new: 3, merged: 0, duplicate: 0, conflicts: 0 },
        funnel: {
          s1: { passed: 2, skipped: 1 },
          s2: { passed: 2, skipped: 0 },
          s3: { apply: 1, near_miss: 1, wildcard: 0, skip: 0 },
          review: 0,
          queued: { s2: 4, s3: 0 },
          costPence: 3.24,
          stoppedBy: 'deadline',
        },
      },
      AT,
    );
    expect(text).toBe(
      'Scan finished: 3 new jobs, 0 merged into known jobs, 0 already known. Funnel: 1 to apply, 1 near misses, 0 wildcards, 3.2p. 4 jobs wait for the next run. Stopped early: out of time; the rest waits for the next run.',
    );
  });
});
