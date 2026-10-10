import {
  CriteriaContentSchema,
  CvHeaderSchema,
  criteriaVersionId,
  ProfileSettingsSchema,
  type CriteriaContent,
  type FactChange,
  type UploadRemovalPlan,
  type WorkRightsSetting,
} from '@hireframe/shared';
import { deleteField, type DocumentData, type FieldValue } from 'firebase/firestore';

/**
 * Pure builders for the client writes firestore.rules allow (ADR-018, ADR-019, ADR-033). They work on
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

/**
 * The owner's work-rights setting on `profile/main` (ADR-033), written with `setDoc(…, { merge:
 * true })`: `createdAt` only when the document is new, and `validUntil` removed when cleared.
 */
export function buildWorkRightsWrite(
  setting: WorkRightsSetting,
  exists: boolean,
  serverNow: FieldValue,
): DocumentData {
  const parsed = ProfileSettingsSchema.pick({ workRights: true, validUntil: true }).parse(setting);
  return {
    workRights: parsed.workRights,
    validUntil: parsed.validUntil ?? deleteField(),
    ...(exists ? {} : { createdAt: serverNow }),
    updatedAt: serverNow,
    schemaVersion: 1,
  };
}

// ---- The CV header (M7, `profile/cvHeader`) ----

/** What the form holds: every field as typed, with the three link slots always present. */
export interface CvHeaderValues {
  name: string;
  email: string;
  phone: string;
  location: string;
  links: readonly [string, string, string];
}

/** A checked header, with a blank optional field left out (the rules refuse `''`). */
export interface CvHeaderInput {
  name: string;
  email: string;
  phone?: string;
  location?: string;
  links?: string[];
}

/** Field keys an error can attach to: the four fields and the link slots `link0`..`link2`. */
export type CvHeaderErrors = Partial<
  Record<'name' | 'email' | 'phone' | 'location' | 'link0' | 'link1' | 'link2', string>
>;

const CV_HEADER_MESSAGES = {
  name: 'Enter your name (up to 80 characters).',
  email: 'Enter a valid email address (up to 120 characters).',
  phone: 'Up to 40 characters.',
  location: 'Up to 80 characters.',
  link: 'Use a full https:// link with no spaces (up to 200 characters).',
} as const;

// The schema needs dates; the server's time replaces both when the write is built.
const PLACEHOLDER_DATE = new Date(0);

/**
 * Checks the form against `CvHeaderSchema` before anything is written: the rules' email pattern
 * is looser than zod's, and the worker's `hasCvHeader` parses with the schema, so a header the
 * rules accept but the schema refuses would block every application.
 */
export function checkCvHeader(
  values: CvHeaderValues,
): { ok: true; input: CvHeaderInput } | { ok: false; errors: CvHeaderErrors } {
  const trimmed = (text: string) => text.trim();
  const links = values.links.map(trimmed).filter((link) => link !== '');
  const candidate = {
    name: trimmed(values.name),
    email: trimmed(values.email),
    ...(trimmed(values.phone) ? { phone: trimmed(values.phone) } : {}),
    ...(trimmed(values.location) ? { location: trimmed(values.location) } : {}),
    ...(links.length > 0 ? { links } : {}),
  };
  const parsed = CvHeaderSchema.safeParse({
    ...candidate,
    createdAt: PLACEHOLDER_DATE,
    updatedAt: PLACEHOLDER_DATE,
    schemaVersion: 1,
  });
  if (parsed.success) return { ok: true, input: candidate };

  const errors: CvHeaderErrors = {};
  const slots = values.links.flatMap((link, slot) => (trimmed(link) === '' ? [] : [slot]));
  for (const issue of parsed.error.issues) {
    const [field, index] = issue.path;
    if (field === 'name' || field === 'email' || field === 'phone' || field === 'location') {
      errors[field] ??= CV_HEADER_MESSAGES[field];
    } else if (field === 'links') {
      // An index points into the filtered list; map it back to the slot the owner typed in.
      const slot = typeof index === 'number' ? slots[index] : undefined;
      const key = slot === 0 ? 'link0' : slot === 1 ? 'link1' : 'link2';
      errors[key] ??= CV_HEADER_MESSAGES.link;
    }
  }
  return { ok: false, errors };
}

/**
 * The whole `profile/cvHeader` document, written with `setDoc` (no merge), so a field left
 * empty is absent. On create `createdAt` is the server time; on update it is the stored value
 * exactly (the rules require it unchanged), which is why the caller passes it back as read.
 */
export function buildCvHeaderWrite(
  values: CvHeaderValues,
  storedCreatedAt: unknown,
  serverNow: FieldValue,
): DocumentData {
  const checked = checkCvHeader(values);
  if (!checked.ok) throw new Error('CV header failed validation');
  const { input } = checked;
  return {
    name: input.name,
    email: input.email,
    ...(input.phone ? { phone: input.phone } : {}),
    ...(input.location ? { location: input.location } : {}),
    ...(input.links ? { links: input.links } : {}),
    createdAt: storedCreatedAt ?? serverNow,
    updatedAt: serverNow,
    schemaVersion: 1,
  };
}
