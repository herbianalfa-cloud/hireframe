import { CRITERIA_SEED_V1, type CriteriaVersion } from '@hireframe/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  criteriaErrorMessage,
  CriteriaConflictError,
  saveCriteria,
  seedCriteria,
  watchCriteriaHistory,
  watchCurrentCriteria,
  type CriteriaState,
} from '@/services/criteria';

import { CriteriaPage } from './CriteriaPage';

vi.mock('@/services/criteria', () => {
  class CriteriaConflictError extends Error {}
  return {
    CriteriaConflictError,
    watchCurrentCriteria: vi.fn(),
    watchCriteriaHistory: vi.fn(),
    seedCriteria: vi.fn(),
    saveCriteria: vi.fn(),
    criteriaErrorMessage: vi.fn(() => "Couldn't save. Check your connection and try again."),
  };
});

const criteria: CriteriaVersion = {
  ...CRITERIA_SEED_V1,
  version: 3,
  createdAt: new Date('2026-10-01T09:00:00Z'),
  schemaVersion: 1,
};

function givenState(state: CriteriaState) {
  vi.mocked(watchCurrentCriteria).mockImplementation((callback) => {
    callback(state);
    return () => undefined;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(watchCriteriaHistory).mockImplementation((callback) => {
    callback({
      status: 'ready',
      versions: [
        { version: 3, createdAt: new Date('2026-10-01T09:00:00Z') },
        { version: 2, createdAt: new Date('2026-09-20T09:00:00Z') },
      ],
    });
    return () => undefined;
  });
});

describe('Criteria states', () => {
  it('shows a skeleton while loading', () => {
    givenState({ status: 'loading' });
    render(<CriteriaPage />);
    expect(screen.getByRole('status', { name: 'Loading criteria' })).toBeDefined();
  });

  it('shows the error', () => {
    givenState({ status: 'error', message: "Couldn't load your criteria. Reload to try again." });
    render(<CriteriaPage />);
    expect(screen.getByRole('alert').textContent).toContain("Couldn't load your criteria");
  });

  it('seeds default criteria from the empty state', async () => {
    const user = userEvent.setup();
    givenState({ status: 'empty' });
    vi.mocked(seedCriteria).mockResolvedValue();
    render(<CriteriaPage />);

    await user.click(screen.getByRole('button', { name: 'Start from default criteria' }));
    expect(seedCriteria).toHaveBeenCalledOnce();
  });

  it('shows the version, history and the current marker', () => {
    givenState({ status: 'ready', criteria });
    render(<CriteriaPage />);

    expect(screen.getByText('Version 3')).toBeDefined();
    const history = screen.getByRole('region', { name: 'History' });
    const items = within(history).getAllByRole('listitem');
    expect(items[0]?.textContent).toContain('v3 · 1 Oct 2026');
    expect(items[0]?.textContent).toContain('Current');
    expect(items[1]?.textContent).not.toContain('Current');
  });
});

describe('Criteria form', () => {
  it('disables Save until something changes', async () => {
    const user = userEvent.setup();
    givenState({ status: 'ready', criteria });
    render(<CriteriaPage />);

    const save = screen.getByRole('button', { name: 'Save' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await user.type(
      screen.getByRole('textbox', { name: 'Wildcard interests' }),
      'sales engineer{Enter}',
    );
    expect((save as HTMLButtonElement).disabled).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText('sales engineer')).toBeNull();
  });

  it('saves the edited list based on the current version', async () => {
    const user = userEvent.setup();
    givenState({ status: 'ready', criteria });
    vi.mocked(saveCriteria).mockResolvedValue(4);
    render(<CriteriaPage />);

    await user.type(
      screen.getByRole('textbox', { name: 'Wildcard interests' }),
      'sales engineer{Enter}',
    );
    await user.click(screen.getByRole('button', { name: 'Remove prompt engineer' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const { wildcards, ...rest } = CRITERIA_SEED_V1;
    expect(saveCriteria).toHaveBeenCalledWith(
      {
        ...rest,
        wildcards: [...wildcards.filter((item) => item !== 'prompt engineer'), 'sales engineer'],
      },
      3,
    );
    expect(await screen.findByText('Saved as version 4')).toBeDefined();
    expect(screen.getByText('Version 4')).toBeDefined();
  });

  it('rejects duplicate list items', async () => {
    const user = userEvent.setup();
    givenState({ status: 'ready', criteria });
    render(<CriteriaPage />);

    await user.type(
      screen.getByRole('textbox', { name: 'Wildcard interests' }),
      'Prompt Engineer{Enter}',
    );
    expect(screen.getByText(/already in the list/)).toBeDefined();
  });

  it('adds an excluded title with a slug id and omits empty prefixes', async () => {
    const user = userEvent.setup();
    givenState({ status: 'ready', criteria });
    vi.mocked(saveCriteria).mockResolvedValue(4);
    render(<CriteriaPage />);

    await user.type(screen.getByLabelText('Exclude a title'), 'Sales Lead{Enter}');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const saved = vi.mocked(saveCriteria).mock.calls[0]?.[0];
    const added = saved?.excluded_titles.at(-1);
    expect(added).toEqual({ id: 'sales-lead', term: 'Sales Lead' });
    expect(added && 'unless_prefixed_by' in added).toBe(false);
  });

  it('blocks save and shows a field error for invalid input', async () => {
    const user = userEvent.setup();
    givenState({ status: 'ready', criteria });
    render(<CriteriaPage />);

    const freshness = screen.getByLabelText('Freshness window (days)');
    await user.clear(freshness);
    await user.type(freshness, '0');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByText('Enter a whole number of days from 1 to 90.')).toBeDefined();
    expect(freshness.getAttribute('aria-invalid')).toBe('true');
    expect(saveCriteria).not.toHaveBeenCalled();
  });

  it('shows default lane points for a version saved before they existed, and saves them', async () => {
    const user = userEvent.setup();
    const old: Record<string, unknown> = { ...criteria };
    delete old.lane_points;
    givenState({ status: 'ready', criteria: old as CriteriaVersion });
    vi.mocked(saveCriteria).mockResolvedValue(4);
    render(<CriteriaPage />);

    const wildcard = screen.getByLabelText('Wildcard');
    expect((wildcard as HTMLInputElement).value).toBe('2');
    await user.clear(wildcard);
    await user.type(wildcard, '1.5');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(vi.mocked(saveCriteria).mock.calls[0]?.[0].lane_points).toEqual({
      primary: 3,
      secondary: 2,
      opportunistic: 1,
      wildcard: 1.5,
    });
  });

  it('rejects lane points above 3', async () => {
    const user = userEvent.setup();
    givenState({ status: 'ready', criteria });
    render(<CriteriaPage />);

    const primary = screen.getByLabelText('Primary lane');
    await user.clear(primary);
    await user.type(primary, '4');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByText('Enter points from 0 to 3.')).toBeDefined();
    expect(saveCriteria).not.toHaveBeenCalled();
  });

  it('shows the conflict message when the criteria changed elsewhere', async () => {
    const user = userEvent.setup();
    givenState({ status: 'ready', criteria });
    vi.mocked(saveCriteria).mockRejectedValue(new CriteriaConflictError('moved'));
    vi.mocked(criteriaErrorMessage).mockReturnValue(
      'Your criteria changed in another tab. Reload to see the latest version.',
    );
    render(<CriteriaPage />);

    await user.type(
      screen.getByRole('textbox', { name: 'Wildcard interests' }),
      'sales engineer{Enter}',
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/changed in another tab/)).toBeDefined();
  });
});
