import type { RawJob } from '@hireframe/shared';
import { z } from 'zod';

import { boardReader, createAtsSource, keyedEnvelope, optionalText, type AtsSpec } from './ats.js';
import { parseDate, type Source, type WatchedCompany } from './types.js';

/**
 * Workable's public jobs widget (ADR-027). The documented URL,
 * `www.workable.com/api/accounts/{subdomain}?details=true`, redirects to
 * `apply.workable.com/api/v1/widget/accounts/{subdomain}`, which is called directly so the
 * client applies that host's robots.txt (allows all) and its 5 s spacing.
 */
export const WorkableJobSchema = z.object({
  title: z.string().min(1),
  shortcode: z.string().regex(/^[A-Za-z0-9]+$/),
  url: z.url(),
  telecommuting: z.boolean().nullish(),
  published_on: optionalText,
  created_at: optionalText,
  city: optionalText,
  state: optionalText,
  country: optionalText,
  locations: z
    .array(z.object({ city: optionalText, country: optionalText, hidden: z.boolean().nullish() }))
    .nullish(),
  description: optionalText,
});
export type WorkableJob = z.infer<typeof WorkableJobSchema>;

export function workableBoardUrl(subdomain: string): string {
  return `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(subdomain)}?details=true`;
}

export function workableToRawJob(job: WorkableJob, company: WatchedCompany): RawJob {
  const listed = (job.locations ?? [])
    .filter((location) => !location.hidden)
    .map((location) => [location.city, location.country].filter(Boolean).join(', '))
    .filter(Boolean);
  const locationText = listed.length
    ? listed.join('; ')
    : [job.city, job.state, job.country].filter(Boolean).join(', ');
  const postedAt = parseDate(job.published_on) ?? parseDate(job.created_at);
  return {
    sourceId: 'workable',
    externalId: job.shortcode,
    url: job.url,
    title: job.title,
    company: company.name,
    companyId: company.id,
    locationText,
    ...(job.telecommuting ? { remoteHint: 'remote' as const } : {}),
    description: { kind: 'full', format: 'html', body: job.description ?? '' },
    ...(postedAt ? { postedAt } : {}),
  };
}

const workableSpec: AtsSpec<WorkableJob> = {
  id: 'workable',
  boardUrl: (company) => workableBoardUrl(company.ats.token ?? ''),
  envelope: keyedEnvelope('jobs'),
  item: WorkableJobSchema,
  toRawJob: workableToRawJob,
};
export const workableBoard = boardReader(workableSpec);

export function createWorkableSource(): Source {
  return createAtsSource(workableSpec);
}
