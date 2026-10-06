import { z } from 'zod';

import { INGEST_WIRE } from './signing.js';

const Count = z.int().min(0);

export * from './signing.js';

/**
 * The `ingestEmailJobs` request and response (ADR-046). The script sends only what the parsers
 * read: no subject, and never To, Cc, Delivered-To or any other header.
 */
export const IngestMessageSchema = z.strictObject({
  /** Gmail's message ID. Hashed server-side; never stored or logged as is. */
  id: z.string().min(1).max(INGEST_WIRE.idChars),
  receivedAt: z.iso.datetime(),
  /** The raw `From` header: `Name <address>` or a bare address. */
  from: z.string().max(INGEST_WIRE.fromChars),
  text: z.string().max(INGEST_WIRE.textChars),
  html: z.string().max(INGEST_WIRE.htmlChars),
});
export type IngestMessage = z.infer<typeof IngestMessageSchema>;

export const IngestRequestSchema = z.strictObject({
  messages: z.array(IngestMessageSchema).min(1).max(INGEST_WIRE.messagesPerRequest),
});
export type IngestRequest = z.infer<typeof IngestRequestSchema>;

/**
 * What happened to one message. The script relabels a message `done` only for the first three:
 * `deferred` (over the daily cap or out of time) stays labelled for the next trigger.
 */
export const MESSAGE_STATUSES = ['processed', 'duplicate', 'unparsed', 'deferred'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/** Statuses after which the script may relabel the message. */
export const FINAL_MESSAGE_STATUSES: readonly MessageStatus[] = [
  'processed',
  'duplicate',
  'unparsed',
];

export const IngestResponseSchema = z.object({
  results: z
    .array(
      z.object({
        id: z.string().min(1).max(INGEST_WIRE.idChars),
        status: z.enum(MESSAGE_STATUSES),
      }),
    )
    .max(INGEST_WIRE.messagesPerRequest),
});
export type IngestResponse = z.infer<typeof IngestResponseSchema>;

/** Error bodies carry a fixed code only, never detail (docs/SECURITY.md). */
export const INGEST_ERROR_CODES = [
  'unauthorized',
  'too_large',
  'malformed',
  'busy',
  'method',
  'internal',
] as const;
export type IngestErrorCode = (typeof INGEST_ERROR_CODES)[number];

/**
 * `alertMessages/{sha256(gmail message id)}` (server-only, ADR-047): proof a message was handled,
 * so a retried one is a `duplicate`. Counts and the sender's domain only: no subject, address,
 * link or text. A TTL policy on `expireAt` deletes it after 30 days.
 */
export const AlertMessageSchema = z.object({
  sender: z.string().min(1).max(253),
  parser: z.enum(['deterministic', 'model']),
  jobs: Count,
  new: Count,
  merged: Count,
  duplicate: Count,
  unverifiedLinks: Count,
  status: z.enum(['processed', 'unparsed']),
  at: z.date(),
  expireAt: z.date(),
  schemaVersion: z.literal(1),
});
export type AlertMessage = z.infer<typeof AlertMessageSchema>;

/** `nonces/{nonce}` (server-only, ADR-046): a seen request nonce; TTL policy on `expireAt`. */
export const NonceSchema = z.object({ expireAt: z.date(), schemaVersion: z.literal(1) });
