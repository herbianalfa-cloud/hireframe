import {
  JOB_LIMITS,
  sourceRef,
  type Job,
  type JobDescription,
  type JobSourceRef,
  type NormalisedJob,
} from '@hireframe/shared';

/**
 * Attaching a board's posting to a job we already hold (ADR-049), pure: the posting's full text
 * becomes the job's description, its source and keys join the job's (so a later scan merges
 * instead of duplicating), and a missing posting date is filled. Used by the ATS hydrator in
 * scans and by Lookup. Limits are respected here, so a write can never push a job past
 * `JOB_LIMITS` and make it unreadable.
 */
export interface Attachment {
  description: JobDescription;
  addSources: JobSourceRef[];
  addKeys: string[];
  /** Set only when the job has no posting date and the posting has one. */
  postedAt?: Date;
}

export function planAttachment(
  job: Pick<Job, 'keys' | 'sources' | 'postedAt'>,
  posting: NormalisedJob,
  now: Date,
): Attachment {
  const hasSource = job.sources.some(
    (source) => source.id === posting.sourceId && source.externalId === posting.externalId,
  );
  const room = JOB_LIMITS.keys - job.keys.length;
  const known = new Set(job.keys);
  return {
    description: {
      text: posting.description.text,
      kind: 'full',
      sourceId: posting.sourceId,
      fetchedAt: now,
      schemaVersion: 1,
    },
    addSources:
      hasSource || job.sources.length >= JOB_LIMITS.sources ? [] : [sourceRef(posting, now)],
    addKeys: posting.keys.filter((key) => !known.has(key)).slice(0, Math.max(0, room)),
    ...(!job.postedAt && posting.postedAt ? { postedAt: posting.postedAt } : {}),
  };
}
