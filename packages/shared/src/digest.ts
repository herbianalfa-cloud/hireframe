import { z } from 'zod';

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
    .refine((day) => new Date(`${day}T00:00:00Z`).toISOString().startsWith(day)),
});
export type DigestRequest = z.infer<typeof DigestRequestSchema>;

export const DigestResponseSchema = z.strictObject({
  state: z.enum(DIGEST_STATES),
  subject: z.string().min(1).max(200),
  html: z.string().min(1).max(200_000),
  text: z.string().min(1).max(100_000),
});
export type DigestResponse = z.infer<typeof DigestResponseSchema>;

/** Error bodies carry a fixed code only, never detail (docs/SECURITY.md). */
export const DIGEST_ERROR_CODES = ['unauthorized', 'too_large', 'malformed', 'internal'] as const;
export type DigestErrorCode = (typeof DIGEST_ERROR_CODES)[number];
