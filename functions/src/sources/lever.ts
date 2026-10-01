import type { RawJob, RemoteMode, Salary } from '@hireframe/shared';
import { z } from 'zod';

import { arrayEnvelope, createAtsSource, optionalText } from './ats.js';
import { parseDate, type Source, type WatchedCompany } from './types.js';

/**
 * Lever postings API (public): `api.lever.co/v0/postings/{token}?mode=json`, or
 * `api.eu.lever.co` for EU-hosted boards. robots.txt asks for a 1 s crawl delay, which the
 * client honours.
 */
export const LeverPostingSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  hostedUrl: z.url(),
  createdAt: z.number().int().nullish(),
  categories: z
    .object({ location: optionalText, allLocations: z.array(z.string()).nullish() })
    .nullish(),
  description: optionalText,
  lists: z.array(z.object({ text: z.string(), content: z.string() })).nullish(),
  additional: optionalText,
  workplaceType: optionalText,
  country: optionalText,
  salaryRange: z
    .object({
      min: z.number().nullish(),
      max: z.number().nullish(),
      currency: optionalText,
      interval: optionalText,
    })
    .nullish(),
});
export type LeverPosting = z.infer<typeof LeverPostingSchema>;

export function leverBoardUrl(token: string, host?: 'eu'): string {
  const api = host === 'eu' ? 'api.eu.lever.co' : 'api.lever.co';
  return `https://${api}/v0/postings/${encodeURIComponent(token)}?mode=json`;
}

const WORKPLACE: Readonly<Record<string, RemoteMode>> = {
  remote: 'remote',
  hybrid: 'hybrid',
  onsite: 'onsite',
};

function salaryOf(range: LeverPosting['salaryRange']): Salary | undefined {
  if (!range?.currency || !/^[A-Z]{3}$/.test(range.currency)) return undefined;
  const period = range.interval?.includes('year')
    ? 'year'
    : range.interval?.includes('month')
      ? 'month'
      : range.interval?.includes('hour')
        ? 'hour'
        : 'unknown';
  return {
    currency: range.currency,
    period,
    ...(typeof range.min === 'number' && range.min >= 0 ? { min: range.min } : {}),
    ...(typeof range.max === 'number' && range.max >= 0 ? { max: range.max } : {}),
  };
}

export function leverToRawJob(posting: LeverPosting, company: WatchedCompany): RawJob {
  const locations = posting.categories?.allLocations?.length
    ? posting.categories.allLocations.join('; ')
    : (posting.categories?.location ?? '');
  const lists = (posting.lists ?? [])
    .map((list) => `<h3>${list.text}</h3><ul>${list.content}</ul>`)
    .join('');
  const remoteHint = WORKPLACE[posting.workplaceType ?? ''];
  const postedAt = parseDate(posting.createdAt);
  const salary = salaryOf(posting.salaryRange);
  return {
    sourceId: 'lever',
    externalId: posting.id,
    url: posting.hostedUrl,
    title: posting.text,
    company: company.name,
    companyId: company.id,
    locationText: [locations, posting.country].filter(Boolean).join(', '),
    ...(remoteHint ? { remoteHint } : {}),
    description: {
      kind: 'full',
      format: 'html',
      body: `${posting.description ?? ''}${lists}${posting.additional ?? ''}`,
    },
    ...(postedAt ? { postedAt } : {}),
    ...(salary ? { salary } : {}),
  };
}

export function createLeverSource(): Source {
  return createAtsSource({
    id: 'lever',
    boardUrl: (company) => leverBoardUrl(company.ats.token ?? '', company.ats.host),
    envelope: arrayEnvelope,
    item: LeverPostingSchema,
    toRawJob: leverToRawJob,
  });
}
