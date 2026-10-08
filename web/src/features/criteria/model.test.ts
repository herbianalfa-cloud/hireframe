import { ADOPTED_S1_RULE_IDS, CRITERIA_SEED_V1 } from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

import { slugify } from './model';

describe('slugify', () => {
  it('turns each adopted S1 term into the ID the spot-check list queries (ADR-045)', () => {
    for (const id of ADOPTED_S1_RULE_IDS) {
      const row = CRITERIA_SEED_V1.excluded_titles.find((rule) => rule.id === id);
      expect(row, id).toBeDefined();
      expect(slugify(row?.term ?? '', new Set()), id).toBe(id);
    }
  });
});
