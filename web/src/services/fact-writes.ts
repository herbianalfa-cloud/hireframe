import {
  CriteriaContentSchema,
  criteriaVersionId,
  type CriteriaContent,
  type FactChange,
  type UploadRemovalPlan,
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
  'evidenceUrl',
  'dates',
  'tags',
  'lanes',
  'status',
] as const;
export type EditableFactField = (typeof EDITABLE_FACT_FIELDS)[number];
/** Editable fields a fact may lack. A `null` in a patch removes one; elsewhere it is ignored. */
const OPTIONAL_FACT_FIELDS: readonly string[] = ['evidenceUrl'];

/** `undefined` leaves a field alone; `null` removes an optional one. */
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
  const entries = Object.entries(patch).filter(
    ([key, value]) =>
      (EDITABLE_FACT_FIELDS as readonly string[]).includes(key) && value !== undefined,
  );
  const cleanPatch = Object.fromEntries(entries.filter(([, value]) => value !== null));
  const removed = entries
    .filter(([key, value]) => value === null && OPTIONAL_FACT_FIELDS.includes(key))
    .map(([key]) => key);
  if (options.clearReview) removed.push('review');
  const update: DocumentData = {
    ...cleanPatch,
    ...Object.fromEntries(removed.map((key) => [key, deleteField()])),
    version,
    updatedAt: serverNow,
  };
  const snapshot: DocumentData = Object.fromEntries(
    Object.entries({ ...raw, ...cleanPatch, version, updatedAt: serverNow }).filter(
      ([key]) => !removed.includes(key),
    ),
  );
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

/** Facts per removal batch: two writes each, so a batch stays under Firestore's 500 writes. */
export const REMOVAL_FACTS_PER_BATCH = 240;

export interface RemovalBatch {
  facts: { factId: string; write: FactWrite }[];
  /** The document update `{ removedAt, updatedAt }`; only on the last batch. */
  document?: DocumentData;
}

/**
 * "Remove upload" (ADR-023) as client batches: archive each untouched fact, drop each proposed
 * change from the upload ("keep current"), and mark the document removed in the last batch, so a
 * document is only marked once everything before it committed. `rawById` holds the facts as
 * stored, for exact snapshots.
 */
export function buildUploadRemoval(
  plan: UploadRemovalPlan,
  rawById: ReadonlyMap<string, DocumentData>,
  serverNow: FieldValue,
  factsPerBatch = REMOVAL_FACTS_PER_BATCH,
): RemovalBatch[] {
  const raw = (factId: string): DocumentData => {
    const found = rawById.get(factId);
    if (!found) throw new Error('A fact to remove is missing. Reload and try again.');
    return found;
  };
  const writes = [
    ...plan.archive.map((factId) => ({
      factId,
      write: buildFactWrite(raw(factId), { status: 'archived' }, 'archive', serverNow),
    })),
    ...plan.dropReviews.map((factId) => ({
      factId,
      write: buildKeepReview(raw(factId), serverNow),
    })),
  ];
  const batches: RemovalBatch[] = [];
  for (let start = 0; start < writes.length; start += factsPerBatch) {
    batches.push({ facts: writes.slice(start, start + factsPerBatch) });
  }
  const document = { removedAt: serverNow, updatedAt: serverNow };
  const last = batches.at(-1);
  if (last) last.document = document;
  else batches.push({ facts: [], document });
  return batches;
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
