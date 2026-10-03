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

  it('is not an accidental empty regeneration', () => {
    expect(WATCHLIST_SEED.length).toBeGreaterThanOrEqual(150);
    expect(
      WATCHLIST_SEED.filter((company) => company.ats.type !== 'none').length,
    ).toBeGreaterThanOrEqual(50);
  });

  it('holds the reviewed boards', () => {
    const board = (id: string) => WATCHLIST_SEED.find((company) => company.id === id)?.ats;
    expect(board('monzo')).toEqual({ type: 'greenhouse', token: 'monzo' });
    expect(board('kaluza')?.type).toBe('greenhouse');
    expect(board('snyk')?.type).toBe('ashby');
    // Real UK companies whose detected board was the wrong company, or unchecked: no board.
    for (const id of ['wise', 'peak', 'revolut']) expect(board(id)).toEqual({ type: 'none' });
  });

  it('is sorted by ID, so regenerated seeds diff cleanly', () => {
    const ids = WATCHLIST_SEED.map((company) => company.id);
    expect(ids).toEqual([...ids].sort());
  });
});
