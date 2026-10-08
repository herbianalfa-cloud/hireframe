import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RESULTS_CARDS,
  resultsPageLinks,
  resultsPageText,
  UNREADABLE_PASTE,
} from '../../../../packages/shared/src/fixtures/results-page';
import { makeUnjudgedView, makeView } from '@/features/jobs/fixtures';
import { watchJob, type JobView } from '@/services/jobs';
import {
  lookupAdd,
  lookupDescribe,
  lookupParse,
  matchRows,
  matchTargets,
  watchWaitingJobs,
} from '@/services/lookup';

import { LookupPage } from './LookupPage';

vi.mock('@/services/lookup', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  matchTargets: vi.fn(),
  matchRows: vi.fn(),
  lookupAdd: vi.fn(),
  lookupDescribe: vi.fn(),
  lookupParse: vi.fn(),
  watchWaitingJobs: vi.fn(),
}));
vi.mock('@/services/jobs', () => ({
  watchJob: vi.fn(),
  loadJobDescription: vi.fn(() => Promise.resolve(null)),
  setJobStatus: vi.fn(),
  rateJob: vi.fn(),
  unrateJob: vi.fn(),
  jobActionErrorMessage: () => 'failed',
}));
vi.mock('@/features/profile/hooks', () => ({
  useFacts: () => ({ status: 'ready', data: [], invalid: 0 }),
}));

const LINKEDIN = 'https://www.linkedin.com/jobs/view/4012345678/?trackingId=abc';
const GREENHOUSE = 'https://boards.greenhouse.io/acme/jobs/1234567';

function waiting(...views: JobView[]) {
  vi.mocked(watchWaitingJobs).mockImplementation((_size, callback) => {
    callback({ status: 'ready', data: views, invalid: 0 });
    return () => undefined;
  });
}

function setup() {
  let location = '';
  function Probe() {
    const l = useLocation();
    location = l.pathname + l.search;
    return null;
  }
  render(
    <MemoryRouter initialEntries={['/lookup']}>
      <LookupPage />
      <Probe />
    </MemoryRouter>,
  );
  return { location: () => location };
}

const box = () => screen.getByRole('textbox', { name: /Links or a results page/ });
const check = () => screen.getByRole('button', { name: 'Check' });

async function paste(text: string, html?: string) {
  await userEvent.click(box());
  if (html === undefined) {
    await userEvent.paste(text);
  } else {
    fireEvent.paste(box(), {
      clipboardData: { getData: (type: string) => (type === 'text/html' ? html : text) },
    });
    fireEvent.change(box(), { target: { value: text } });
  }
}

/** The page's anchors as HTML, the way a copy of the results page carries them. */
function resultsHtml() {
  return resultsPageLinks()
    .map((link) => `<a href="${link.href}">${link.text}</a>`)
    .join('\n');
}

beforeEach(() => {
  for (const mock of [matchTargets, matchRows, lookupAdd, lookupDescribe, lookupParse]) {
    vi.mocked(mock).mockReset();
  }
  vi.mocked(matchTargets).mockResolvedValue([]);
  vi.mocked(matchRows).mockImplementation((rows) => Promise.resolve(rows.map(() => null)));
  vi.mocked(watchJob).mockReset();
  waiting();
});

