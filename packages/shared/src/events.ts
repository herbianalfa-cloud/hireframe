import { z } from 'zod';

import { APPLICATION_STAGES } from './applications.js';
import { VERDICTS } from './funnel.js';
import { CLIENT_JOB_STATUSES, JOB_STATUSES } from './jobs.js';

/**
 * `events/{eventId}`: append-only record of the owner's actions, so any metric can be recomputed
 * (PRD "Metrics", ADR-038). Created from the client in the same batch as the job change it
 * describes; never updated or deleted. Notes stay on the job, never in an event.
 */
const Base = { at: z.date(), schemaVersion: z.literal(1) };

export const EVENT_TYPES = [
  'job_status',
  'job_feedback',
  'job_feedback_removed',
  'application_stage',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('job_status'),
    jobId: z.string().min(1),
    from: z.enum(JOB_STATUSES),
    to: z.enum(CLIENT_JOB_STATUSES),
    /** The job's verdict at the time, when it had one. */
    verdict: z.enum(VERDICTS).exactOptional(),
    ...Base,
  }),
  z.object({
    type: z.literal('job_feedback'),
    jobId: z.string().min(1),
    agree: z.boolean(),
    verdict: z.enum(VERDICTS),
    expected: z.enum(VERDICTS).exactOptional(),
    ...Base,
  }),
  z.object({
    type: z.literal('job_feedback_removed'),
    jobId: z.string().min(1),
    /** The rating that was removed: its answer and the verdict it judged. */
    agree: z.boolean(),
    verdict: z.enum(VERDICTS),
    ...Base,
  }),
  /** An application changed stage (`from` is null when it started). Server-written only: the rules refuse a client create (M7). */
  z.object({
    type: z.literal('application_stage'),
    jobId: z.string().min(1),
    from: z.enum(APPLICATION_STAGES).nullable(),
    to: z.enum(APPLICATION_STAGES),
    ...Base,
  }),
]);
export type AppEvent = z.infer<typeof EventSchema>;
