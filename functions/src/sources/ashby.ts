import type { RawJob, RemoteMode, Salary } from '@hireframe/shared';
import { z } from 'zod';

import { boardReader, createAtsSource, keyedEnvelope, optionalText, type AtsSpec } from './ats.js';
import { parseDate, type Source, type WatchedCompany } from './types.js';

/**
 * Ashby posting API (public):
 * `api.ashbyhq.com/posting-api/job-board/{token}?includeCompensation=true`.
 * Unlisted postings (`isListed: false`) are skipped.
 */
const PostalAddressSchema = z
  .object({
    postalAddress: z
      .object({ addressLocality: optionalText, addressCountry: optionalText })
      .nullish(),
  })
  .nullish();

const CompensationComponentSchema = z.object({
  compensationType: optionalText,
  interval: optionalText,
  currencyCode: optionalText,
  minValue: z.number().nullish(),
  maxValue: z.number().nullish(),
});

export const AshbyJobSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  location: optionalText,
  secondaryLocations: z.array(z.object({ location: optionalText })).nullish(),
  isListed: z.boolean().nullish(),
  isRemote: z.boolean().nullish(),
  workplaceType: optionalText,
  address: PostalAddressSchema,
  publishedAt: optionalText,
  jobUrl: z.url(),
  descriptionHtml: optionalText,
  descriptionPlain: optionalText,
  compensation: z
    .object({
      compensationTiers: z
        .array(z.object({ components: z.array(CompensationComponentSchema).nullish() }))
        .nullish(),
    })
    .nullish(),
});
export type AshbyJob = z.infer<typeof AshbyJobSchema>;

export function ashbyBoardUrl(token: string): string {
  return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}?includeCompensation=true`;
}

const WORKPLACE: Readonly<Record<string, RemoteMode>> = {
  Remote: 'remote',
  Hybrid: 'hybrid',
  OnSite: 'onsite',
};

function salaryOf(job: AshbyJob): Salary | undefined {
  const component = (job.compensation?.compensationTiers ?? [])
    .flatMap((tier) => tier.components ?? [])
    .find((part) => part.compensationType === 'Salary' && part.currencyCode);
  if (!component?.currencyCode || !/^[A-Z]{3}$/.test(component.currencyCode)) return undefined;
  const interval = component.interval ?? '';
  const period = interval.includes('YEAR')
    ? 'year'
    : interval.includes('MONTH')
      ? 'month'
      : interval.includes('HOUR')
        ? 'hour'
        : 'unknown';
  return {
    currency: component.currencyCode,
    period,
    ...(typeof component.minValue === 'number' ? { min: component.minValue } : {}),
    ...(typeof component.maxValue === 'number' ? { max: component.maxValue } : {}),
  };
}

export function ashbyToRawJob(job: AshbyJob, company: WatchedCompany): RawJob | null {
  if (job.isListed === false) return null;
  const country = job.address?.postalAddress?.addressCountry;
  const locations = [job.location, ...(job.secondaryLocations ?? []).map((l) => l.location)]
    .filter((value): value is string => Boolean(value))
    .join('; ');
  const remoteHint = job.isRemote ? 'remote' : WORKPLACE[job.workplaceType ?? ''];
  const postedAt = parseDate(job.publishedAt);
  const salary = salaryOf(job);
  return {
    sourceId: 'ashby',
    externalId: job.id,
    url: job.jobUrl,
    title: job.title,
    company: company.name,
    companyId: company.id,
    locationText: [locations, country].filter(Boolean).join(', '),
    ...(remoteHint ? { remoteHint } : {}),
    description: job.descriptionHtml
      ? { kind: 'full', format: 'html', body: job.descriptionHtml }
      : { kind: 'full', format: 'text', body: job.descriptionPlain ?? '' },
    ...(postedAt ? { postedAt } : {}),
    ...(salary ? { salary } : {}),
  };
}

const ashbySpec: AtsSpec<AshbyJob> = {
  id: 'ashby',
  boardUrl: (company) => ashbyBoardUrl(company.ats.token ?? ''),
  envelope: keyedEnvelope('jobs'),
  item: AshbyJobSchema,
  toRawJob: ashbyToRawJob,
};
export const ashbyBoard = boardReader(ashbySpec);

export function createAshbySource(): Source {
  return createAtsSource(ashbySpec);
}
