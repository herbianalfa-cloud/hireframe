import { describe, expect, it } from 'vitest';

import type { Fact } from './profile.js';
import { planUploadRemoval } from './removal.js';

const AT = new Date('2026-10-01T09:00:00Z');
const DOC = 'abcdefghij0123456789';
const OTHER = 'zyxwvutsrq9876543210';

function fact(id: string, overrides: Partial<Fact> = {}): { id: string; fact: Fact } {
  return {
    id,
    fact: {
      type: 'skill',
      text: `Fact ${id}`,
      evidence: `Fact ${id}`,
      dates: {},
      tags: [],
      lanes: [],
      source: 'cv',
      sourceDocId: DOC,
      status: 'active',
      version: 1,
      evidenceVerified: true,
      createdAt: AT,
      updatedAt: AT,
      schemaVersion: 1,
      ...overrides,
    },
  };
}

const review = (docId: string) => ({
  kind: 'changed' as const,
  proposed: { type: 'skill' as const, text: 'x', evidence: 'x', dates: {}, tags: [], lanes: [] },
  docId,
  at: AT,
});

describe('planUploadRemoval', () => {
  it('archives untouched facts from the upload and drops its proposed changes', () => {
    const plan = planUploadRemoval(
      [
        fact('added'),
        fact('older', { sourceDocId: OTHER, review: review(DOC) }),
        fact('unrelated', { sourceDocId: OTHER }),
        fact('other-review', { sourceDocId: OTHER, review: review(OTHER) }),
      ],
      DOC,
    );
    expect(plan).toEqual({ archive: ['added'], dropReviews: ['older'], skippedEdited: 0 });
  });

  it('keeps facts the owner edited, accepted or kept a change on (version > 1)', () => {
    const plan = planUploadRemoval([fact('edited', { version: 2 }), fact('a')], DOC);
    expect(plan).toEqual({ archive: ['a'], dropReviews: [], skippedEdited: 1 });
  });

  it('never archives a manual fact', () => {
    const plan = planUploadRemoval([fact('m', { source: 'manual' })], DOC);
    expect(plan).toEqual({ archive: [], dropReviews: [], skippedEdited: 1 });
  });

  it('ignores facts already archived, so a retry counts nothing twice', () => {
    const plan = planUploadRemoval(
      [
        fact('done', { status: 'archived', version: 2 }),
        fact('was-archived', { status: 'archived' }),
      ],
      DOC,
    );
    expect(plan).toEqual({ archive: [], dropReviews: [], skippedEdited: 0 });
  });

  it('is empty for an upload that added nothing', () => {
    expect(planUploadRemoval([fact('a', { sourceDocId: OTHER })], DOC)).toEqual({
      archive: [],
      dropReviews: [],
      skippedEdited: 0,
    });
  });
});
