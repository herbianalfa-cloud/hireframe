import {
  ADZUNA_SEARCH,
  ASHBY_BOARD,
  GREENHOUSE_BOARD,
  HN_SEARCH,
  HN_THREAD,
  LEVER_BOARD,
  REED_DETAILS,
  REED_SEARCH,
  WORKABLE_ACCOUNT,
} from './fixtures.js';

/**
 * A `fetch` that serves the fixtures by URL, for tests and the emulator (ADR-029). Nothing
 * leaves the machine. robots.txt is a 404 everywhere (no rules); unknown URLs are 404s.
 */
const ROUTES: readonly [RegExp, unknown][] = [
  [/^https:\/\/boards-api\.greenhouse\.io\/v1\/boards\/acmeanalytics\/jobs/, GREENHOUSE_BOARD],
  [/^https:\/\/api(\.eu)?\.lever\.co\/v0\/postings\/bramble/, LEVER_BOARD],
  [/^https:\/\/api\.ashbyhq\.com\/posting-api\/job-board\/cobaltledger/, ASHBY_BOARD],
  [/^https:\/\/apply\.workable\.com\/api\/v1\/widget\/accounts\/deltadock/, WORKABLE_ACCOUNT],
  [/^https:\/\/www\.reed\.co\.uk\/api\/1\.0\/search/, REED_SEARCH],
  [/^https:\/\/www\.reed\.co\.uk\/api\/1\.0\/jobs\/\d+$/, REED_DETAILS],
  [/^https:\/\/api\.adzuna\.com\/v1\/api\/jobs\/gb\/search\//, ADZUNA_SEARCH],
  [/^https:\/\/hn\.algolia\.com\/api\/v1\/search_by_date/, HN_SEARCH],
  [/^https:\/\/hn\.algolia\.com\/api\/v1\/items\/41000000$/, HN_THREAD],
];

export function fakeFetch(url: string | URL): Promise<Response> {
  const href = url.toString();
  const route = ROUTES.find(([pattern]) => pattern.test(href));
  return Promise.resolve(
    route
      ? new Response(JSON.stringify(route[1]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      : new Response('Not Found', { status: 404 }),
  );
}
