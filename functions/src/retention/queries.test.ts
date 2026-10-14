import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { indexServes, type CompositeIndex } from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

import { oldSkipsSpec } from './queries.js';

const { indexes } = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../firestore.indexes.json', import.meta.url)), 'utf8'),
) as { indexes: CompositeIndex[] };

describe('retention query spec (ADR-040)', () => {
  it('is served by an index in firestore.indexes.json', () => {
    expect(indexServes(oldSkipsSpec(new Date('2026-08-01T00:00:00Z')), indexes)).toBe(true);
  });

  it('is not served by the descending index alone', () => {
    const descendingOnly = indexes.filter(
      (index) =>
        !(
          index.collectionGroup === 'jobs' &&
          index.fields.length === 2 &&
          index.fields[0]?.fieldPath === 'verdict' &&
          index.fields[1]?.fieldPath === 'judgedAt' &&
          index.fields[1].order === 'ASCENDING'
        ),
    );
    expect(indexServes(oldSkipsSpec(new Date()), descendingOnly)).toBe(false);
  });
});
