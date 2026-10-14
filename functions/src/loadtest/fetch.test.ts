import { describe, expect, it } from 'vitest';

import { buildLoadData, LOAD_DEFAULTS } from './data.js';
import { loadFetch, type FetchRecord } from './fetch.js';

describe('loadFetch', () => {
  const data = buildLoadData({ ...LOAD_DEFAULTS, now: new Date('2026-10-05T08:00:00Z') });

  it('serves a board, 404s robots.txt and unknown URLs, and records every request', async () => {
    const records: FetchRecord[] = [];
    let now = 1_000;
    const fetcher = loadFetch(data.boards, { clock: () => (now += 10), records });
    const board = await fetcher(
      'https://boards-api.greenhouse.io/v1/boards/loadboard01/jobs?content=true',
    );
    const body = (await board.json()) as { jobs: unknown[] };
    expect(board.status).toBe(200);
    expect(body.jobs.length).toBeGreaterThan(40);
    expect((await fetcher('https://boards-api.greenhouse.io/robots.txt')).status).toBe(404);
    expect(
      (await fetcher('https://boards-api.greenhouse.io/v1/boards/nope/jobs?content=true')).status,
    ).toBe(404);
    expect(records.map((r) => [r.status, r.at])).toEqual([
      [200, 1_010],
      [404, 1_020],
      [404, 1_030],
    ]);
  });
});
