import { describe, expect, it } from 'vitest';

import { CompanySeedSchema } from './jobs.js';
import { WATCHLIST_SEED } from './watchlist-seed.js';

describe('WATCHLIST_SEED (ADR-031)', () => {
  it('parses, with unique IDs, domains and board tokens', () => {
    for (const company of WATCHLIST_SEED) expect(CompanySeedSchema.parse(company)).toEqual(company);
    const unique = (values: string[]) => new Set(values).size === values.length;
    expect(unique(WATCHLIST_SEED.map((company) => company.id))).toBe(true);
    expect(unique(WATCHLIST_SEED.map((company) => company.domain))).toBe(true);
    const boards = WATCHLIST_SEED.filter((company) => company.ats.type !== 'none').map((company) =>
      `${company.ats.type}:${company.ats.token ?? ''}`.toLowerCase(),
    );
    expect(unique(boards)).toBe(true);
  });

  it('is sorted by ID, so regenerated seeds diff cleanly', () => {
    const ids = WATCHLIST_SEED.map((company) => company.id);
    expect(ids).toEqual([...ids].sort());
  });
});
