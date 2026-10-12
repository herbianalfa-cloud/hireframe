import { z } from 'zod';

import { COLLECTIONS } from './firestore.js';
import type { QuerySpec } from './query-spec.js';

/**
 * The `getDigest` request and response (ADR-052, M7B). The Apps Script mailer posts
 * `{ kind, day }` signed with the `digest.v1.` purpose and sends whatever comes back. The server
 * reads Firestore and renders; it makes no model call.
 */

/** Limits both sides know. The request body is a few dozen bytes; the contract is generous. */
export const DIGEST_WIRE = {
  serverMaxBytes: 2_000,
} as const;

export const DIGEST_KINDS = ['morning', 'fallback'] as const;
export type DigestKind = (typeof DIGEST_KINDS)[number];

/**
 * ready: a morning run succeeded or was partial. failed: it failed or was killed. in_progress:
 * it is still running, or there is no run yet and it is early. missing: no morning run by 08:15.
 */
export const DIGEST_STATES = ['ready', 'failed', 'in_progress', 'missing'] as const;
export type DigestState = (typeof DIGEST_STATES)[number];

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const DigestRequestSchema = z.strictObject({
  kind: z.enum(DIGEST_KINDS),
  /** The London day the digest is for. A date that doesn't exist (2026-02-30) is refused. */
  day: z
    .string()
    .regex(DAY)
    .refine((day) => {
      const time = Date.parse(`${day}T00:00:00Z`);
      return !Number.isNaN(time) && new Date(time).toISOString().startsWith(day);
    }),
});
export type DigestRequest = z.infer<typeof DigestRequestSchema>;

export const DigestResponseSchema = z.strictObject({
  state: z.enum(DIGEST_STATES),
  subject: z.string().min(1).max(200),
  html: z.string().min(1).max(100_000),
  text: z.string().min(1).max(100_000),
});
export type DigestResponse = z.infer<typeof DigestResponseSchema>;

/** Error bodies carry a fixed code only, never detail (docs/SECURITY.md). */
export const DIGEST_ERROR_CODES = ['unauthorized', 'too_large', 'malformed', 'internal'] as const;
export type DigestErrorCode = (typeof DIGEST_ERROR_CODES)[number];

// ---- The digest's Firestore reads (query specs, checked against firestore.indexes.json) ----

/** Verdicts the digest lists, with the statuses that still count as open. */
export const DIGEST_VERDICTS = ['apply', 'near_miss', 'wildcard'] as const;
export type DigestVerdict = (typeof DIGEST_VERDICTS)[number];
export const DIGEST_OPEN_STATUSES = ['new', 'saved'] as const;

/** The newest runs, newest first (single-field index on `startedAt`). */
export const digestRunsSpec: QuerySpec = {
  collection: COLLECTIONS.runs,
  filters: [],
  orderBy: [{ field: 'startedAt', direction: 'desc' }],
};

/**
 * Open jobs of one verdict judged since `since`, newest judged first: the
 * `(verdict, status, judgedAt desc)` composite. Also the count behind "+n more".
 */
export function digestJobsSpec(verdict: DigestVerdict, since: Date): QuerySpec {
  return {
    collection: COLLECTIONS.jobs,
    filters: [
      { field: 'verdict', op: '==', value: verdict },
      { field: 'status', op: 'in', value: [...DIGEST_OPEN_STATUSES] },
      { field: 'judgedAt', op: '>=', value: since },
    ],
    orderBy: [{ field: 'judgedAt', direction: 'desc' }],
  };
}

/** Jobs S3 sent to wait for a description (equality only, merged single-field indexes). */
export const digestWaitingSpec: QuerySpec = {
  collection: COLLECTIONS.jobs,
  filters: [{ field: 'next', op: '==', value: 'description' }],
  orderBy: [],
};

/** Source health documents: a whole small collection, no filter and no order. */
export const digestSourcesSpec: QuerySpec = {
  collection: COLLECTIONS.sources,
  filters: [],
  orderBy: [],
};

// ---- The Pipeline line's reads (M7 7D.4) ----

/** Applications in one stage: equality only, so the single-field index serves it. */
export function digestStageSpec(stage: 'needs_input' | 'generating' | 'ready'): QuerySpec {
  return {
    collection: COLLECTIONS.applications,
    filters: [{ field: 'stage', op: '==', value: stage }],
    orderBy: [],
  };
}

/**
 * Jobs marked applied since the London week began: the `(status, appliedAt desc)` composite the
 * summary bar's count already uses.
 */
export function digestAppliedWeekSpec(weekStart: Date): QuerySpec {
  return {
    collection: COLLECTIONS.jobs,
    filters: [
      { field: 'status', op: '==', value: 'applied' },
      { field: 'appliedAt', op: '>=', value: weekStart },
    ],
    orderBy: [{ field: 'appliedAt', direction: 'desc' }],
  };
}
