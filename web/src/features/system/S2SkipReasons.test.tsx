import {
  buildReport,
  CRITERIA_SEED_V1,
  unexpectedReportEntries,
  type DiagnosticsReport,
  type Job,
} from '@hireframe/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  IndexBuildingError,
  loadDiagnostics,
  loadRecentS1Skips,
} from '@/services/funnel-diagnostics';

import { S1RecentSkips } from './S1RecentSkips';
import { S2SkipReasons } from './S2SkipReasons';

vi.mock('@/services/funnel-diagnostics', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@/services/funnel-diagnostics')),
  loadDiagnostics: vi.fn(),
  loadRecentS1Skips: vi.fn(),
}));

const NOW = new Date('2026-10-05T08:00:00Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const SECRETS = ['Zephyr Quartz Analyst', 'Quillfeather Holdings', 'marmalade', 'Klingon'];

function fakeJob(patch: Partial<Job> = {}): Job {
  return {
    dedupeKey: 'd:1',
    keys: ['d:1'],
    title: SECRETS[0] ?? '',
    company: SECRETS[1] ?? '',
    location: 'London',
    city: 'london',
    country: 'GB',
    remote: 'hybrid',
    url: 'https://jobs.example.com/1',
    sources: [
      {
        id: 'greenhouse',
        url: 'https://jobs.example.com/1',
        externalId: '1',
        seenAt: daysAgo(1),
      },
    ],
    firstSeenAt: daysAgo(1),
    descriptionRef: 'jobs/1/description/raw',
    descriptionKind: 'full',
    stage: 's2',
    status: 'new',
    verdict: 'skip',
    skip: { stage: 's2', note: SECRETS[2] ?? '' },
    triage: {
      lane: 'none',
      seniority: 'senior',
      blockers: [`Needs fluent ${SECRETS[3] ?? ''}`],
      pass: false,
      triageScore: 1,
      note: SECRETS[2] ?? '',
    },
    judgedAt: daysAgo(3),
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
    schemaVersion: 1,
    ...patch,
  };
}

function report(): DiagnosticsReport {
  return buildReport({
    sets: {
      s2Skipped: [{ job: fakeJob(), text: 'description text' }],
      good: [{ job: fakeJob({ verdict: 'apply', title: 'Software Engineer' }), text: '' }],
      queuedS3: [],
    },
    criteria: CRITERIA_SEED_V1,
    workRights: null,
    now: NOW,
    queuedWithoutSortAt: { s2: 0, s3: 2 },
  });
}

const load = vi.mocked(loadDiagnostics);

beforeEach(() => {
  load.mockReset();
});

describe('S2SkipReasons', () => {
  it('reads nothing until Load is pressed', () => {
    render(<S2SkipReasons />);
    expect(load).not.toHaveBeenCalled();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Load' }).disabled).toBe(false);
  });

  it('shows set sizes with date ranges, count tables and rule hits', async () => {
    load.mockResolvedValue(report());
    render(<S2SkipReasons />);
    await userEvent.click(screen.getByRole('button', { name: 'Load' }));

    const sets = await screen.findByRole('table', { name: /size of each set/ });
    expect(
      within(sets).getByRole('row', { name: /S2 skips \(model\) 1 2026-10-02 to 2026-10-02/ }),
    ).toBeDefined();
    expect(within(sets).getByText('Waiting for S3')).toBeDefined();
    expect(within(sets).getByText('none')).toBeDefined();

    const blockers = screen.getByRole('table', { name: /By blocker category/ });
    expect(within(blockers).getByRole('row', { name: /language 1/ })).toBeDefined();
    const rules = screen.getByRole('table', { name: /candidate rule would have skipped/ });
    // C3 would have skipped the good "Software Engineer": shown next to the set size.
    expect(within(rules).getByRole('row', { name: /C3 0 1 0/ })).toBeDefined();
    expect(within(rules).getByText('Good jobs of 1')).toBeDefined();
    expect(screen.getByText(/Queued without a sort date/).textContent).toContain('S3 2');
  });

  it('shows no job text on screen and copies counts only', async () => {
    load.mockResolvedValue(report());
    const user = userEvent.setup();
    const { container } = render(<S2SkipReasons />);
    await user.click(screen.getByRole('button', { name: 'Load' }));
    await user.click(await screen.findByRole('button', { name: 'Copy counts' }));

    const copied = await navigator.clipboard.readText();
    expect(JSON.parse(copied)).toMatchObject({
      s2Skips: { total: 1 },
      sets: { good: { size: 1 } },
    });
    expect(unexpectedReportEntries(JSON.parse(copied))).toEqual([]);
    for (const secret of [...SECRETS, 'description text', 'Software Engineer']) {
      expect(copied).not.toContain(secret);
      expect(container.textContent).not.toContain(secret);
    }
    expect(await screen.findByText('Copied.')).toBeDefined();
  });

  it('never copies the titles and companies the S1 spot-check list shows', async () => {
    load.mockResolvedValue(report());
    vi.mocked(loadRecentS1Skips).mockResolvedValue({
      sdr: [{ id: 'job-1', title: 'Gossamer Pipeline Rep', company: 'Tumbleweed Fake Ltd' }],
    });
    const user = userEvent.setup();
    const { container } = render(
      <MemoryRouter>
        <S1RecentSkips />
        <S2SkipReasons />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Load recent skips' }));
    await screen.findByText(/Gossamer Pipeline Rep/);
    await user.click(screen.getByRole('button', { name: 'Load' }));
    await user.click(await screen.findByRole('button', { name: 'Copy counts' }));

    const copied = await navigator.clipboard.readText();
    expect(container.textContent).toContain('Tumbleweed Fake Ltd');
    for (const secret of ['Gossamer Pipeline Rep', 'Tumbleweed Fake Ltd', 'job-1']) {
      expect(copied).not.toContain(secret);
    }
  });

  it('says the index is building when Firestore is still creating it', async () => {
    load.mockRejectedValue(new IndexBuildingError('jobs'));
    render(<S2SkipReasons />);
    await userEvent.click(screen.getByRole('button', { name: 'Load' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Index building/);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Load' }).disabled).toBe(false);
  });

  it('shows a plain error for any other failure', async () => {
    load.mockRejectedValue(new Error('boom'));
    render(<S2SkipReasons />);
    await userEvent.click(screen.getByRole('button', { name: 'Load' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      "Couldn't read the funnel numbers",
    );
  });
});