describe('LookupPage', () => {
  it('starts empty, with Check off until there is text', async () => {
    setup();
    expect(screen.getByRole('heading', { level: 1, name: 'Lookup' })).toBeDefined();
    expect((check() as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(box(), 'x');
    expect((check() as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows a seen job with its verdict, stage and dates, and opens it in the sheet', async () => {
    const view = makeView('job1', {
      title: 'Seen Role',
      verdict: 'near_miss',
      stage: 's3',
      firstSeenAt: new Date('2026-10-01T09:00:00Z'),
      judgedAt: new Date('2026-10-03T09:00:00Z'),
    });
    vi.mocked(matchTargets).mockResolvedValue([view]);
    vi.mocked(watchJob).mockImplementation((_id, callback) => {
      callback({ status: 'ready', data: view, invalid: 0 });
      return () => undefined;
    });
    const probe = setup();
    await paste(LINKEDIN);
    await userEvent.click(check());
    const list = await screen.findByRole('list', { name: 'Checked links' });
    expect(within(list).getByText('https://www.linkedin.com/jobs/view/4012345678')).toBeDefined();
    expect(within(list).getByText('Seen')).toBeDefined();
    expect(within(list).getByText('Near miss')).toBeDefined();
    expect(within(list).getByText(/Stopped at deep read/)).toBeDefined();
    expect(within(list).getByText(/first seen 1 Oct 2026 · judged 3 Oct 2026/)).toBeDefined();
    // The tracking parameters were dropped before the lookup.
    expect(vi.mocked(matchTargets).mock.calls[0]?.[0][0]?.keys).toContain('linkedin:4012345678');
    await userEvent.click(within(list).getByRole('button', { name: /Open job/ }));
    expect(probe.location()).toBe('/lookup?job=job1');
    expect((await screen.findByRole('dialog')).textContent).toContain('Seen Role');
  });

  it('says "Not seen yet" and offers to add by hand when it is not on a board it can ask', async () => {
    vi.mocked(matchTargets).mockResolvedValue([null]);
    vi.mocked(lookupAdd).mockResolvedValue({
      status: 'done',
      capReached: null,
      outcomes: [{ status: 'needs_description', jobId: 'new1' }],
    });
    vi.mocked(lookupDescribe).mockResolvedValue({ status: 'judged', verdict: 'apply' });
    setup();
    await paste(LINKEDIN);
    await userEvent.click(check());
    expect(await screen.findByText('Not seen yet')).toBeDefined();
    expect(screen.queryByRole('button', { name: /Add from the job board/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Add by hand/ }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Title' }), 'Product Analyst');
    await userEvent.type(screen.getByRole('textbox', { name: 'Company' }), 'Acme Analytics');
    await userEvent.type(screen.getByRole('textbox', { name: /Description/ }), 'The posting text');
    await userEvent.click(screen.getByRole('button', { name: 'Add and judge' }));
    expect(await screen.findByText(/Added\. Judged: Apply/)).toBeDefined();
    // The LinkedIn ID comes from the link, not from anything typed.
    expect(lookupAdd).toHaveBeenCalledWith([
      {
        kind: 'row',
        title: 'Product Analyst',
        company: 'Acme Analytics',
        location: '',
        linkedinId: '4012345678',
      },
    ]);
    expect(lookupDescribe).toHaveBeenCalledWith('new1', 'The posting text');
  });

  it('adds an unseen job-board link through the board API and reports the outcome', async () => {
    vi.mocked(matchTargets).mockResolvedValue([null]);
    vi.mocked(lookupAdd).mockResolvedValue({
      status: 'done',
      capReached: null,
      outcomes: [{ status: 'judged', jobId: 'gh1', verdict: 'wildcard' }],
    });
    setup();
    await paste(GREENHOUSE);
    await userEvent.click(check());
    await userEvent.click(await screen.findByRole('button', { name: 'Add from the job board' }));
    expect(lookupAdd).toHaveBeenCalledWith([{ kind: 'url', url: GREENHOUSE }]);
    const results = await screen.findByRole('list', { name: 'Results' });
    expect(within(results).getByText('Judged: Wildcard')).toBeDefined();
    expect(within(results).getByRole('button', { name: /Open job/ })).toBeDefined();
    // Focus moves to the results for screen readers.
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Added' }));
    });
  });

  it('says when nothing could be read, and offers the model once for a long paste', async () => {
    vi.mocked(lookupParse).mockResolvedValue({
      status: 'parsed',
      capReached: null,
      rows: [{ title: 'Product Analyst', company: 'Acme Analytics', location: 'Reading' }],
    });
    setup();
    await paste('A short note');
    await userEvent.click(check());
    expect(await screen.findByText(/No job links or results-page jobs found/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Let the model try' })).toBeNull();

    cleanup();
    setup();
    await paste(UNREADABLE_PASTE.repeat(3));
    await userEvent.click(check());
    expect(lookupParse).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByRole('button', { name: 'Let the model try' }));
    expect(lookupParse).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('checkbox', { name: /Add Product Analyst/ })).toBeDefined();
  });

  it('reads a readable page without calling the model', async () => {
    setup();
    await paste(resultsPageText());
    await userEvent.click(check());
    await screen.findByRole('list', { name: 'Jobs read from the page' });
    expect(lookupParse).not.toHaveBeenCalled();
  });

  it('shows an error when checking fails', async () => {
    vi.mocked(matchTargets).mockRejectedValue(new Error('offline'));
    setup();
    await paste(LINKEDIN);
    await userEvent.click(check());
    expect((await screen.findByRole('alert')).textContent).toContain("Couldn't check");
  });
});

describe('a pasted results page', () => {
  it('previews every job, with seen ones marked and unticked, and adds the ticked ones', async () => {
    const seen = makeView('seen1', { title: RESULTS_CARDS[1]?.title ?? '', verdict: 'skip' });
    vi.mocked(matchRows).mockImplementation((rows) =>
      Promise.resolve(rows.map((_row, index) => (index === 1 ? seen : null))),
    );
    vi.mocked(lookupAdd).mockResolvedValue({
      status: 'done',
      capReached: null,
      outcomes: [{ status: 'judged', jobId: 'j0', verdict: 'apply' }],
    });
    setup();
    await paste(resultsPageText(), resultsHtml());
    await userEvent.click(check());
    const list = await screen.findByRole('list', { name: 'Jobs read from the page' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(25);
    expect(screen.getByText(/25 read · 24 new/)).toBeDefined();
    expect(within(list).getByText('Seen')).toBeDefined();
    expect(within(list).getAllByRole('checkbox')).toHaveLength(24);

    // Untick all but the first, then add.
    const boxes = within(list).getAllByRole('checkbox');
    for (const item of boxes.slice(1)) await userEvent.click(item);
    const add = screen.getByRole('button', { name: 'Add 1 job' });
    await userEvent.click(add);
    expect(lookupAdd).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(lookupAdd).mock.calls[0]?.[0] ?? [];
    expect(sent).toHaveLength(1);
    // The LinkedIn ID came from the pasted HTML's link, paired with the card's title.
    expect(sent[0]).toMatchObject({
      kind: 'row',
      title: RESULTS_CARDS[0]?.title,
      company: RESULTS_CARDS[0]?.company,
      linkedinId: RESULTS_CARDS[0]?.id,
    });
    expect(await screen.findByText('Judged: Apply')).toBeDefined();
  });

  it('reads the same page from plain text alone, with no job IDs', async () => {
    setup();
    await paste(resultsPageText());
    await userEvent.click(check());
    await screen.findByRole('list', { name: 'Jobs read from the page' });
    const rows = vi.mocked(matchRows).mock.calls[0]?.[0] ?? [];
    expect(rows).toHaveLength(25);
    expect(rows.every((row) => row.linkedinId === undefined)).toBe(true);
  });

  it('reads the IDs from the HTML links when the paste has them', async () => {
    setup();
    await paste(resultsPageText(), resultsHtml());
    await userEvent.click(check());
    await screen.findByRole('list', { name: 'Jobs read from the page' });
    const rows = vi.mocked(matchRows).mock.calls[0]?.[0] ?? [];
    expect(rows.map((row) => row.linkedinId)).toEqual(RESULTS_CARDS.map((card) => card.id));
  });

  it('never lets pasted HTML into the page', async () => {
    setup();
    const hostile = `<script>window.__pwned = true</script><img src=x onerror="window.__pwned=true"><iframe src="https://evil.example.test"></iframe>${resultsHtml()}`;
    await paste(resultsPageText(), hostile);
    await userEvent.click(check());
    await screen.findByRole('list', { name: 'Jobs read from the page' });
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
    expect(document.querySelector('script, iframe, img')).toBeNull();
  });

  it('says every job has been seen when none is new', async () => {
    vi.mocked(matchRows).mockImplementation((rows) =>
      Promise.resolve(rows.map(() => makeView('s', { verdict: 'skip' }))),
    );
    setup();
    await paste(resultsPageText());
    await userEvent.click(check());
    expect(await screen.findByText('Every job on this page has been seen.')).toBeDefined();
    expect(screen.queryByRole('button', { name: /^Add \d+ job/ })).toBeNull();
  });

  it('tells busy, cap and error apart, and never retries a call', async () => {
    vi.mocked(lookupAdd).mockResolvedValue({ status: 'busy', retryAfterSeconds: 130 });
    setup();
    await paste(resultsPageText());
    await userEvent.click(check());
    await userEvent.click(await screen.findByRole('button', { name: 'Add 25 jobs' }));
    expect((await screen.findByRole('alert')).textContent).toContain('about 3 min');
    expect(lookupAdd).toHaveBeenCalledTimes(1);

    cleanup();
    vi.mocked(lookupAdd).mockReset().mockRejectedValue(new Error('network'));
    setup();
    await paste(resultsPageText());
    await userEvent.click(check());
    await userEvent.click(await screen.findByRole('button', { name: 'Add 25 jobs' }));
    expect((await screen.findByRole('alert')).textContent).toContain("Lookup couldn't finish");
    expect(lookupAdd).toHaveBeenCalledTimes(1);
  });

  it('explains a daily cap and which jobs were queued', async () => {
    vi.mocked(lookupAdd).mockResolvedValue({
      status: 'done',
      capReached: 'daily',
      outcomes: [
        { status: 'judged', jobId: 'a', verdict: 'apply' },
        { status: 'queued', jobId: 'b', reason: 'daily_cap' },
        { status: 'skipped', jobId: 'c', stage: 's1', ruleId: 'R3', note: 'clearance' },
        { status: 'needs_description', jobId: 'd' },
        { status: 'seen', jobId: 'e' },
        { status: 'review', jobId: 'f' },
        { status: 'invalid' },
      ],
    });
    setup();
    await paste(resultsPageText());
    await userEvent.click(check());
    await userEvent.click(await screen.findByRole('button', { name: 'Add 25 jobs' }));
    expect(await screen.findByText(/reached today.s spending limit/)).toBeDefined();
    const results = screen.getByRole('list', { name: 'Results' });
    expect(within(results).getByText('Judged: Apply')).toBeDefined();
    expect(
      within(results).getByText(/queued for the next scan, because today.s Lookup limit/),
    ).toBeDefined();
    expect(within(results).getByText(/Skipped\. Rules \(rule R3\): clearance/)).toBeDefined();
    expect(within(results).getByText(/It needs a description/)).toBeDefined();
    expect(within(results).getByText(/Already seen/)).toBeDefined();
    expect(within(results).getByText(/up for review/)).toBeDefined();
    expect(within(results).getByText("Couldn't be added.")).toBeDefined();
    // Only outcomes with a job can be opened.
    expect(within(results).getAllByRole('button', { name: /Open job/ })).toHaveLength(6);
  });

  it('disables Add while it works and shows progress', async () => {
    let finish: (value: never) => void = () => undefined;
    vi.mocked(lookupAdd).mockReturnValue(new Promise((resolve) => (finish = resolve as never)));
    setup();
    await paste(resultsPageText());
    await userEvent.click(check());
    await userEvent.click(await screen.findByRole('button', { name: 'Add 25 jobs' }));
    expect(screen.getByRole('status').textContent).toContain('Adding and judging');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Adding…' }).disabled).toBe(true);
    await act(async () => {
      finish({ status: 'done', capReached: null, outcomes: [] } as never);
      await Promise.resolve();
    });
  });
});

describe('Waiting for a description', () => {
  const waitingView = (id: string, overrides = {}) =>
    makeUnjudgedView(id, {
      title: `Waiting ${id}`,
      stage: 's2',
      next: 'description',
      url: 'https://www.linkedin.com/jobs/view/4012345678',
      sources: [
        {
          id: 'linkedin-alert',
          url: 'https://www.linkedin.com/jobs/view/4012345678',
          externalId: '4012345678',
          seenAt: new Date('2026-10-12T09:00:00Z'),
        },
      ],
      ...overrides,
    });

  it('has an empty state', () => {
    setup();
    expect(screen.getByText('Nothing is waiting for a description.')).toBeDefined();
  });

  it('lists waiting jobs with an Open on LinkedIn link and Paste description', () => {
    waiting(
      waitingView('w1'),
      waitingView('w2', {
        url: 'https://www.linkedin.com/jobs/search/?keywords=Analyst%20Acme',
        sources: [],
      }),
    );
    setup();
    const list = screen.getByRole('list', { name: 'Jobs waiting for a description' });
    const links = within(list).getAllByRole('link');
    expect(links[0]?.textContent).toContain('Open on LinkedIn');
    expect(links[0]?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(links[0]?.getAttribute('target')).toBe('_blank');
    expect(links[1]?.textContent).toContain('Search on LinkedIn');
    expect(within(list).getAllByRole('button', { name: /Paste description/ })).toHaveLength(2);
  });

  it('pastes a description, judges it, and keeps the note after the job leaves the list', async () => {
    waiting(waitingView('w1'));
    vi.mocked(lookupDescribe).mockResolvedValue({ status: 'judged', verdict: 'near_miss' });
    setup();
    await userEvent.click(screen.getByRole('button', { name: /Paste description/ }));
    expect(
      screen.getByRole('button', { name: /Paste description/ }).getAttribute('aria-expanded'),
    ).toBe('true');
    await userEvent.click(screen.getByRole('textbox', { name: 'Job description' }));
    await userEvent.paste('The whole posting');
    await userEvent.click(screen.getByRole('button', { name: 'Judge' }));
    expect(lookupDescribe).toHaveBeenCalledWith('w1', 'The whole posting');
    expect((await screen.findAllByText(/Waiting w1: Judged: Near miss/)).length).toBeGreaterThan(0);
    // The form closes after a result.
    expect(screen.queryByRole('textbox', { name: 'Job description' })).toBeNull();
  });

  it('shows the error and keeps the text when a call fails', async () => {
    waiting(waitingView('w1'));
    vi.mocked(lookupDescribe).mockRejectedValue(new Error('network'));
    setup();
    await userEvent.click(screen.getByRole('button', { name: /Paste description/ }));
    await userEvent.click(screen.getByRole('textbox', { name: 'Job description' }));
    await userEvent.paste('The posting');
    await userEvent.click(screen.getByRole('button', { name: 'Judge' }));
    expect((await screen.findByRole('alert')).textContent).toContain("Lookup couldn't finish");
    expect(
      screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Job description' }).value,
    ).toBe('The posting');
    expect(lookupDescribe).toHaveBeenCalledTimes(1);
  });

  it('shows a loading state and an error state', () => {
    vi.mocked(watchWaitingJobs).mockImplementation((_size, callback) => {
      callback({ status: 'loading' });
      return () => undefined;
    });
    setup();
    expect(screen.getByRole('status', { name: 'Loading waiting jobs' })).toBeDefined();
    cleanup();
    vi.mocked(watchWaitingJobs).mockImplementation((_size, callback) => {
      callback({ status: 'error', message: "Couldn't load the jobs waiting for a description." });
      return () => undefined;
    });
    setup();
    expect(screen.getByRole('alert').textContent).toContain("Couldn't load");
  });

  it('asks for the next page when the list is full', async () => {
    const full = Array.from({ length: 20 }, (_, i) => waitingView(`w${String(i)}`));
    waiting(...full);
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(vi.mocked(watchWaitingJobs).mock.calls.at(-1)?.[0]).toBe(40);
  });
});
