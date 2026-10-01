import { CRITERIA_SEED_V1 } from '@hireframe/shared';
import { deleteField, serverTimestamp, Timestamp, type DocumentData } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';

import {
  buildAcceptReview,
  buildCriteriaWrite,
  buildFactWrite,
  buildKeepReview,
  buildUploadRemoval,
} from './fact-writes';

const CREATED = Timestamp.fromDate(new Date('2026-10-01T09:00:00Z'));
const NOW = serverTimestamp();

const raw: DocumentData = {
  type: 'experience',
  text: 'Ran onboarding for new B2B clients',
  evidence: 'Ran onboarding for new B2B clients',
  dates: { start: '2024-01' },
  tags: ['onboarding'],
  lanes: ['secondary'],
  status: 'active',
  source: 'cv',
  sourceDocId: 'abcdefghij0123456789',
  version: 3,
  evidenceVerified: true,
  createdAt: CREATED,
  updatedAt: CREATED,
  schemaVersion: 1,
};

const proposed = { ...raw, text: 'Ran onboarding for 12 new B2B clients', status: undefined };
const flagged: DocumentData = {
  ...raw,
  review: { kind: 'changed', proposed, docId: 'zyxwvutsrq9876543210', at: CREATED },
};

describe('buildFactWrite', () => {
  it('bumps the version, stamps the server time and snapshots the fact after the write', () => {
    const write = buildFactWrite(raw, { text: 'Ran onboarding for B2B clients' }, 'edit', NOW);
    expect(write.version).toBe(4);
    expect(write.update).toEqual({
      text: 'Ran onboarding for B2B clients',
      version: 4,
      updatedAt: NOW,
    });
    expect(write.snapshot).toEqual({
      ...raw,
      text: 'Ran onboarding for B2B clients',
      version: 4,
      updatedAt: NOW,
    });
    expect(write.snapshot.createdAt).toBe(CREATED); // the original Timestamp, not a Date
  });

  it('drops fields the owner may not change', () => {
    const write = buildFactWrite(
      raw,
      { status: 'archived', source: 'manual' } as never,
      'archive',
      NOW,
    );
    expect(write.update).toEqual({ status: 'archived', version: 4, updatedAt: NOW });
  });

  it('sets, then removes, an evidence link', () => {
    const url = 'https://example.com/portfolio';
    const set = buildFactWrite(raw, { evidenceUrl: url }, 'edit', NOW);
    expect(set.update).toEqual({ evidenceUrl: url, version: 4, updatedAt: NOW });
    expect(set.snapshot.evidenceUrl).toBe(url);

    const linked = { ...raw, evidenceUrl: url };
    const cleared = buildFactWrite(linked, { evidenceUrl: null }, 'edit', NOW);
    expect(cleared.update).toEqual({ evidenceUrl: deleteField(), version: 4, updatedAt: NOW });
    expect(cleared.snapshot).toEqual({ ...raw, version: 4, updatedAt: NOW });
  });

  it('never removes a required field, even when patched with null', () => {
    const write = buildFactWrite(raw, { text: null, tags: ['b2b'] }, 'edit', NOW);
    expect(write.update).toEqual({ tags: ['b2b'], version: 4, updatedAt: NOW });
    expect(write.snapshot.text).toBe(raw.text);
  });

  it('keeps a pending review on a plain edit', () => {
    const write = buildFactWrite(flagged, { tags: ['b2b'] }, 'edit', NOW);
    expect(write.update).not.toHaveProperty('review');
    expect(write.snapshot.review).toEqual(flagged.review);
  });
});

describe('accepting or keeping a proposed change', () => {
  it('accept applies the proposed content and removes the review', () => {
    const write = buildAcceptReview(flagged, NOW);
    expect(write.change).toBe('review_accepted');
    expect(write.update).toMatchObject({
      text: 'Ran onboarding for 12 new B2B clients',
      version: 4,
    });
    expect(write.update.review).toEqual(deleteField());
    expect(write.snapshot).not.toHaveProperty('review');
    expect(write.snapshot.text).toBe('Ran onboarding for 12 new B2B clients');
    expect(write.snapshot.status).toBe('active');
  });

  it('keep removes the review without changing the content', () => {
    const write = buildKeepReview(flagged, NOW);
    expect(write.change).toBe('review_kept');
    expect(write.update).toEqual({ version: 4, updatedAt: NOW, review: deleteField() });
    expect(write.snapshot).toEqual({ ...raw, version: 4, updatedAt: NOW });
  });

  it('refuses when there is nothing to review', () => {
    expect(() => buildAcceptReview(raw, NOW)).toThrow();
    expect(() => buildKeepReview(raw, NOW)).toThrow();
  });
});

describe('buildCriteriaWrite', () => {
  it('builds version n and the pointer move', () => {
    const write = buildCriteriaWrite(CRITERIA_SEED_V1, 2, NOW);
    expect(write.versionId).toBe('v2');
    expect(write.versionDoc).toMatchObject({
      version: 2,
      createdAt: NOW,
      schemaVersion: 1,
      freshness_days: 14,
    });
    expect(write.pointerDoc).toEqual({ version: 2, updatedAt: NOW, schemaVersion: 1 });
    expect(JSON.stringify(write.versionDoc.excluded_titles)).not.toContain('undefined');
  });

  it('rejects invalid content before anything is written', () => {
    expect(() => buildCriteriaWrite({ ...CRITERIA_SEED_V1, freshness_days: 0 }, 2, NOW)).toThrow();
  });
});

describe('buildUploadRemoval', () => {
  const rawById = new Map<string, DocumentData>([
    ['a', { ...raw, version: 1 }],
    ['b', { ...raw, version: 1 }],
    ['c', flagged],
  ]);

  it('archives, drops reviews and marks the document in one batch', () => {
    const batches = buildUploadRemoval(
      { archive: ['a', 'b'], dropReviews: ['c'], skippedEdited: 0 },
      rawById,
      NOW,
    );
    expect(batches).toHaveLength(1);
    const [batch] = batches;
    expect(batch?.facts.map(({ factId, write }) => [factId, write.change, write.version])).toEqual([
      ['a', 'archive', 2],
      ['b', 'archive', 2],
      ['c', 'review_kept', 4],
    ]);
    expect(batch?.facts[0]?.write.update).toEqual({
      status: 'archived',
      version: 2,
      updatedAt: NOW,
    });
    expect(batch?.document).toEqual({ removedAt: NOW, updatedAt: NOW });
  });

  it('splits large removals and marks the document only in the last batch', () => {
    const batches = buildUploadRemoval(
      { archive: ['a', 'b'], dropReviews: ['c'], skippedEdited: 0 },
      rawById,
      NOW,
      2,
    );
    expect(batches.map((batch) => batch.facts.length)).toEqual([2, 1]);
    expect(batches[0]?.document).toBeUndefined();
    expect(batches[1]?.document).toBeDefined();
  });

  it('still marks the document when there is nothing to archive', () => {
    expect(
      buildUploadRemoval({ archive: [], dropReviews: [], skippedEdited: 2 }, rawById, NOW),
    ).toEqual([{ facts: [], document: { removedAt: NOW, updatedAt: NOW } }]);
  });

  it('refuses when a planned fact is not loaded', () => {
    expect(() =>
      buildUploadRemoval({ archive: ['zzz'], dropReviews: [], skippedEdited: 0 }, rawById, NOW),
    ).toThrow(/Reload/);
  });
});
