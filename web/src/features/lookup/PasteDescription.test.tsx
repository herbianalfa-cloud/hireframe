import { LOOKUP_LIMITS } from '@hireframe/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { lookupDescribe } from '@/services/lookup';

import { PasteDescription } from './PasteDescription';

vi.mock('@/services/lookup', () => ({
  lookupDescribe: vi.fn(),
  lookupErrorMessage: () => 'Lookup failed',
}));

beforeEach(() => {
  vi.mocked(lookupDescribe).mockReset();
});

const field = () => screen.getByRole('textbox', { name: 'Job description' });
const judge = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Judge' });

describe('PasteDescription', () => {
  it('needs text before Judge is on', async () => {
    render(<PasteDescription jobId="j1" />);
    expect(judge().disabled).toBe(true);
    await userEvent.type(field(), '   ');
    expect(judge().disabled).toBe(true);
    await userEvent.type(field(), 'x');
    expect(judge().disabled).toBe(false);
  });

  it('refuses text over the limit, in words', async () => {
    render(<PasteDescription jobId="j1" />);
    await userEvent.click(field());
    await userEvent.paste('a'.repeat(LOOKUP_LIMITS.description + 5));
    expect(judge().disabled).toBe(true);
    expect(screen.getByText('Too long by 5 characters.')).toBeDefined();
  });

  it.each([
    [{ status: 'judged', verdict: 'wildcard' }, 'Judged: Wildcard'],
    [
      { status: 'skipped', stage: 's1', ruleId: 'R3', note: 'needs clearance' },
      'Skipped. Rules (rule R3): needs clearance',
    ],
    [
      { status: 'queued', reason: 'daily_cap' },
      "Saved. The next scan will judge it, because today's Lookup limit was reached.",
    ],
    [{ status: 'review' }, 'Saved, but the model could not judge it. It is up for review.'],
    [{ status: 'refused' }, "This job isn't waiting for a description any more."],
  ] as const)('says what happened for %j', async (result, words) => {
    vi.mocked(lookupDescribe).mockResolvedValue(result);
    const onResult = vi.fn();
    render(<PasteDescription jobId="j1" onResult={onResult} />);
    await userEvent.click(field());
    await userEvent.paste('Posting');
    await userEvent.click(judge());
    expect((await screen.findByRole('status')).textContent).toBe(words);
    expect(onResult).toHaveBeenCalledWith(result);
  });

  it('sends once per press and does not retry a failure', async () => {
    vi.mocked(lookupDescribe).mockRejectedValue(new Error('x'));
    render(<PasteDescription jobId="j1" />);
    await userEvent.click(field());
    await userEvent.paste('Posting');
    await userEvent.click(judge());
    expect((await screen.findByRole('alert')).textContent).toBe('Lookup failed');
    expect(lookupDescribe).toHaveBeenCalledTimes(1);
  });
});
