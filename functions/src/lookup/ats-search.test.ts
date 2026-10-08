import { normaliseRawJob, type AtsPosting } from '@hireframe/shared';
import { describe, expect, it, vi } from 'vitest';

import { FAKE_WATCHLIST, GREENHOUSE_BOARD } from '../sources/fixtures.js';
import { testHttpClient } from '../sources/testing.js';
import type { WatchedCompany } from '../sources/types.js';
import { createAtsSearch } from './ats-search.js';

const acme = { title: 'Product Analyst', company: 'Acme Analytics', city: 'london' };

function setup(options: { watched?: readonly WatchedCompany[]; maxBoards?: number } = {}) {
  const http = testHttpClient();
  const getJson = vi.spyOn(http, 'getJson');
  const search = createAtsSearch({
    http,
    watched: () => Promise.resolve(options.watched ?? FAKE_WATCHLIST),
    maxBoards: options.maxBoards ?? 12,
  });
  return { search, getJson };
}

describe('ATS board search', () => {
  it('finds the one posting of a watched company by title, with its full text and key', async () => {
    const { search } = setup();
    const found = await search.find(acme);
    expect(found.searched).toBe(true);
    expect(found.match?.companyId).toBe('acme-analytics');
    expect(found.match?.posting).toMatchObject({
      sourceId: 'greenhouse',
      externalId: '5551234',
      title: 'Product Analyst',
      description: { kind: 'full' },
    });
    expect(found.match?.posting.description.text).toContain('weekly metrics review');
    expect(found.match?.posting.keys).toContain('greenhouse:5551234');
  });

  it('matches the title the way dedupe does (noise words dropped), by company ID or name', async () => {
    const { search } = setup();
    const byName = await search.find({ ...acme, title: 'Product Analyst (Hybrid) - London' });
    expect(byName.match?.posting.externalId).toBe('5551234');
    const byId = await search.find({
      ...acme,
      company: 'A different spelling',
      companyId: 'acme-analytics',
    });
    expect(byId.match?.posting.externalId).toBe('5551234');
    const byLooseName = await search.find({ ...acme, company: 'ACME ANALYTICS LTD' });
    expect(byLooseName.match?.posting.externalId).toBe('5551234');
  });

  it('reads each board once, whatever the number of jobs', async () => {
    const { search, getJson } = setup();
    await search.find(acme);
    await search.find({ ...acme, title: 'Senior Software Engineer', city: 'new york' });
    await search.find({ ...acme, title: 'Something Else' });
    expect(getJson).toHaveBeenCalledTimes(1);
  });

  it('gives no match for an unknown title, an unwatched company or a company with no board', async () => {
    const { search, getJson } = setup();
    expect((await search.find({ ...acme, title: 'Chief Wizard' })).match).toBeNull();
    const unwatched = await search.find({ ...acme, company: 'Nobody Ltd' });
    expect(unwatched).toEqual({ match: null, searched: false, failed: false });
    expect(getJson).toHaveBeenCalledTimes(0 + 1); // only the Acme board, for the first call
    const noBoard = setup({
      watched: [{ id: 'x', name: 'Acme Analytics', ats: { type: 'none' } }],
    });
    expect(await noBoard.search.find(acme)).toEqual({
      match: null,
      searched: false,
      failed: false,
    });
    expect(noBoard.getJson).not.toHaveBeenCalled();
  });

  it('never guesses: two postings that fit give no match unless the city leaves one', async () => {
    const twin = (id: number, location: string) => ({
      ...GREENHOUSE_BOARD.jobs[0],
      id,
      absolute_url: `https://job-boards.greenhouse.io/acmeanalytics/jobs/${String(id)}`,
      location: { name: location },
    });
    const board = { jobs: [twin(1, 'London, UK'), twin(2, 'Manchester, UK')] };
    const http = testHttpClient({
      fetch: ((url: string | URL) =>
        Promise.resolve(
          url.toString().includes('boards-api.greenhouse.io')
            ? new Response(JSON.stringify(board), { status: 200 })
            : new Response('', { status: 404 }),
        )) as typeof fetch,
    });
    const search = createAtsSearch({
      http,
      watched: () => Promise.resolve(FAKE_WATCHLIST),
      maxBoards: 5,
    });
    expect((await search.find({ ...acme, city: '' })).match).toBeNull();
    expect((await search.find({ ...acme, city: 'leeds' })).match).toBeNull();
    expect((await search.find({ ...acme, city: 'manchester' })).match?.posting.externalId).toBe(
      '2',
    );
  });

  it('reports a board that cannot be read, without throwing', async () => {
    const http = testHttpClient();
    const search = createAtsSearch({
      http,
      watched: () => Promise.resolve(FAKE_WATCHLIST),
      maxBoards: 5,
    });
    const found = await search.find({ ...acme, company: 'Echo Gone', companyId: 'echo-gone' });
    expect(found).toEqual({ match: null, searched: true, failed: true });
  });

  it('stops reading new boards at the cap', async () => {
    const { search, getJson } = setup({ maxBoards: 1 });
    await search.find(acme);
    const second = await search.find({
      title: 'Senior Product Analyst',
      company: 'Bramble Software',
      city: 'london',
    });
    expect(second.searched).toBe(false);
    expect(getJson).toHaveBeenCalledTimes(1);
  });

  describe('a posting from a board URL', () => {
    const fetchPosting = (posting: AtsPosting) => setup().search.fetchPosting(posting);

    it('uses the single-posting endpoint for Greenhouse and Lever', async () => {
      const { search, getJson } = setup();
      const gh = await search.fetchPosting({
        type: 'greenhouse',
        token: 'acmeanalytics',
        id: '5551234',
      });
      expect(gh?.posting).toMatchObject({ externalId: '5551234', company: 'Acme Analytics' });
      expect(gh?.companyId).toBe('acme-analytics');
      expect(String(getJson.mock.calls[0]?.[0])).toBe(
        'https://boards-api.greenhouse.io/v1/boards/acmeanalytics/jobs/5551234',
      );
      const lever = await fetchPosting({
        type: 'lever',
        token: 'bramble',
        id: '0b1c2d3e-0000-4000-8000-000000000001',
      });
      expect(lever?.posting.title).toBe('Senior Product Analyst');
    });

    it('filters the board list for Ashby and Workable', async () => {
      const ashby = await fetchPosting({
        type: 'ashby',
        token: 'cobaltledger',
        id: '7c1d0000-0000-4000-8000-0000000000aa',
      });
      expect(ashby?.posting.title).toBe('Product Analyst');
      const workable = await fetchPosting({
        type: 'workable',
        token: 'deltadock',
        id: 'a1b2c3d4e5',
      });
      expect(workable?.posting.externalId).toBe('A1B2C3D4E5');
    });

    it('returns null for a posting the board does not list, or an unknown board', async () => {
      expect(
        await fetchPosting({
          type: 'ashby',
          token: 'cobaltledger',
          id: '7c1d0000-0000-4000-8000-0000000000ff',
        }),
      ).toBeNull();
      expect(await fetchPosting({ type: 'greenhouse', token: 'nobody', id: '1' })).toBeNull();
    });

    it('is the same normalisation a scan applies', async () => {
      const found = await fetchPosting({
        type: 'greenhouse',
        token: 'acmeanalytics',
        id: '5551234',
      });
      const board = normaliseRawJob({
        sourceId: 'greenhouse',
        externalId: '5551234',
        url: 'https://job-boards.greenhouse.io/acmeanalytics/jobs/5551234',
        title: 'Product Analyst',
        company: 'Acme Analytics',
        locationText: 'London, UK',
        description: { kind: 'full', format: 'text', body: 'x' },
      });
      expect(found?.posting.keys).toEqual(expect.arrayContaining(board?.keys ?? ['missing']));
    });
  });
});
