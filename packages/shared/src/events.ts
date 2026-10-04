import { z } from 'zod';

import { VERDICTS } from './funnel.js';
import { CLIENT_JOB_STATUSES, JOB_STATUSES } from './jobs.js';

/**
 * `events/{eventId}`: append-only record of the owner's actions, so any metric can be recomputed
 * (PRD "Metrics", ADR-038). Created from the client in the same batch as the job change it
 * describes; never updated or deleted. Notes stay on the job, never in an event.
 */
const Base = { at: z.date(), schemaVersion: z.literal(1) };

export const EVENT_TYPES = ['job_status', 'job_feedback'] as const;
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
]);
export type AppEvent = z.infer<typeof EventSchema>;
