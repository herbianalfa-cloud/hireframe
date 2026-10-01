import {
  CriteriaContentSchema,
  criteriaVersionId,
  type CriteriaContent,
  type FactChange,
} from '@hireframe/shared';
import { deleteField, type DocumentData, type FieldValue } from 'firebase/firestore';

/**
 * Pure builders for the client writes firestore.rules allow (ADR-018, ADR-019). They work on
 * the raw Firestore data (with its original Timestamps), because a version snapshot must equal
 * the fact exactly as the batch leaves it; converting to `Date` would lose precision.
 * tests/rules/ runs these builders against the real rules.
 */

/** Fact fields the owner may change. */
export const EDITABLE_FACT_FIELDS = [
  'type',
  'text',
  'evidence',
  'dates',
  'tags',
  'lanes',
  'status',
] as const;
export type EditableFactField = (typeof EDITABLE_FACT_FIELDS)[number];
export type FactPatch = Partial<Record<EditableFactField, unknown>>;

export interface FactWrite {
  /** The next version number; also the snapshot's document ID. */
  version: number;
  update: DocumentData;
  snapshot: DocumentData;
  change: Exclude<FactChange, 'created'>;
}

/** Firestore rejects `undefined`; criteria content is plain JSON, so a round trip drops it. */
function withoutUndefined<T extends DocumentData>(data: T): T {
  return JSON.parse(JSON.stringify(data)) as T;
}

/**
 * One versioned edit: bump the version, stamp `updatedAt` with the server time and build the
 * snapshot of the fact after the write. `clearReview` removes a pending proposed change.
 */
export function buildFactWrite(
  raw: DocumentData,
  patch: FactPatch,
  change: FactWrite['change'],
  serverNow: FieldValue,
  options: { clearReview?: boolean } = {},
): FactWrite {
  const version = Number(raw.version) + 1;
  const cleanPatch = Object.fromEntries(
    Object.entries(patch).filter(
      ([key, value]) =>
        (EDITABLE_FACT_FIELDS as readonly string[]).includes(key) && value !== undefined,
    ),
  );
  const update: DocumentData = {
    ...cleanPatch,
    version,
    updatedAt: serverNow,
    ...(options.clearReview ? { review: deleteField() } : {}),
  };
  const snapshot: DocumentData = { ...raw, ...cleanPatch, version, updatedAt: serverNow };
  if (options.clearReview) delete snapshot.review;
  return { version, update, snapshot, change };
}

/** Accept a proposed change: apply its content and clear the review. */
export function buildAcceptReview(raw: DocumentData, serverNow: FieldValue): FactWrite {
  const review = raw.review as { proposed?: DocumentData } | undefined;
  if (!review?.proposed) throw new Error('This fact has no proposed change.');
  const { type, text, evidence, dates, tags, lanes } = review.proposed;
  return buildFactWrite(
    raw,
    { type, text, evidence, dates, tags, lanes },
    'review_accepted',
    serverNow,
    {
      clearReview: true,
    },
  );
}

/** Keep the current fact: clear the review without changing the content. */
export function buildKeepReview(raw: DocumentData, serverNow: FieldValue): FactWrite {
  if (!raw.review) throw new Error('This fact has no proposed change.');
  return buildFactWrite(raw, {}, 'review_kept', serverNow, { clearReview: true });
}

export interface CriteriaWrite {
  versionId: string;
  versionDoc: DocumentData;
  pointerDoc: DocumentData;
}

/** Criteria version `nextVersion` plus the pointer move. Validates the content first. */
export function buildCriteriaWrite(
  content: CriteriaContent,
  nextVersion: number,
  serverNow: FieldValue,
): CriteriaWrite {
  const parsed = CriteriaContentSchema.parse(content);
  return {
    versionId: criteriaVersionId(nextVersion),
    versionDoc: {
      ...withoutUndefined(parsed),
      version: nextVersion,
      createdAt: serverNow,
      schemaVersion: 1,
    },
    pointerDoc: { version: nextVersion, updatedAt: serverNow, schemaVersion: 1 },
  };
}
