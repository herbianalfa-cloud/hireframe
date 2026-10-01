import { z } from 'zod';

/**
 * Profile brain (PRD R2, docs/ARCHITECTURE.md "Data model", ADR-018).
 * - `profile/main/facts/{factId}`: one atomic claim about the candidate, with the evidence it
 *   came from. Written by the `parseCv`/`addFact` callables; the owner edits it from the client.
 * - `profile/main/facts/{factId}/versions/{n}`: immutable snapshot of the fact at version `n`.
 * - `profile/main/documents/{docId}`: an uploaded CV and its parse status.
 *
 * Timestamps are `Date`s so the schemas stay SDK-agnostic; callers convert Firestore
 * `Timestamp`s before parsing. Limits here are mirrored in firestore.rules.
 */

export const FACT_TYPES = [
  'skill',
  'experience',
  'achievement',
  'metric',
  'education',
  'project',
  'constraint',
  'preference',
] as const;
export const LANES = ['primary', 'secondary', 'opportunistic', 'wildcard'] as const;
export const FACT_STATUSES = ['active', 'archived'] as const;
export const FACT_SOURCES = ['cv', 'manual'] as const;

/** Why a version exists. `created` is server-only; the rest are the client edits rules allow. */
export const FACT_CHANGES = [
  'created',
  'edit',
  'archive',
  'unarchive',
  'review_accepted',
  'review_kept',
] as const;
export type FactChange = (typeof FACT_CHANGES)[number];

export const FACT_LIMITS = {
  /** Stored fact text (owner edits may run longer than a model draft). */
  text: 500,
  /** Model drafts: short, because each draft is one claim. */
  draftText: 300,
  evidence: 1000,
  evidenceUrl: 500,
  tags: 20,
  tag: 40,
  /** One parse writes each fact plus its v1 snapshot, so 200 facts stay under 500 batch writes. */
  factsPerCv: 200,
  factsPerAdd: 5,
  addFactInput: 2000,
} as const;

/** `YYYY` or `YYYY-MM`. */
const PartialDateSchema = z.string().regex(/^\d{4}(-(0[1-9]|1[0-2]))?$/);

export const FactDatesSchema = z.object({
  start: PartialDateSchema.exactOptional(),
  end: z.union([PartialDateSchema, z.literal('present')]).exactOptional(),
});

/** The editable content of a fact: what a model drafts and what the owner edits. */
export const FactContentSchema = z.object({
  type: z.enum(FACT_TYPES),
  text: z.string().trim().min(1).max(FACT_LIMITS.text),
  evidence: z.string().trim().min(1).max(FACT_LIMITS.evidence),
  dates: FactDatesSchema,
  tags: z.array(z.string().trim().min(1).max(FACT_LIMITS.tag)).max(FACT_LIMITS.tags),
  lanes: z.array(z.enum(LANES)).max(LANES.length),
});
export type FactContent = z.infer<typeof FactContentSchema>;

/** One fact as drafted by the model (parseCv / addFact output). */
export const FactDraftSchema = FactContentSchema.extend({
  text: z.string().trim().min(1).max(FACT_LIMITS.draftText),
});
export type FactDraft = z.infer<typeof FactDraftSchema>;

/** A proposed change from a CV re-upload. Only the server sets it; the owner accepts or keeps. */
export const FactReviewSchema = z.object({
  kind: z.literal('changed'),
  proposed: FactContentSchema,
  docId: z.string().min(1),
  at: z.date(),
});
export type FactReview = z.infer<typeof FactReviewSchema>;

/**
 * A link to outside evidence (a portfolio page, a certificate). Owner-set only (ADR-024): it is
 * not part of FactContent, so a model drafting from CV or note text can never set one.
 */
export const EvidenceUrlSchema = z
  .url({ protocol: /^https$/ })
  .max(FACT_LIMITS.evidenceUrl)
  .regex(/^https:\/\/\S+$/);

export const FactSchema = FactContentSchema.extend({
  source: z.enum(FACT_SOURCES),
  sourceDocId: z.string().min(1).exactOptional(),
  status: z.enum(FACT_STATUSES),
  version: z.int().min(1),
  review: FactReviewSchema.exactOptional(),
  /** False when `evidence` is not a verbatim quote of the source text (shown in the UI). */
  evidenceVerified: z.boolean(),
  evidenceUrl: EvidenceUrlSchema.exactOptional(),
  createdAt: z.date(),
  updatedAt: z.date(),
  schemaVersion: z.literal(1),
});
export type Fact = z.infer<typeof FactSchema>;

