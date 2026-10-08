import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IndexBuildingError, loadRecentS1Skips } from '@/services/funnel-diagnostics';

import { S1RecentSkips } from './S1RecentSkips';

vi.mock('@/services/funnel-diagnostics', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@/services/funnel-diagnostics')),
  loadRecentS1Skips: vi.fn(),
}));

const load = vi.mocked(loadRecentS1Skips);

function renderPanel() {
  return render(
    <MemoryRouter>
      <S1RecentSkips />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  load.mockReset();
});

describe('S1RecentSkips', () => {
  it('reads nothing until Load is pressed', () => {
    renderPanel();
    expect(load).not.toHaveBeenCalled();
  });

  it("lists each rule's skipped jobs, linking to the job sheet", async () => {
    load.mockResolvedValue({
      sdr: [{ id: 'job-1', title: 'Sales Development Rep', company: 'Acme Fake Ltd' }],
    });
    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Load recent skips' }));
    const link = await screen.findByRole('link', { name: /Sales Development Rep/ });
    expect(link.getAttribute('href')).toBe('/jobs?job=job-1');
    expect(link.textContent).toContain('Acme Fake Ltd');
    const region = screen.getByRole('region', { name: 'Recent S1 skips by rule' });
    expect(within(region).getByText('sdr (1)')).toBeDefined();
    expect(within(region).getByText('sales-executive (0)')).toBeDefined();
  });

  it('says the index is building when Firestore is still creating it', async () => {
    load.mockRejectedValue(new IndexBuildingError('jobs'));
    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Load recent skips' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Index building/);
  });
});
