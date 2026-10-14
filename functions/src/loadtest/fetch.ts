import type { BoardPosting } from './data.js';

/**
 * The load test's fake job API: Greenhouse boards from the generated data, robots.txt answering
 * 404 (no rules), everything else 404. It is handed to the real HTTP client, so the 1 s per-host
 * spacing, retries and the deadline apply as in production. Every request is recorded.
 */
export interface FetchRecord {
  url: string;
  /** Epoch ms when the request reached the fake. */
  at: number;
  status: number;
}

const BOARD = /^https:\/\/boards-api\.greenhouse\.io\/v1\/boards\/([^/?]+)\/jobs(?:\?.*)?$/;

export function loadFetch(
  boards: ReadonlyMap<string, { jobs: BoardPosting[] }>,
  options: { clock?: () => number; records?: FetchRecord[] } = {},
): typeof fetch {
  const clock = options.clock ?? Date.now;
  const records = options.records ?? [];
  const impl = (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const token = BOARD.exec(url)?.[1];
    const board = token ? boards.get(decodeURIComponent(token)) : undefined;
    const response = board
      ? new Response(JSON.stringify(board), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      : new Response('Not Found', { status: 404 });
    records.push({ url, at: clock(), status: response.status });
    return Promise.resolve(response);
  };
  return impl;
}
