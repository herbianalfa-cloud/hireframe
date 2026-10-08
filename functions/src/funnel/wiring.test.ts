import type { HostPause } from '../http/client.js';
import { describe, expect, it, vi } from 'vitest';

import { FAKE_WATCHLIST } from '../sources/fixtures.js';
import { atsHttpClient, atsHydratorFor, type AtsHydratorDeps } from './wiring.js';
import { testJob, TEST_NOW } from './testing.js';

const GREENHOUSE_HOST = 'boards-api.greenhouse.io';

function fakeStore(carried: HostPause[] = []) {
  const saved: HostPause[][] = [];
  const store: AtsHydratorDeps['store'] = {
    watchedCompanies: () => Promise.resolve([...FAKE_WATCHLIST]),
    attachPosting: () => Promise.resolve(),
    atsPauses: () => Promise.resolve(carried),
    saveAtsPauses: (pauses) => {
      saved.push([...pauses]);
      return Promise.resolve();
    },
  };
  return { store, saved };
}

const alertJob = () =>
  testJob({
    title: 'Product Analyst',
    company: 'Acme Analytics',
    city: 'london',
    descriptionKind: 'none',
  });

describe('the scan’s ATS hydrator wiring (ADR-049)', () => {
  const schema = {
    parse: (value: unknown) => value,
    safeParse: (value: unknown) => ({ success: true as const, data: value }),
  };

  it('uses a client that never requests LinkedIn and the other alert-only boards', async () => {
    const fetchSpy = vi.fn();
    const { store } = fakeStore();
    const http = await atsHttpClient({ fetch: fetchSpy, store, deadline: Date.now() + 60_000 });
    for (const url of [
      'https://www.linkedin.com/jobs/view/4012345678',
      'https://www.indeed.com/viewjob',
      'https://wellfound.com/jobs',
      'https://www.glassdoor.com/job',
    ]) {
      await expect(http.getJson(url, schema as never, { label: 'test' })).rejects.toMatchObject({
        code: 'forbidden_host',
      });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('stops at the deadline it is given: no request starts after the S3 stop', async () => {
    const fetchSpy = vi.fn();
    const { store } = fakeStore();
    const http = await atsHttpClient({ fetch: fetchSpy, store, deadline: Date.now() - 1 });
    await expect(
      http.getJson(`https://${GREENHOUSE_HOST}/v1/boards/x/jobs`, schema as never, {
        label: 'test',
      }),
    ).rejects.toMatchObject({ code: 'deadline' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('honours the pauses earlier runs saved, without a request', async () => {
    const fetchSpy = vi.fn();
    const { store } = fakeStore([{ host: GREENHOUSE_HOST, until: Date.now() + 3_600_000 }]);
    const http = await atsHttpClient({ fetch: fetchSpy, store, deadline: Date.now() + 60_000 });
    await expect(
      http.getJson(`https://${GREENHOUSE_HOST}/v1/boards/x/jobs`, schema as never, {
        label: 'test',
      }),
    ).rejects.toMatchObject({ code: 'host_paused' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('saves the pause a board gives it when the run ends', async () => {
    const fetchSpy = vi.fn((input: URL | string) =>
      Promise.resolve(
        new URL(input.toString()).pathname === '/robots.txt'
          ? new Response('', { status: 404 })
          : new Response('', { status: 429, headers: { 'Retry-After': '86400' } }),
      ),
    );
    const { store, saved } = fakeStore();
    const hydrator = await atsHydratorFor({
      fetch: fetchSpy as unknown as typeof fetch,
      store,
      deadline: Date.now() + 60_000,
    });
    expect(await hydrator.fullText({ id: 'j1', job: alertJob() })).toBeNull();
    expect(saved).toEqual([]);
    await hydrator.finish();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.map((pause) => pause.host)).toEqual([GREENHOUSE_HOST]);
    expect(saved[0]?.[0]?.until).toBeGreaterThan(TEST_NOW.getTime());
  });
});
