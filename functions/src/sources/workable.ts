import type { RawJob } from '@hireframe/shared';
import { z } from 'zod';

import { createAtsSource, keyedEnvelope, optionalText } from './ats.js';
import { parseDate, type Source, type WatchedCompany } from './types.js';

/**
 * Workable's documented public jobs endpoint (ADR-027):
 * `www.workable.com/api/accounts/{subdomain}?details=true`. It redirects to
 * `apply.workable.com/api/v1/widget/accounts/{subdomain}`; both hosts' robots.txt allow it.
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
  return `https://www.workable.com/api/accounts/${encodeURIComponent(subdomain)}?details=true`;
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

export function createWorkableSource(): Source {
  return createAtsSource({
    id: 'workable',
    boardUrl: (company) => workableBoardUrl(company.ats.token ?? ''),
    envelope: keyedEnvelope('jobs'),
    item: WorkableJobSchema,
    toRawJob: workableToRawJob,
  });
}
