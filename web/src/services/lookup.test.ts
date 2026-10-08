import type { LookupRow } from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

import { makeView } from '@/features/jobs/fixtures';

import { indexByKey, KEY_CHUNK, lookupKeysSpec, pickMatch, rowKeys } from './lookup';

const row = (overrides: Partial<LookupRow> = {}): LookupRow => ({
  title: 'Product Analyst',
  company: 'Acme Analytics',
  location: 'London, England, United Kingdom',
  ...overrides,
});

describe('rowKeys', () => {
  it('gives the LinkedIn ID first, then the company|title|city key', () => {
    const keys = rowKeys(row({ linkedinId: '4020000100' }));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe('linkedin:4020000100');
    expect(keys[1]).toMatch(/^d:[0-9a-f]{16}$/);
  });

  it('has only the name key without an ID, and the same one however the town is written', () => {
    const [plain] = rowKeys(row());
    expect(rowKeys(row())).toEqual([plain]);
    expect(rowKeys(row({ location: 'London' }))).toEqual([plain]);
    expect(rowKeys(row({ location: 'London Area, United Kingdom' }))).toEqual([plain]);
    expect(rowKeys(row({ title: 'Data Analyst' }))).not.toEqual([plain]);
  });
});

describe('matching rows and links to stored jobs', () => {
  const alert = makeView('alert', { keys: ['linkedin:4020000100', 'd:aaaaaaaaaaaaaaaa'] });
  const board = makeView('board', { keys: ['greenhouse:77', 'd:bbbbbbbbbbbbbbbb'] });
  const byKey = indexByKey([alert, board]);

  it('finds a job by any of its keys', () => {
    expect(pickMatch(['linkedin:4020000100'], byKey)).toBe(alert);
    expect(pickMatch(['greenhouse:77'], byKey)).toBe(board);
    expect(pickMatch(['d:bbbbbbbbbbbbbbbb'], byKey)).toBe(board);
  });

  it('prefers the first key given, so an ID wins over a name', () => {
    expect(pickMatch(['linkedin:4020000100', 'd:bbbbbbbbbbbbbbbb'], byKey)).toBe(alert);
    expect(pickMatch(['linkedin:9', 'd:bbbbbbbbbbbbbbbb'], byKey)).toBe(board);
  });

  it('returns null for an unseen job and for no keys at all', () => {
    expect(pickMatch(['linkedin:1'], byKey)).toBeNull();
    expect(pickMatch([], byKey)).toBeNull();
  });

  it('keeps the first job read when two share a key', () => {
    const twin = makeView('twin', { keys: ['linkedin:4020000100'] });
    expect(indexByKey([alert, twin]).get('linkedin:4020000100')).toBe(alert);
  });
});

describe('lookupKeysSpec', () => {
  it('is one array-contains-any filter on keys, with no ordering', () => {
    expect(lookupKeysSpec(['a', 'b'])).toEqual({
      collection: 'jobs',
      filters: [{ field: 'keys', op: 'array-contains-any', value: ['a', 'b'] }],
      orderBy: [],
    });
    expect(KEY_CHUNK).toBe(30);
  });
});