export const FactVersionSchema = z.object({
  /** The fact document exactly as it was at this version. */
  snapshot: FactSchema,
  change: z.enum(FACT_CHANGES),
  at: z.date(),
});
export type FactVersion = z.infer<typeof FactVersionSchema>;

export const CV_KINDS = ['pdf', 'docx'] as const;
export type CvKind = (typeof CV_KINDS)[number];

export const CV_MIME_TYPES: Readonly<Record<CvKind, string>> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** Largest CV upload, enforced by storage.rules and re-checked by parseCv. */
export const MAX_CV_BYTES = 5 * 1024 * 1024;

export const ParseSummarySchema = z.object({
  factsExtracted: z.int().min(0),
  added: z.int().min(0),
  unchanged: z.int().min(0),
  flagged: z.int().min(0),
  skippedArchived: z.int().min(0),
  duplicatesInCv: z.int().min(0),
  unverified: z.int().min(0),
  /** Active CV facts that the new CV no longer mentions. Counted only, never archived. */
  missingFromCv: z.int().min(0),
});
export type ParseSummary = z.infer<typeof ParseSummarySchema>;

export const PARSE_ERROR_CODES = [
  'file_missing',
  'file_too_large',
  'file_type',
  'no_text',
  'spend_cap',
  'model_failed',
  'internal',
] as const;
export type ParseErrorCode = (typeof PARSE_ERROR_CODES)[number];

/** Firestore auto-IDs: 20 alphanumeric characters. Also enforced by storage.rules. */
export const DOC_ID_PATTERN = /^[A-Za-z0-9]{20}$/;

/** Lower-case hex SHA-256 of an uploaded file. */
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const ProfileDocumentSchema = z.object({
  kind: z.enum(CV_KINDS),
  storagePath: z.string().min(1),
  status: z.enum(['parsing', 'parsed', 'failed']),
  /** Set by parseCv from the uploaded bytes (ADR-022). Missing on uploads before v0.2.2. */
  sha256: z.string().regex(SHA256_PATTERN).exactOptional(),
  errorCode: z.enum(PARSE_ERROR_CODES).exactOptional(),
  summary: ParseSummarySchema.exactOptional(),
  /**
   * The earlier parsed upload with the same bytes. Set instead of `summary`: the file was not
   * read again and no fact changed (ADR-022).
   */
  duplicateOf: z.string().regex(DOC_ID_PATTERN).exactOptional(),
  model: z.string().min(1).exactOptional(),
  promptVersion: z.string().min(1).exactOptional(),
  costPence: z.number().min(0).exactOptional(),
  createdAt: z.date(),
  updatedAt: z.date(),
  schemaVersion: z.literal(1),
});
export type ProfileDocument = z.infer<typeof ProfileDocumentSchema>;

/**
 * A document still `parsing` this long after its last update was abandoned (the callable timed
 * out or crashed): parseCv may start it again, and the Profile screen shows it as timed out.
 * Longer than the parseCv callable timeout (CALLABLE_TIMEOUT_SECONDS).
 */
export const STALE_PARSE_MS = 15 * 60 * 1000;

export function isParseStalled(document: ProfileDocument, now: Date): boolean {
  return (
    document.status === 'parsing' && now.getTime() - document.updatedAt.getTime() >= STALE_PARSE_MS
  );
}

export const ParseCvInputSchema = z.object({
  docId: z.string().regex(DOC_ID_PATTERN),
});
export type ParseCvInput = z.infer<typeof ParseCvInputSchema>;

export const ParseCvResultSchema = z.object({
  docId: z.string(),
  summary: ParseSummarySchema,
  /** Same file as this earlier upload: nothing was read and the summary is all zeros. */
  duplicateOf: z.string().exactOptional(),
});
export type ParseCvResult = z.infer<typeof ParseCvResultSchema>;

export const AddFactInputSchema = z.object({
  text: z.string().trim().min(1).max(FACT_LIMITS.addFactInput),
});
export type AddFactInput = z.infer<typeof AddFactInputSchema>;

export const AddFactResultSchema = z.object({
  added: z.array(z.string()),
  skippedDuplicates: z.int().min(0),
});
export type AddFactResult = z.infer<typeof AddFactResultSchema>;

/** Model output for parseCv. */
export const CvExtractionSchema = z.object({
  facts: z.array(FactDraftSchema).max(FACT_LIMITS.factsPerCv),
});
export type CvExtraction = z.infer<typeof CvExtractionSchema>;

/** Model output for addFact. */
export const AddFactExtractionSchema = z.object({
  facts: z.array(FactDraftSchema).min(1).max(FACT_LIMITS.factsPerAdd),
});
export type AddFactExtraction = z.infer<typeof AddFactExtractionSchema>;
